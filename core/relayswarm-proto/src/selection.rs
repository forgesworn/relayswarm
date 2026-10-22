//! Peer choice and timing projections, ported from
//! `src/browser/peer-selection.mjs`. Recent observations only: completion
//! times and payload rates, not network RTT or ABR estimates. Arithmetic is
//! IEEE double, step for step as the JavaScript computes it.

use std::collections::{HashMap, VecDeque};

const RECENT_COMPLETIONS: usize = 16;
const MIN_RATE_BYTES: f64 = 32.0 * 1024.0;
const MIN_RATE_FLOW_MS: f64 = 300.0;

fn quantile(values: impl Iterator<Item = f64>, fraction: f64) -> Option<f64> {
    let mut sorted: Vec<f64> = values.collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(|a, b| a.total_cmp(b));
    let index = ((sorted.len() as f64 * fraction).floor() as usize).min(sorted.len() - 1);
    Some(sorted[index])
}

fn push_bounded<T>(queue: &mut VecDeque<T>, value: T) {
    queue.push_back(value);
    if queue.len() > RECENT_COMPLETIONS {
        queue.pop_front();
    }
}

/// JavaScript truthiness of a number.
fn truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// Per-link history; links are identified by the caller's handle, and a
/// reconnected peer starts afresh.
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub attempts: u32,
    pub latency_ms: Option<f64>,
    pub throughput_bytes_per_second: Option<f64>,
    pub failure_rate: f64,
    pub consecutive_failures: u32,
    pub last_selected: u64,
}

impl Default for Observation {
    fn default() -> Self {
        Observation {
            attempts: 0,
            latency_ms: None,
            throughput_bytes_per_second: None,
            failure_rate: 0.0,
            consecutive_failures: 0,
            last_selected: 0,
        }
    }
}

/// What selection needs to know about one link at the moment of choice.
#[derive(Clone, Copy, Debug)]
pub struct LinkView<'a> {
    pub id: u64,
    pub pubkey: &'a str,
    pub closed: bool,
    pub busy: bool,
    /// The link advertises the requested key.
    pub has_key: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PeerSelection {
    observations: HashMap<u64, Observation>,
    turn: u32,
    order: u64,
    /// Sizes and payload rates of recent completed transfers on any link.
    recent_completions: VecDeque<(f64, f64)>,
    /// Time to first byte from any attempt that received data.
    recent_first_bytes: VecDeque<f64>,
    /// Payload rate after first byte and the flow's duration.
    recent_rates: VecDeque<(f64, f64)>,
    last_observed_at: u64,
}

impl PeerSelection {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn turn(&self) -> u32 {
        self.turn
    }
    pub fn order(&self) -> u64 {
        self.order
    }
    /// When the latest rate evidence arrived, 0 before any.
    pub fn last_observed_at(&self) -> u64 {
        self.last_observed_at
    }

    /// One attempt's timing: first byte (ms), then a rate as bytes over ms
    /// from the latest part of its flow, and how long the whole flow ran.
    /// `total_flow_ms` defaults to `flow_ms`.
    pub fn observe(&mut self, now: u64, first_byte_ms: Option<f64>, bytes: f64, flow_ms: f64, total_flow_ms: Option<f64>) {
        if let Some(first_byte) = first_byte_ms.filter(|value| value.is_finite() && *value >= 0.0) {
            push_bounded(&mut self.recent_first_bytes, first_byte.min(60_000.0));
        }
        // A short flow mostly measures the first round trip, not the path.
        if bytes >= MIN_RATE_BYTES && flow_ms >= MIN_RATE_FLOW_MS {
            let total = total_flow_ms.unwrap_or(flow_ms);
            let total = if truthy(total) { total } else { 0.0 };
            push_bounded(&mut self.recent_rates, ((bytes / flow_ms).min(1_000_000.0), flow_ms.max(total)));
            self.last_observed_at = now;
        }
    }

    /// Median recent time to first byte.
    pub fn first_byte_ms(&self) -> Option<f64> {
        quantile(self.recent_first_bytes.iter().copied(), 0.5)
    }

    /// Upper-quartile recent payload rate after first byte (bytes per ms).
    /// Flows of at least three first-byte times decide when there are two.
    pub fn rate(&self) -> Option<f64> {
        let long: Vec<f64> = match self.first_byte_ms() {
            Some(first_byte) => self
                .recent_rates
                .iter()
                .filter(|(_, flow)| *flow >= first_byte * 3.0)
                .map(|(rate, _)| *rate)
                .collect(),
            None => Vec::new(),
        };
        if long.len() >= 2 {
            quantile(long.into_iter(), 0.75)
        } else {
            quantile(self.recent_rates.iter().map(|(rate, _)| *rate), 0.75)
        }
    }

    /// Projected time for a whole transfer of this size, first byte included.
    pub fn project_ms(&self, size: f64) -> Option<f64> {
        if !truthy(size) {
            return None;
        }
        let projected = match (self.first_byte_ms(), self.rate()) {
            (Some(first_byte), Some(rate)) if truthy(rate) => first_byte + size / rate,
            _ => 0.0,
        };
        [self.minimum_ms(size), projected]
            .into_iter()
            .filter(|value| truthy(*value))
            .reduce(f64::min)
    }

    /// Time the fastest recent completion at least this large would need for
    /// this size; 0 without one.
    pub fn minimum_ms(&self, size: f64) -> f64 {
        if !truthy(size) {
            return 0.0;
        }
        let mut fastest = 0.0;
        for (bytes, rate) in &self.recent_completions {
            if *bytes >= size && *rate > fastest {
                fastest = *rate;
            }
        }
        if truthy(fastest) {
            size / fastest
        } else {
            0.0
        }
    }

    pub fn summary(&self, link: u64) -> Observation {
        self.observations.get(&link).cloned().unwrap_or_default()
    }

    pub fn estimate(&self, link: u64, size: f64) -> Option<f64> {
        let value = self.summary(link);
        let latency = value.latency_ms?;
        let transfer = match value.throughput_bytes_per_second {
            Some(throughput) if truthy(size) && truthy(throughput) => size * 1000.0 / throughput,
            _ => 0.0,
        };
        Some(latency.max(transfer))
    }

    /// Choose a link for this key, or `None`. One in four choices explores an
    /// unmeasured eligible link.
    pub fn select(&mut self, links: &[LinkView], tried: &[&str], size: f64, deadline_ms: f64) -> Option<u64> {
        let eligible: Vec<&LinkView> = links
            .iter()
            .filter(|link| {
                !link.closed
                    && !link.busy
                    && !tried.contains(&link.pubkey)
                    && link.has_key
                    && self
                        .estimate(link.id, size)
                        .is_none_or(|estimate| estimate * 1.25 + 25.0 <= deadline_ms)
            })
            .collect();
        if eligible.is_empty() {
            return None;
        }
        let attempts = |link: &&LinkView| self.observations.get(&link.id).map_or(0, |value| value.attempts);
        let cold: Vec<&LinkView> = eligible.iter().copied().filter(|link| attempts(link) == 0).collect();
        let measured: Vec<&LinkView> = eligible.iter().copied().filter(|link| attempts(link) > 0).collect();
        let healthy: Vec<&LinkView> = measured
            .iter()
            .copied()
            .filter(|link| self.summary(link.id).consecutive_failures == 0)
            .collect();
        let explore = !cold.is_empty() && (healthy.is_empty() || self.turn == 0 && deadline_ms >= 100.0);
        self.turn = (self.turn + 1) % 4;
        let candidates = if explore {
            cold
        } else if !healthy.is_empty() {
            healthy
        } else {
            measured
        };
        let score = |link: &LinkView| {
            let value = self.summary(link.id);
            if explore {
                value.last_selected as f64
            } else {
                self.estimate(link.id, size).unwrap_or(1000.0) * (1.0 + value.failure_rate * 4.0)
            }
        };
        let mut best = candidates[0];
        for link in &candidates[1..] {
            if score(link) < score(best) {
                best = link;
            }
        }
        self.order += 1;
        let mut value = self.summary(best.id);
        value.last_selected = self.order;
        self.observations.insert(best.id, value);
        Some(best.id)
    }

    /// One attempt on `link`: `bytes` delivered (0 for a failure).
    pub fn record(&mut self, now: u64, link: u64, elapsed_ms: f64, bytes: f64) {
        let mut value = self.summary(link);
        let blend = |previous: Option<f64>, next: f64| previous.map_or(next, |previous| previous * 0.75 + next * 0.25);
        let elapsed = elapsed_ms.clamp(1.0, 60_000.0);
        let delivered = truthy(bytes);
        value.attempts = (value.attempts + 1).min(32);
        value.failure_rate = value.failure_rate * 0.75 + if delivered { 0.0 } else { 0.25 };
        value.consecutive_failures = if delivered { 0 } else { (value.consecutive_failures + 1).min(32) };
        if delivered {
            value.latency_ms = Some(blend(value.latency_ms, elapsed));
            value.throughput_bytes_per_second = Some(blend(
                value.throughput_bytes_per_second,
                (bytes * 1000.0 / elapsed).min(1_000_000_000.0),
            ));
            push_bounded(&mut self.recent_completions, (bytes, (bytes / elapsed).min(1_000_000.0)));
            self.last_observed_at = now;
        }
        self.observations.insert(link, value);
    }

    /// Drop a closed link's history.
    pub fn forget(&mut self, link: u64) {
        self.observations.remove(&link);
    }
}
