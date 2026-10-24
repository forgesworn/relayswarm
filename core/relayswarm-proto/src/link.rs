//! One data channel between two viewers and the small protocol on it, ported
//! from `src/browser/peer-link.mjs` as a state machine with no I/O.
//!
//! Text frames are JSON control messages; binary frames are chunks of one
//! response. Framing 2 adds a piece range to `want` and `meta`
//! (`"p":[start,end]`, end exclusive) for schema 3 multi-holder transfer.
//! The requester sends one only to a holder that advertised framing 2. Responses on a link are serialised, so the chunks between a
//! `meta` and its `eof` belong to that one response. Integrity is decided by
//! the caller, which hashes what arrives.
//!
//! The shell feeds inputs with the current time in milliseconds, drains
//! [`LinkEvent`]s, and calls [`Link::tick`] at [`Link::next_deadline`]. It
//! sends what `SendText`/`SendBinary` carry, answers `ServeRequest` with
//! [`Link::serve_response`], and reports the channel draining with
//! [`Link::buffered_amount_low`].

use std::collections::VecDeque;

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

use crate::js;
use crate::pieces::{range_bytes, PieceRange, MAX_PIECES};

pub const CHUNK_BYTES: usize = 16 * 1024;
/// A response is handed to the channel only while at most this much is queued.
pub const HIGH_WATER_BYTES: u64 = 128 * 1024;
/// The shell's `bufferedAmountLowThreshold`.
pub const LOW_WATER_BYTES: u64 = 32 * 1024;
pub const MAX_HAVE_KEYS: usize = 256;
const MAX_CONTROL_UNITS: usize = 64 * 1024;
const MAX_RENDITION_UNITS: usize = 2048;
const MAX_RENDITIONS: usize = 8;
const RENDITION_STALE_MS: u64 = 30_000;
const MAX_FETCHING: usize = 24;
const MAX_FETCHING_MS: i64 = 2000;

pub const CLOSE_REASONS: [&str; 17] = [
    "host",
    "host-stop",
    "admission",
    "rotation",
    "integrity",
    "request-timeout",
    "request-abort",
    "native-failed",
    "native-closed",
    "native-disconnected",
    "channel-close",
    "channel-error",
    "protocol",
    "send-error",
    "serve-error",
    "upload-queue",
    "upload-drain-timeout",
];

fn close_reason(reason: &str) -> &'static str {
    CLOSE_REASONS.iter().copied().find(|known| *known == reason).unwrap_or("host")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Payload,
    None,
    Timeout,
    Abort,
    Abandoned,
    Closed,
    Busy,
    SendError,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Payload => "payload",
            Outcome::None => "none",
            Outcome::Timeout => "timeout",
            Outcome::Abort => "abort",
            Outcome::Abandoned => "abandoned",
            Outcome::Closed => "closed",
            Outcome::Busy => "busy",
            Outcome::SendError => "send-error",
        }
    }
}

/// The logical result of one request, reported once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestReport {
    pub id: Option<u64>,
    pub outcome: Outcome,
    pub received_bytes: u64,
    pub metadata_received: bool,
    pub draining: bool,
    pub close_reason: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkEvent {
    SendText(String),
    SendBinary(Vec<u8>),
    /// The link closed; the shell closes the channel and connection.
    Closed(&'static str),
    Report(RequestReport),
    /// The request's bytes, or `None`. Resolved once, possibly before the
    /// link finishes draining the response.
    Resolved {
        id: Option<u64>,
        bytes: Option<Vec<u8>>,
    },
    HaveChanged(Vec<String>),
    ScheduleChanged,
    /// The remote wants this key; answer with [`Link::serve_response`].
    ServeRequest(String),
    /// Framing 2: the remote wants pieces of this key. Answer with the whole
    /// held object; the link sends only the range. The shell charges the
    /// range's bytes against upload allowances.
    ServeRange {
        key: String,
        range: PieceRange,
    },
    UploadCancelled(u64),
    Progress {
        received: u64,
        size: u64,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct LinkConfig {
    pub max_segment_bytes: u64,
    pub max_queued_requests: usize,
    pub drain_timeout_ms: u64,
    /// Ordered, fully reliable channel: an abandoned response may be drained.
    pub reliable: bool,
}

#[derive(Debug)]
struct Pending {
    id: u64,
    expected: Option<u64>,
    /// Framing 2: the requested pieces, echoed by the holder's `meta`.
    range: Option<PieceRange>,
    size: Option<u64>,
    parts: Vec<u8>,
    chunks: u64,
    received: u64,
    draining: bool,
    cancelled: bool,
    resolved: bool,
    reported: bool,
    /// Close reason if the drain deadline passes.
    abandon_reason: &'static str,
    deadline: u64,
    timer: u64,
}

#[derive(Clone, Debug)]
struct Upload {
    id: f64,
    key: String,
    cancelled: bool,
    range: Option<PieceRange>,
}

#[derive(Debug)]
enum Stage {
    AwaitingBytes,
    Draining {
        bytes: Vec<u8>,
        sent: usize,
        deadline: u64,
        timer: u64,
    },
}

#[derive(Debug)]
struct Active {
    upload: Upload,
    stage: Stage,
}

#[derive(Debug)]
pub struct Link {
    config: LinkConfig,
    max_chunks: u64,
    closed: bool,
    close_reason: Option<&'static str>,
    have: IndexSet<String>,
    serving: bool,
    rendition: Option<String>,
    contribution_at: u64,
    fetching: IndexMap<String, u64>,
    renditions: IndexMap<String, u64>,
    pending: Option<Pending>,
    next_id: u64,
    queue: VecDeque<Upload>,
    active: Option<Active>,
    in_flight: usize,
    buffered: u64,
    timers: u64,
    opened_at: u64,
    last_served_at: u64,
    last_delivered_at: u64,
    bytes_in: u64,
    bytes_out: u64,
    /// The latest time an input carried.
    clock: u64,
    events: Vec<LinkEvent>,
    /// The shell's channel is open; a closed or closing channel sends
    /// nothing and cannot drain an abandoned response.
    channel_open: bool,
    /// Bumped whenever have, fetching, renditions, contribution or closed
    /// may have changed, so a shell mirrors them only when needed.
    version: u64,
}

fn is_hex64(value: &Value) -> bool {
    value.as_str().is_some_and(js::is_hex64)
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn valid_keys(list: Option<&Value>) -> Vec<String> {
    list.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|key| is_hex64(key))
                .take(MAX_HAVE_KEYS)
                .filter_map(|key| key.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// A framing 2 piece range: `Some(None)` when absent, `Some(Some(range))`
/// for two safe integers `0 <= start < end <= 64`, `None` when malformed.
fn parse_range(value: Option<&Value>) -> Option<Option<PieceRange>> {
    let Some(value) = value else { return Some(None) };
    let [start, end] = value.as_array()?.as_slice() else { return None };
    let start = u32::try_from(js::safe_integer(start)?).ok()?;
    let end = u32::try_from(js::safe_integer(end)?).ok()?;
    (start < end && end <= MAX_PIECES).then_some(Some(PieceRange { start, end }))
}

fn same_number(value: Option<&Value>, number: f64) -> bool {
    value.and_then(Value::as_f64) == Some(number)
}

impl Link {
    pub fn new(config: LinkConfig, now: u64) -> Self {
        let max_chunks = (config.max_segment_bytes.div_ceil(CHUNK_BYTES as u64) * 4).max(1);
        Link {
            config,
            max_chunks,
            closed: false,
            close_reason: None,
            have: IndexSet::new(),
            serving: false,
            rendition: None,
            contribution_at: 0,
            fetching: IndexMap::new(),
            renditions: IndexMap::new(),
            pending: None,
            next_id: 1,
            queue: VecDeque::new(),
            active: None,
            in_flight: 0,
            buffered: 0,
            timers: 0,
            opened_at: now,
            last_served_at: 0,
            last_delivered_at: 0,
            bytes_in: 0,
            bytes_out: 0,
            clock: now,
            events: Vec::new(),
            channel_open: true,
            version: 0,
        }
    }

    /// Take the events produced since the last call, in order.
    pub fn drain_events(&mut self) -> Vec<LinkEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn closed(&self) -> bool {
        self.closed
    }
    pub fn close_reason(&self) -> Option<&'static str> {
        self.close_reason
    }
    /// A request is pending, including one that is draining.
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    /// Mid-transfer in either direction: never a candidate for rotation.
    pub fn transferring(&self) -> bool {
        self.pending.is_some() || self.in_flight > 0
    }
    /// When this link was last worth having, in either direction.
    pub fn last_useful_at(&self) -> u64 {
        self.last_delivered_at.max(self.last_served_at).max(self.opened_at)
    }
    pub fn have(&self) -> &IndexSet<String> {
        &self.have
    }
    pub fn fetching(&self) -> &IndexMap<String, u64> {
        &self.fetching
    }
    pub fn renditions(&self) -> &IndexMap<String, u64> {
        &self.renditions
    }
    pub fn contribution(&self) -> (bool, Option<&str>, u64) {
        (self.serving, self.rendition.as_deref(), self.contribution_at)
    }
    pub fn outbound_in_flight(&self) -> usize {
        self.in_flight
    }
    pub fn bytes_in(&self) -> u64 {
        self.bytes_in
    }
    pub fn bytes_out(&self) -> u64 {
        self.bytes_out
    }
    pub fn opened_at(&self) -> u64 {
        self.opened_at
    }
    pub fn last_served_at(&self) -> u64 {
        self.last_served_at
    }
    pub fn last_delivered_at(&self) -> u64 {
        self.last_delivered_at
    }
    /// The pending request's ID, including one that is draining.
    pub fn pending_id(&self) -> Option<u64> {
        self.pending.as_ref().map(|pending| pending.id)
    }
    pub fn version(&self) -> u64 {
        self.version
    }
    /// A response is paused until the channel drains.
    pub fn upload_waiting(&self) -> bool {
        matches!(
            self.active,
            Some(Active {
                stage: Stage::Draining { .. },
                ..
            })
        )
    }

    /// Whether the shell's channel is open, as `readyState === "open"`.
    pub fn set_channel_open(&mut self, open: bool) {
        self.channel_open = open;
    }

    /// Whether the channel is ordered and fully reliable, read by the shell
    /// as `peer-link.mjs` reads it when a request is abandoned.
    pub fn set_reliable(&mut self, reliable: bool) {
        self.config.reliable = reliable;
    }

    /// The channel's queued bytes, read before a response is sent. Responses
    /// below the low-water mark never fire `bufferedamountlow`, so the count
    /// kept from sends alone would only grow.
    pub fn observe_buffered(&mut self, buffered: u64) {
        self.buffered = buffered;
    }

    fn send_text(&mut self, message: &[(&str, &Value)]) -> bool {
        if self.closed || !self.channel_open {
            return false;
        }
        self.events.push(LinkEvent::SendText(js::stringify_fields(message)));
        true
    }

    pub fn send_have(&mut self, keys: &[String]) {
        let start = keys.len().saturating_sub(MAX_HAVE_KEYS);
        let keys = Value::from(keys[start..].to_vec());
        self.send_text(&[("t", &Value::from("have")), ("keys", &keys)]);
    }

    pub fn send_have_change(&mut self, add: &[String], del: &[String]) {
        if !add.is_empty() || !del.is_empty() {
            self.send_text(&[
                ("t", &Value::from("have")),
                ("add", &Value::from(add.to_vec())),
                ("del", &Value::from(del.to_vec())),
            ]);
        }
    }

    /// Advisory coordination only; commitments still authenticate every payload.
    pub fn send_contribution(&mut self, serving: bool, rendition: Option<&str>) {
        let rendition = rendition.map(Value::from).unwrap_or(Value::Null);
        self.send_text(&[
            ("t", &Value::from("contribution")),
            ("serving", &Value::from(serving)),
            ("rendition", &rendition),
        ]);
    }

    pub fn send_fetching(&mut self, key: &str, lease_ms: u64) {
        self.send_text(&[
            ("t", &Value::from("fetching")),
            ("k", &Value::from(key)),
            ("ms", &Value::from(lease_ms)),
        ]);
    }

    fn next_timer(&mut self) -> u64 {
        self.timers += 1;
        self.timers
    }

    /// Request one object. Returns the request ID, or `None` with an
    /// immediate `closed` or `busy` report.
    pub fn request(&mut self, now: u64, key: &str, timeout_ms: u64, expected_size: Option<u64>) -> Option<u64> {
        self.start_request(now, key, timeout_ms, expected_size, None)
    }

    /// Framing 2: request pieces `range` of an object of `object_size` bytes
    /// from a holder that advertised framing 2. The holder's `meta` must
    /// echo the range and carry its exact byte length. Returns `None`, with
    /// no events, when the range does not fit the object.
    pub fn request_range(&mut self, now: u64, key: &str, timeout_ms: u64, range: PieceRange, object_size: u64) -> Option<u64> {
        let (from, to) = range_bytes(object_size, range)?;
        self.start_request(now, key, timeout_ms, Some(to - from), Some(range))
    }

    fn start_request(
        &mut self,
        now: u64,
        key: &str,
        timeout_ms: u64,
        expected_size: Option<u64>,
        range: Option<PieceRange>,
    ) -> Option<u64> {
        self.clock = now;
        if self.closed || self.pending.is_some() {
            let outcome = if self.closed { Outcome::Closed } else { Outcome::Busy };
            self.events.push(LinkEvent::Resolved { id: None, bytes: None });
            self.events.push(LinkEvent::Report(RequestReport {
                id: None,
                outcome,
                received_bytes: 0,
                metadata_received: false,
                draining: false,
                close_reason: self.close_reason,
            }));
            return None;
        }
        let id = self.next_id;
        self.next_id += 1;
        let timer = self.next_timer();
        self.pending = Some(Pending {
            id,
            expected: expected_size,
            range,
            size: None,
            parts: Vec::new(),
            chunks: 0,
            received: 0,
            draining: false,
            cancelled: false,
            resolved: false,
            reported: false,
            abandon_reason: "request-timeout",
            deadline: now + timeout_ms.max(1),
            timer,
        });
        let mut want = vec![("t", Value::from("want")), ("id", Value::from(id)), ("k", Value::from(key))];
        if let Some(range) = range {
            want.push(("p", Value::from(vec![range.start, range.end])));
        }
        let want: Vec<(&str, &Value)> = want.iter().map(|(name, value)| (*name, value)).collect();
        if !self.send_text(&want) {
            self.finish(None, Some(Outcome::SendError), true);
        }
        Some(id)
    }

    /// Abort request `id`. `abandoned` records a request the caller projects
    /// to be late rather than an ordinary abort.
    pub fn abort(&mut self, now: u64, id: u64, abandoned: bool) {
        self.clock = now;
        if self.pending.as_ref().is_some_and(|pending| pending.id == id && !pending.draining) {
            self.abandon(now, "request-abort", abandoned);
        }
    }

    fn report_of(&self, pending: &Pending, outcome: Outcome) -> RequestReport {
        RequestReport {
            id: Some(pending.id),
            outcome,
            received_bytes: pending.received,
            metadata_received: pending.size.is_some(),
            draining: pending.draining,
            close_reason: self.close_reason,
        }
    }

    fn abandon(&mut self, now: u64, reason: &'static str, abandoned: bool) {
        let outcome = if reason != "request-abort" {
            Outcome::Timeout
        } else if abandoned {
            Outcome::Abandoned
        } else {
            Outcome::Abort
        };
        if !(self.config.reliable && self.channel_open) {
            let pending = self.finish(None, Some(outcome), false);
            self.close(reason);
            if let Some(mut pending) = pending {
                if !pending.reported {
                    pending.reported = true;
                    let report = self.report_of(&pending, outcome);
                    self.events.push(LinkEvent::Report(report));
                }
            }
            return;
        }
        let timer = self.next_timer();
        let drain = self.config.drain_timeout_ms;
        let Some(mut pending) = self.pending.take() else { return };
        pending.draining = true;
        pending.parts.clear();
        pending.abandon_reason = reason;
        pending.resolved = true;
        self.events.push(LinkEvent::Resolved {
            id: Some(pending.id),
            bytes: None,
        });
        pending.deadline = now + drain;
        pending.timer = timer;
        pending.reported = true;
        let report = self.report_of(&pending, outcome);
        self.events.push(LinkEvent::Report(report));
        let id = pending.id;
        self.pending = Some(pending);
        // Ask the holder to stop. Only after this may its eof end early.
        let cancelled = self.send_text(&[("t", &Value::from("cancel")), ("id", &Value::from(id))]);
        if let Some(pending) = self.pending.as_mut() {
            pending.cancelled = cancelled;
        }
    }

    /// Settle the pending request. `outcome` defaults to payload or none.
    fn finish(&mut self, bytes: Option<Vec<u8>>, outcome: Option<Outcome>, report_now: bool) -> Option<Pending> {
        let mut pending = self.pending.take()?;
        let outcome = outcome.unwrap_or(if bytes.is_some() { Outcome::Payload } else { Outcome::None });
        let delivered = bytes.is_some();
        if !pending.resolved {
            pending.resolved = true;
            self.events.push(LinkEvent::Resolved {
                id: Some(pending.id),
                bytes,
            });
        }
        if delivered {
            self.last_delivered_at = self.clock;
        }
        if pending.draining && !self.closed {
            self.events.push(LinkEvent::ScheduleChanged);
        }
        if report_now && !pending.reported {
            pending.reported = true;
            let report = self.report_of(&pending, outcome);
            self.events.push(LinkEvent::Report(report));
        }
        Some(pending)
    }

    /// Close the link. Unknown reasons read as `host`.
    pub fn close(&mut self, reason: &str) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.version += 1;
        let reason = close_reason(reason);
        self.close_reason = Some(reason);
        self.fetching.clear();
        self.renditions.clear();
        let outcome = if reason == "send-error" {
            Outcome::SendError
        } else {
            Outcome::Closed
        };
        self.finish(None, Some(outcome), true);
        self.events.push(LinkEvent::Closed(reason));
        // A response waiting for the channel to drain stops with the channel.
        if matches!(
            self.active,
            Some(Active {
                stage: Stage::Draining { .. },
                ..
            })
        ) {
            self.active = None;
            self.finish_upload();
        }
    }

    /// The earliest time [`Link::tick`] has work to do.
    pub fn next_deadline(&self) -> Option<u64> {
        let request = self.pending.as_ref().map(|pending| pending.deadline);
        let upload = match &self.active {
            Some(Active {
                stage: Stage::Draining { deadline, .. },
                ..
            }) => Some(*deadline),
            _ => None,
        };
        request.into_iter().chain(upload).min()
    }

    /// Fire every timer due at or before `now`, earliest first.
    pub fn tick(&mut self, now: u64) {
        loop {
            let request = self.pending.as_ref().map(|pending| (pending.deadline, pending.timer));
            let upload = match &self.active {
                Some(Active {
                    stage: Stage::Draining { deadline, timer, .. },
                    ..
                }) => Some((*deadline, *timer)),
                _ => None,
            };
            let due = [request.map(|due| (due, true)), upload.map(|due| (due, false))]
                .into_iter()
                .flatten()
                .filter(|((deadline, _), _)| *deadline <= now)
                .min_by_key(|(due, _)| *due);
            let Some(((at, _), is_request)) = due else { return };
            self.clock = at;
            if is_request {
                let (draining, reason) = self
                    .pending
                    .as_ref()
                    .map(|pending| (pending.draining, pending.abandon_reason))
                    .unwrap();
                if draining {
                    self.close(reason);
                } else {
                    self.abandon(at, "request-timeout", false);
                }
            } else {
                self.active = None;
                self.close("upload-drain-timeout");
                self.finish_upload();
            }
        }
    }

    /// One text frame from the remote.
    pub fn handle_text(&mut self, now: u64, text: &str) {
        self.clock = now;
        if self.closed {
            return;
        }
        if utf16_len(text) > MAX_CONTROL_UNITS {
            return self.close("protocol");
        }
        let message = match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(message)) => message,
            Ok(_) => return,
            Err(_) => return self.close("protocol"),
        };
        match message.get("t").and_then(Value::as_str) {
            Some("contribution") => self.on_contribution(now, &message),
            Some("fetching") => self.on_fetching(now, &message),
            Some("have") => self.on_have(&message),
            Some("want") => self.on_want(&message),
            Some("cancel") => {
                let Some(id) = message.get("id").and_then(js::safe_integer) else {
                    return;
                };
                let id = id as f64;
                for upload in self.queue.iter_mut().chain(self.active.iter_mut().map(|active| &mut active.upload)) {
                    if upload.id == id {
                        upload.cancelled = true;
                    }
                }
                // A cancelled upload adds no more binary data. Its EOF can
                // follow the bytes already queued on the reliable channel;
                // waiting for the low-water event would retain the upload
                // deadline and could close a healthy cancelled connection.
                if let Some(Active {
                    upload,
                    stage: Stage::Draining { bytes, sent, .. },
                }) = self
                    .active
                    .take_if(|active| active.upload.id == id && matches!(active.stage, Stage::Draining { .. }))
                {
                    self.send_chunks(now, upload, bytes, sent, true);
                }
            }
            Some("meta") => self.on_meta(&message),
            Some("eof") => self.on_eof(&message),
            Some("none") => self.on_none(&message),
            _ => {}
        }
    }

    /// Whether the message names the pending request; a mismatch while
    /// draining is a protocol error.
    fn names_pending(&mut self, message: &Map<String, Value>) -> Option<bool> {
        let pending = self.pending.as_ref()?;
        if same_number(message.get("id"), pending.id as f64) {
            return Some(true);
        }
        if pending.draining {
            self.close("protocol");
        }
        Some(false)
    }

    fn on_meta(&mut self, message: &Map<String, Value>) {
        if self.names_pending(message) != Some(true) {
            return;
        }
        let max = self.config.max_segment_bytes;
        let pending = self.pending.as_ref().unwrap();
        if pending.size.is_some() {
            return self.close("protocol");
        }
        // A framing 1 holder ignores the range and sends the whole object.
        if pending
            .range
            .is_some_and(|range| parse_range(message.get("p")) != Some(Some(range)))
        {
            return self.close("protocol");
        }
        if let Some(expected) = pending.expected {
            if !same_number(message.get("size"), expected as f64) {
                return self.close("protocol");
            }
        }
        match message.get("size").and_then(js::safe_integer) {
            Some(size) if size >= 1 && size as u64 <= max => self.pending.as_mut().unwrap().size = Some(size as u64),
            _ => self.close("protocol"),
        }
    }

    fn on_eof(&mut self, message: &Map<String, Value>) {
        if self.names_pending(message) != Some(true) {
            return;
        }
        let pending = self.pending.as_ref().unwrap();
        if pending.cancelled && pending.size.is_some() {
            self.finish(None, None, true);
            return;
        }
        if pending.size != Some(pending.received) {
            return self.close("protocol");
        }
        if pending.draining {
            self.finish(None, None, true);
            return;
        }
        let bytes = std::mem::take(&mut self.pending.as_mut().unwrap().parts);
        self.finish(Some(bytes), None, true);
    }

    fn on_none(&mut self, message: &Map<String, Value>) {
        if self.names_pending(message) != Some(true) {
            return;
        }
        if self.pending.as_ref().unwrap().size.is_some() {
            return self.close("protocol");
        }
        self.finish(None, None, true);
    }

    fn on_contribution(&mut self, now: u64, message: &Map<String, Value>) {
        let Some(serving) = message.get("serving").and_then(Value::as_bool) else {
            return;
        };
        let rendition = match message.get("rendition") {
            Some(Value::Null) => None,
            Some(Value::String(text)) if utf16_len(text) <= MAX_RENDITION_UNITS => Some(text.clone()),
            _ => return,
        };
        self.serving = serving;
        self.rendition = rendition.clone();
        self.contribution_at = now;
        if !serving {
            self.fetching.clear();
            self.renditions.clear();
        } else if let Some(rendition) = rendition {
            self.renditions.retain(|_, seen| *seen >= now.saturating_sub(RENDITION_STALE_MS));
            if self.renditions.contains_key(&rendition) || self.renditions.len() < MAX_RENDITIONS {
                self.renditions.insert(rendition, now);
            }
        }
        self.version += 1;
        self.events.push(LinkEvent::ScheduleChanged);
    }

    fn on_fetching(&mut self, now: u64, message: &Map<String, Value>) {
        let Some(key) = message.get("k").filter(|key| is_hex64(key)).and_then(Value::as_str) else {
            return;
        };
        let Some(ms) = message
            .get("ms")
            .and_then(js::safe_integer)
            .filter(|ms| (0..=MAX_FETCHING_MS).contains(ms))
        else {
            return;
        };
        self.fetching.retain(|_, expires| *expires > now);
        if ms == 0 {
            self.fetching.shift_remove(key);
        } else if self.serving && (self.fetching.contains_key(key) || self.fetching.len() < MAX_FETCHING) {
            self.fetching.insert(key.to_owned(), now + ms as u64);
        }
        self.version += 1;
        self.events.push(LinkEvent::ScheduleChanged);
    }

    fn on_have(&mut self, message: &Map<String, Value>) {
        let mut added = Vec::new();
        if message.get("keys").is_some_and(Value::is_array) {
            self.have.clear();
            self.have.extend(valid_keys(message.get("keys")));
            added.extend(self.have.iter().cloned());
        }
        for key in valid_keys(message.get("add")) {
            if self.have.len() >= MAX_HAVE_KEYS {
                break;
            }
            self.have.insert(key.clone());
            added.push(key);
        }
        for key in valid_keys(message.get("del")) {
            self.have.shift_remove(&key);
        }
        self.version += 1;
        if !added.is_empty() {
            self.events.push(LinkEvent::HaveChanged(added));
        }
    }

    fn on_want(&mut self, message: &Map<String, Value>) {
        let Some(id) = message.get("id").and_then(js::safe_integer) else {
            return;
        };
        let Some(key) = message.get("k").filter(|key| is_hex64(key)).and_then(Value::as_str) else {
            return;
        };
        let Some(range) = parse_range(message.get("p")) else {
            return self.close("protocol");
        };
        if self.in_flight >= self.config.max_queued_requests {
            return self.close("upload-queue");
        }
        self.in_flight += 1;
        self.queue.push_back(Upload {
            id: id as f64,
            key: key.to_owned(),
            cancelled: false,
            range,
        });
        self.start_next();
    }

    fn finish_upload(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
        self.start_next();
    }

    /// Start queued responses in order until one waits for its bytes.
    fn start_next(&mut self) {
        while self.active.is_none() {
            let Some(upload) = self.queue.pop_front() else { return };
            if upload.cancelled {
                self.events.push(LinkEvent::UploadCancelled(0));
                self.send_text(&[("t", &Value::from("none")), ("id", &Value::from(upload.id))]);
                self.in_flight = self.in_flight.saturating_sub(1);
                continue;
            }
            if self.closed {
                self.in_flight = self.in_flight.saturating_sub(1);
                continue;
            }
            self.events.push(match upload.range {
                Some(range) => LinkEvent::ServeRange {
                    key: upload.key.clone(),
                    range,
                },
                None => LinkEvent::ServeRequest(upload.key.clone()),
            });
            self.active = Some(Active {
                upload,
                stage: Stage::AwaitingBytes,
            });
        }
    }

    /// The shell's answer to the oldest `ServeRequest`: the bytes to send, or
    /// `None` when they are not held or serving is declined. Upload already
    /// charged for a cancelled response is not refunded.
    pub fn serve_response(&mut self, now: u64, bytes: Option<Vec<u8>>) {
        self.serve_response_inner(now, bytes, None);
    }

    /// Answer an active range with only its bytes, rather than copying a whole
    /// held object across the host boundary. The original object size fixes the
    /// canonical piece size; a mismatched length, missing range or oversized
    /// object is declined. Wire framing and receiver verification are unchanged.
    pub fn serve_range_response(&mut self, now: u64, object_size: u64, bytes: Vec<u8>) {
        self.serve_response_inner(now, Some(bytes), Some(object_size));
    }

    fn serve_response_inner(&mut self, now: u64, bytes: Option<Vec<u8>>, range_object_size: Option<u64>) {
        self.clock = now;
        let Some(Active {
            upload,
            stage: Stage::AwaitingBytes,
        }) = self.active.take_if(|active| matches!(active.stage, Stage::AwaitingBytes))
        else {
            return;
        };
        let none = [("t", &Value::from("none")), ("id", &Value::from(upload.id))];
        let Some(mut bytes) = bytes else {
            self.send_text(&none);
            return self.finish_upload();
        };
        if let Some(object_size) = range_object_size {
            let expected = upload
                .range
                .filter(|_| object_size <= self.config.max_segment_bytes)
                .and_then(|range| range_bytes(object_size, range));
            if !expected.is_some_and(|(from, to)| to - from == bytes.len() as u64) {
                self.send_text(&none);
                return self.finish_upload();
            }
        } else if let Some(range) = upload.range {
            // A range the held object does not have is answered with `none`.
            let Some((from, to)) = range_bytes(bytes.len() as u64, range) else {
                self.send_text(&none);
                return self.finish_upload();
            };
            bytes.truncate(to as usize);
            bytes.drain(..from as usize);
        }
        if upload.cancelled {
            self.events.push(LinkEvent::UploadCancelled(bytes.len() as u64));
            self.send_text(&none);
            return self.finish_upload();
        }
        let mut meta = vec![
            ("t", Value::from("meta")),
            ("id", Value::from(upload.id)),
            ("size", Value::from(bytes.len())),
        ];
        if let Some(range) = upload.range {
            meta.push(("p", Value::from(vec![range.start, range.end])));
        }
        let meta: Vec<(&str, &Value)> = meta.iter().map(|(name, value)| (*name, value)).collect();
        if !self.send_text(&meta) {
            return self.finish_upload();
        }
        self.send_chunks(now, upload, bytes, 0, false);
    }

    /// The channel's buffered amount fell to the low-water mark.
    pub fn buffered_amount_low(&mut self, now: u64, buffered: u64) {
        self.clock = now;
        self.buffered = buffered;
        if let Some(Active {
            upload,
            stage: Stage::Draining { bytes, sent, .. },
        }) = self.active.take_if(|active| matches!(active.stage, Stage::Draining { .. }))
        {
            self.send_chunks(now, upload, bytes, sent, true);
        }
    }

    fn send_chunks(&mut self, now: u64, upload: Upload, bytes: Vec<u8>, mut sent: usize, mut resumed: bool) {
        while sent < bytes.len() {
            if self.closed {
                return self.finish_upload();
            }
            if !resumed && self.buffered > HIGH_WATER_BYTES {
                let timer = self.next_timer();
                let deadline = now + self.config.drain_timeout_ms;
                self.active = Some(Active {
                    upload,
                    stage: Stage::Draining {
                        bytes,
                        sent,
                        deadline,
                        timer,
                    },
                });
                return;
            }
            resumed = false;
            if upload.cancelled {
                break;
            }
            let end = (sent + CHUNK_BYTES).min(bytes.len());
            self.buffered += (end - sent) as u64;
            self.events.push(LinkEvent::SendBinary(bytes[sent..end].to_vec()));
            sent = end;
        }
        self.bytes_out += sent as u64;
        self.last_served_at = now;
        if sent < bytes.len() {
            self.events.push(LinkEvent::UploadCancelled((bytes.len() - sent) as u64));
        }
        self.send_text(&[("t", &Value::from("eof")), ("id", &Value::from(upload.id))]);
        self.finish_upload();
    }

    /// One binary frame from the remote.
    pub fn handle_binary(&mut self, now: u64, chunk: &[u8]) {
        self.clock = now;
        if self.closed {
            return;
        }
        let max_chunks = self.max_chunks;
        let Some(pending) = self.pending.as_mut() else { return };
        let Some(size) = pending.size else { return self.close("protocol") };
        if chunk.is_empty() || chunk.len() > CHUNK_BYTES || pending.chunks >= max_chunks {
            return self.close("protocol");
        }
        pending.chunks += 1;
        pending.received += chunk.len() as u64;
        self.bytes_in += chunk.len() as u64;
        if pending.received > size {
            return self.close("protocol");
        }
        if pending.draining {
            return;
        }
        pending.parts.extend_from_slice(chunk);
        let received = pending.received;
        self.events.push(LinkEvent::Progress { received, size });
    }
}
