//! Multi-holder scheduling for one schema 3 object (CORE-SPEC section 6).
//!
//! [`plan`] is a pure function: it splits the pieces still needed across
//! sources so that all are projected to finish together, and adds origin for
//! the tail when peers alone would be late. [`Transfer`] runs one object: it
//! issues ranged requests, verifies every piece against the signed
//! commitment, bans a holder that sends a bad piece, reassigns failed work,
//! hands outstanding pieces to origin at the deadline and duplicates the last
//! pieces of a lagging source. A peer that stays silent, or whose flow
//! cannot finish its range by the floor, is abandoned early and its pieces
//! move, as the single-holder loader abandons a hopeless request. It
//! delivers only a fully verified object.
//! An explicit peer-only transfer keeps uncovered work pending instead of
//! inventing an origin lane. Its independent HTTP arm belongs to the caller.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use sha2::{Digest, Sha256};

use crate::commitment::commitment_piece_size;
use crate::pieces::{piece_count, PieceRange};

/// Holders per object. Provisional: the spec's proposal, not yet set from a
/// replayed field trace, and not to be used in a field run until it is.
pub const DEFAULT_MAX_HOLDERS: usize = 3;
/// Contexts fetched ahead of demand. Provisional, as above.
pub const DEFAULT_LOOKAHEAD_SEGMENTS: usize = 2;
/// Time kept for origin before the player's deadline (`originReserveMs`).
pub const DEFAULT_ORIGIN_RESERVE_MS: f64 = 2_000.0;
/// Peer requests verify progress in bounded batches, so abandoning a later
/// request keeps earlier pieces. Origin retains contiguous HTTP ranges.
pub const MAX_PEER_REQUEST_PIECES: u32 = 4;
pub const MAX_PEER_REQUEST_BYTES: u64 = 512 * 1024;
/// At most this many unverified pieces left starts the endgame.
pub const ENDGAME_PIECES: usize = 2;
/// A request is never abandoned for silence sooner than this
/// (`SILENCE_FLOOR_MS` in the loader).
pub const SILENCE_FLOOR_MS: f64 = 250.0;
/// The flow rate is judged over about this much of the latest flow, and not
/// on less than `MIN_FLOW_MS` of it (the loader's single-holder window).
const RATE_WINDOW_MS: u64 = 400;
const MIN_FLOW_MS: u64 = 150;
/// A flowing request that sends nothing new is checked again this often.
pub const STALL_CHECK_MS: u64 = 250;
/// Flow points kept per request.
const FLOW_POINTS: usize = 256;
/// The rate floor when nothing is measured, in bytes per millisecond
/// (`MIN_RATE_BYTES` per second in peer selection).
pub const MIN_RATE: f64 = 32.0 * 1024.0 / 1000.0;

/// Where pieces come from. Peers are the shell's link handles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Source {
    Peer(u64),
    Origin,
}

/// What is known of one source's timing. `rate` is payload bytes per
/// millisecond after the first byte; `None` means untested.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Estimate {
    pub source: Source,
    pub first_byte_ms: Option<f64>,
    pub rate: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct PlanInput<'a> {
    pub size: u64,
    /// Piece indices still needed, ascending.
    pub needed: &'a [u32],
    /// Eligible peers: open, framing 2, holding the object, not banned.
    pub peers: &'a [Estimate],
    pub origin: Option<Estimate>,
    /// Swarm-wide estimates for untested peers.
    pub shared_first_byte_ms: Option<f64>,
    pub shared_rate: Option<f64>,
    /// Time from now until the deadline less the origin reserve.
    pub available_ms: f64,
    pub max_holders: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Assignment {
    pub source: Source,
    /// Contiguous runs, in request order.
    pub ranges: Vec<PieceRange>,
    pub bytes: u64,
    /// Projected time from now until this source finishes.
    pub projected_ms: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub assignments: Vec<Assignment>,
    pub projected_ms: f64,
    /// Even the plan with origin is projected past `available_ms`. The
    /// caller decides between it and a whole-object origin fetch.
    pub late: bool,
}

fn positive(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v > 0.0)
}

fn non_negative(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v >= 0.0)
}

/// The upper median, as peer selection takes quantiles.
fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    Some(values[values.len() / 2])
}

/// Fill in untested sources: the median of tested peers, else the shared
/// estimate, else the rate floor.
fn resolve(estimates: &[Estimate], input: &PlanInput) -> Vec<(Source, f64, f64)> {
    let tested = median(input.peers.iter().filter_map(|peer| positive(peer.rate)).collect());
    let fallback_rate = tested.or(positive(input.shared_rate)).unwrap_or(MIN_RATE);
    let fallback_first_byte = non_negative(input.shared_first_byte_ms).unwrap_or(0.0);
    estimates
        .iter()
        .map(|estimate| {
            let rate = positive(estimate.rate).unwrap_or(fallback_rate);
            let first_byte = non_negative(estimate.first_byte_ms).unwrap_or(fallback_first_byte);
            (estimate.source, first_byte, rate)
        })
        .collect()
}

fn piece_bytes(size: u64, piece_size: u64, index: u32) -> u64 {
    let from = u64::from(index) * piece_size;
    (from + piece_size).min(size).saturating_sub(from)
}

/// Contiguous runs of `pieces`, which are ascending.
fn runs(pieces: &[u32]) -> Vec<PieceRange> {
    let mut ranges: Vec<PieceRange> = Vec::new();
    for &index in pieces {
        match ranges.last_mut() {
            Some(range) if range.end == index => range.end += 1,
            _ => ranges.push(PieceRange {
                start: index,
                end: index + 1,
            }),
        }
    }
    ranges
}

/// The finish time T at which sources `(first_byte, rate)` together carry
/// `bytes`: the sum over sources of `max(0, T - first_byte) * rate`.
fn water_fill(sources: &[(Source, f64, f64)], bytes: f64) -> f64 {
    let mut order: Vec<&(Source, f64, f64)> = sources.iter().collect();
    order.sort_by(|a, b| a.1.total_cmp(&b.1));
    let (mut weighted, mut rates) = (0.0, 0.0);
    for (index, (_, first_byte, rate)) in order.iter().enumerate() {
        weighted += first_byte * rate;
        rates += rate;
        let finish = (bytes + weighted) / rates;
        if order.get(index + 1).is_none_or(|next| finish <= next.1) {
            return finish;
        }
    }
    f64::INFINITY
}

/// Split `needed` across `sources` in order, whole pieces each.
fn split(input: &PlanInput, sources: &[(Source, f64, f64)]) -> Plan {
    let piece_size = commitment_piece_size(input.size as i64) as u64;
    let sizes: Vec<u64> = input
        .needed
        .iter()
        .map(|&index| piece_bytes(input.size, piece_size, index))
        .collect();
    let total: u64 = sizes.iter().sum();
    let finish = water_fill(sources, total as f64);
    // Largest remainder over piece counts, from each source's byte share.
    let shares: Vec<f64> = sources
        .iter()
        .map(|(_, first_byte, rate)| (finish - first_byte).max(0.0) * rate / piece_size as f64)
        .collect();
    let mut counts: Vec<usize> = shares.iter().map(|share| share.floor() as usize).collect();
    let mut left = input.needed.len().saturating_sub(counts.iter().sum());
    let mut order: Vec<usize> = (0..sources.len()).collect();
    order.sort_by(|&a, &b| {
        (shares[b] - shares[b].floor())
            .total_cmp(&(shares[a] - shares[a].floor()))
            .then(a.cmp(&b))
    });
    // The shares sum to at most the piece count, so one pass places the rest.
    for &index in &order {
        if left == 0 {
            break;
        }
        counts[index] += 1;
        left -= 1;
    }
    counts[0] += left;
    // Rounding error can only overshoot by a piece or two: trim the tail.
    let mut excess = counts.iter().sum::<usize>().saturating_sub(input.needed.len());
    for count in counts.iter_mut().rev() {
        let cut = excess.min(*count);
        *count -= cut;
        excess -= cut;
    }
    let mut assignments = Vec::new();
    let mut at = 0;
    for ((source, first_byte, rate), count) in sources.iter().zip(counts) {
        if count == 0 {
            continue;
        }
        let pieces = &input.needed[at..at + count];
        let bytes: u64 = sizes[at..at + count].iter().sum();
        at += count;
        assignments.push(Assignment {
            source: *source,
            ranges: runs(pieces),
            bytes,
            projected_ms: first_byte + bytes as f64 / rate,
        });
    }
    let projected_ms = assignments.iter().map(|a| a.projected_ms).fold(0.0, f64::max);
    Plan {
        assignments,
        projected_ms,
        late: projected_ms > input.available_ms,
    }
}

/// Plan the needed pieces: peers alone first, fastest first; if they would
/// be late, origin joins and takes the tail. Origin never counts against
/// `max_holders`.
pub fn plan(input: &PlanInput) -> Plan {
    if input.needed.is_empty() {
        return Plan {
            assignments: Vec::new(),
            projected_ms: 0.0,
            late: false,
        };
    }
    let mut peers = resolve(input.peers, input);
    peers.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.1.total_cmp(&b.1)).then(a.0.cmp(&b.0)));
    peers.truncate(input.max_holders.max(1));
    let alone = (!peers.is_empty()).then(|| split(input, &peers));
    if let Some(alone) = alone.as_ref().filter(|alone| !alone.late) {
        return alone.clone();
    }
    let Some(origin) = input.origin else {
        return alone.unwrap_or(Plan {
            assignments: Vec::new(),
            projected_ms: f64::INFINITY,
            late: true,
        });
    };
    // Rule 3: peers keep what they can finish in time, fastest first, and
    // origin takes only the tail. Origin never competes for the head, so a
    // fast origin cannot starve the peers of the evidence they need. An
    // untested peer gets at least one piece, so it is measured; the floor
    // moves that piece to origin if it is late.
    let origin = resolve(&[origin], input)[0];
    let untested: Vec<Source> = input
        .peers
        .iter()
        .filter(|peer| positive(peer.rate).is_none())
        .map(|peer| peer.source)
        .collect();
    tail_to_origin(input, &peers, origin, &untested)
}

fn tail_to_origin(input: &PlanInput, peers: &[(Source, f64, f64)], origin: (Source, f64, f64), untested: &[Source]) -> Plan {
    let piece_size = commitment_piece_size(input.size as i64) as u64;
    let mut at = 0;
    let mut assignments = Vec::new();
    for (source, first_byte, rate) in peers {
        if at >= input.needed.len() {
            break;
        }
        let capacity = (input.available_ms - first_byte).max(0.0) * rate;
        let mut count = 0;
        let mut bytes = 0;
        while at + count < input.needed.len() {
            let next = piece_bytes(input.size, piece_size, input.needed[at + count]);
            let trial = count == 0 && untested.contains(source);
            if (bytes + next) as f64 > capacity && !trial {
                break;
            }
            bytes += next;
            count += 1;
        }
        if count == 0 {
            continue;
        }
        assignments.push(Assignment {
            source: *source,
            ranges: runs(&input.needed[at..at + count]),
            bytes,
            projected_ms: first_byte + bytes as f64 / rate,
        });
        at += count;
    }
    if at < input.needed.len() {
        let bytes: u64 = input.needed[at..]
            .iter()
            .map(|&index| piece_bytes(input.size, piece_size, index))
            .sum();
        assignments.push(Assignment {
            source: origin.0,
            ranges: runs(&input.needed[at..]),
            bytes,
            projected_ms: origin.1 + bytes as f64 / origin.2,
        });
    }
    let projected_ms = assignments.iter().map(|a| a.projected_ms).fold(0.0, f64::max);
    Plan {
        assignments,
        projected_ms,
        late: projected_ms > input.available_ms,
    }
}

/// Settings for one transfer.
#[derive(Clone, Copy, Debug)]
pub struct TransferConfig {
    pub max_holders: usize,
    pub origin_reserve_ms: f64,
}

impl Default for TransferConfig {
    fn default() -> Self {
        TransferConfig {
            max_holders: DEFAULT_MAX_HOLDERS,
            origin_reserve_ms: DEFAULT_ORIGIN_RESERVE_MS,
        }
    }
}

/// What the shell must do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// Send a framing 2 `want` for these pieces on this peer's link.
    Request { peer: u64, range: PieceRange },
    /// Fetch these pieces from origin with an HTTP `Range` request.
    FetchOrigin { range: PieceRange },
    /// Abort the peer's request for this object; it takes no more of it.
    Cancel { peer: u64 },
    /// As `Cancel`, because the request was hopeless: silent, or too slow to
    /// finish by the floor. The shell may count it as abandoned.
    Abandon { peer: u64 },
    /// The peer sent a piece that failed its hash: ban it for this object
    /// and charge it under the existing ban rules.
    Ban { peer: u64 },
    /// Every piece verified and the whole object matches. In-flight peers
    /// get `Cancel` first; the shell aborts any origin fetch still running.
    Deliver(Vec<u8>),
    /// The object cannot be completed here; fetch it whole from origin. As
    /// with `Deliver`, the shell aborts any origin range fetch still running.
    Fail,
}

#[derive(Debug)]
struct Lane {
    estimate: Estimate,
    queue: VecDeque<PieceRange>,
    in_flight: Vec<(PieceRange, u64)>,
    /// Projected absolute time this lane finishes its work.
    finish_at: f64,
    retired: bool,
    /// For a peer's in-flight request: when its first progress came, and
    /// `(time, bytes received)` since.
    first_byte_at: Option<u64>,
    flow: VecDeque<(u64, u64)>,
    /// When a tick last judged the request.
    checked_at: u64,
}

impl Lane {
    fn new(estimate: Estimate, now: u64) -> Self {
        Lane {
            estimate,
            queue: VecDeque::new(),
            in_flight: Vec::new(),
            finish_at: now as f64,
            retired: false,
            first_byte_at: None,
            flow: VecDeque::new(),
            checked_at: now,
        }
    }

    /// The piece is queued or in flight on this live lane.
    fn holds(&self, index: u32) -> bool {
        let contains = |range: &PieceRange| range.start <= index && index < range.end;
        !self.retired && (self.in_flight.iter().any(|(range, _)| contains(range)) || self.queue.iter().any(contains))
    }
}

/// One schema 3 object fetched from several sources.
#[derive(Debug)]
pub struct Transfer {
    config: TransferConfig,
    peer_only: bool,
    exclusive_origin: bool,
    origin_started: bool,
    started: bool,
    size: u64,
    piece_size: u64,
    hashes: Vec<[u8; 32]>,
    whole: [u8; 32],
    deadline: u64,
    data: Vec<u8>,
    verified: Vec<bool>,
    lanes: BTreeMap<Source, Lane>,
    probe_peers: BTreeSet<Source>,
    probe_available: BTreeSet<Source>,
    /// Unassigned, unverified indices; bounded by the canonical piece count.
    peer_pending: BTreeSet<u32>,
    shared_first_byte_ms: Option<f64>,
    shared_rate: Option<f64>,
    /// Pieces already duplicated by the endgame.
    duplicated: BTreeSet<u32>,
    floor_reached: bool,
    /// The latest plan was projected past the origin floor.
    late: bool,
    finished: bool,
    commands: Vec<Command>,
}

fn decode(hex_digest: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_digest, &mut out).ok()?;
    Some(out)
}

impl Transfer {
    /// A transfer of an object of `size` bytes committed to `sha256` and
    /// `pieces` (schema 3, already verified), due at `deadline`. `None` when
    /// the piece list does not fit the size.
    pub fn new(config: TransferConfig, size: u64, sha256: &str, pieces: &[&str], deadline: u64) -> Option<Self> {
        let count = piece_count(size)? as usize;
        if pieces.len() != count {
            return None;
        }
        let hashes = pieces.iter().map(|piece| decode(piece)).collect::<Option<Vec<_>>>()?;
        Some(Transfer {
            config,
            peer_only: false,
            exclusive_origin: false,
            origin_started: false,
            started: false,
            size,
            piece_size: commitment_piece_size(size as i64) as u64,
            hashes,
            whole: decode(sha256)?,
            deadline,
            data: vec![0; size as usize],
            verified: vec![false; count],
            lanes: BTreeMap::new(),
            probe_peers: BTreeSet::new(),
            probe_available: BTreeSet::new(),
            peer_pending: BTreeSet::new(),
            shared_first_byte_ms: None,
            shared_rate: None,
            duplicated: BTreeSet::new(),
            floor_reached: false,
            late: false,
            finished: false,
            commands: Vec::new(),
        })
    }

    /// A bounded peer arm alongside a separate whole-object HTTP request.
    /// It never opens an origin lane or requests HTTP ranges. The existing
    /// floor cancels this arm and fails it; the caller's HTTP arm continues.
    pub fn new_peer_only(config: TransferConfig, size: u64, sha256: &str, pieces: &[&str], deadline: u64) -> Option<Self> {
        let mut transfer = Self::new(config, size, sha256, pieces, deadline)?;
        transfer.peer_only = true;
        Some(transfer)
    }

    pub fn peer_only(&self) -> bool {
        self.peer_only
    }

    /// Opt in before starting: transfer only queued, unissued origin work to
    /// peers. Recovery may repeat bytes from a failed or cancelled request.
    /// Independent peer-only arms have no origin ownership to partition.
    pub fn with_exclusive_origin(mut self) -> Option<Self> {
        if self.peer_only || self.started || self.finished {
            return None;
        }
        self.exclusive_origin = true;
        Some(self)
    }

    pub fn drain_commands(&mut self) -> Vec<Command> {
        std::mem::take(&mut self.commands)
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    /// Bytes of the object verified so far, each piece counted once
    /// whichever source sent it first.
    pub fn verified_bytes(&self) -> u64 {
        (0..self.verified.len() as u32)
            .filter(|&index| self.verified[index as usize])
            .map(|index| piece_bytes(self.size, self.piece_size, index))
            .sum()
    }

    /// The latest plan, origin included, is projected to finish after the
    /// deadline less the origin reserve. The shell may prefer a whole-object
    /// origin fetch; the floor still applies either way.
    pub fn late(&self) -> bool {
        self.late
    }

    /// Plan and issue the first requests. `peers` are the eligible holders;
    /// origin is always a source.
    pub fn start(&mut self, now: u64, peers: &[Estimate], origin: Estimate, shared_first_byte_ms: Option<f64>, shared_rate: Option<f64>) {
        self.start_with_probe_peers(now, peers, origin, shared_first_byte_ms, shared_rate, &[]);
    }

    /// Start with explicit one-piece calibration allowances. Other sources
    /// immediately take the remainder; shared bandwidth cannot enlarge a probe.
    pub fn start_with_probe_peers(
        &mut self,
        now: u64,
        peers: &[Estimate],
        origin: Estimate,
        shared_first_byte_ms: Option<f64>,
        shared_rate: Option<f64>,
        probe_peers: &[u64],
    ) {
        self.start_inner(
            now,
            peers,
            (!self.peer_only).then_some(origin),
            shared_first_byte_ms,
            shared_rate,
            probe_peers,
        );
    }

    /// Start an explicit peer-only handle without accepting an origin model.
    /// Calling this on a mixed handle leaves its existing API unchanged.
    pub fn start_peer_only_with_probe_peers(
        &mut self,
        now: u64,
        peers: &[Estimate],
        shared_first_byte_ms: Option<f64>,
        shared_rate: Option<f64>,
        probe_peers: &[u64],
    ) {
        if self.peer_only {
            self.start_inner(now, peers, None, shared_first_byte_ms, shared_rate, probe_peers);
        }
    }

    fn start_inner(
        &mut self,
        now: u64,
        peers: &[Estimate],
        origin: Option<Estimate>,
        shared_first_byte_ms: Option<f64>,
        shared_rate: Option<f64>,
        probe_peers: &[u64],
    ) {
        if self.peer_only && (self.started || self.finished) {
            return;
        }
        self.started = true;
        self.shared_first_byte_ms = shared_first_byte_ms;
        self.shared_rate = shared_rate;
        self.probe_peers = probe_peers
            .iter()
            .copied()
            .map(Source::Peer)
            .filter(|source| peers.iter().any(|peer| peer.source == *source))
            .collect();
        if self.peer_only {
            // A shared estimate is not evidence about this holder. Every
            // unknown lane receives one piece before it can own a batch.
            self.probe_peers
                .extend(peers.iter().filter(|peer| positive(peer.rate).is_none()).map(|peer| peer.source));
        }
        self.probe_available = self.probe_peers.clone();
        for estimate in peers.iter().chain(origin.iter()) {
            if self.peer_only && !matches!(estimate.source, Source::Peer(_)) {
                continue;
            }
            self.lanes.entry(estimate.source).or_insert_with(|| Lane::new(*estimate, now));
        }
        let needed: Vec<u32> = (0..self.verified.len() as u32).collect();
        self.assign(now, &needed);
    }

    /// When the shell should call [`Transfer::tick`] next.
    pub fn next_deadline(&self) -> Option<u64> {
        if self.finished {
            return None;
        }
        if self.peer_only {
            let floor = self.floor_at();
            if self.peer_only_endgame_source().is_none() {
                return Some(floor);
            }
            let left = self.endgame_pieces();
            return self
                .lanes
                .values()
                .filter(|lane| !lane.in_flight.is_empty() && left.iter().any(|index| lane.holds(*index)))
                .map(|lane| lane.finish_at.ceil() as u64)
                .chain(std::iter::once(floor))
                .min();
        }
        let floor = (!self.floor_reached).then(|| self.floor_at());
        // Lagging sources matter only once the endgame could act on them.
        let left = self.endgame_pieces();
        let lag = self
            .lanes
            .values()
            .filter(|lane| !lane.in_flight.is_empty() && left.iter().any(|index| lane.holds(*index)))
            .map(|lane| lane.finish_at.ceil() as u64);
        let watch = self.lanes.iter().filter_map(|(source, _)| self.watch_at(*source));
        floor.into_iter().chain(lag).chain(watch).min()
    }

    /// When a peer's in-flight request should next be judged: its silence
    /// limit before the first byte, then a stall check after its latest bytes.
    fn watch_at(&self, source: Source) -> Option<u64> {
        if self.peer_only {
            return None;
        }
        let lane = self.lanes.get(&source)?;
        if !matches!(source, Source::Peer(_)) || lane.retired || self.floor_reached {
            return None;
        }
        let &(range, sent) = lane.in_flight.first()?;
        match lane.first_byte_at {
            None => Some(self.silence_at(source, sent, range)?.ceil() as u64),
            Some(_) => {
                let last = lane.flow.back().map_or(sent, |(at, _)| *at);
                Some(last.max(lane.checked_at) + STALL_CHECK_MS)
            }
        }
    }

    /// No first byte by then abandons the request: three recent first-byte
    /// times and at least `SILENCE_FLOOR_MS`, or later while the range could
    /// still finish by the floor at the best recent rate. Unknown without a
    /// first-byte time on this lane or the shared fallback, as in the loader.
    fn silence_at(&self, source: Source, sent: u64, range: PieceRange) -> Option<f64> {
        let first_byte = self
            .lanes
            .get(&source)
            .and_then(|lane| non_negative(lane.estimate.first_byte_ms))
            .or(non_negative(self.shared_first_byte_ms))?;
        let (from, to) = self.piece_range_bytes(range);
        let hopeless = positive(self.shared_rate).map_or(f64::NEG_INFINITY, |best| self.floor_at() as f64 - (to - from) as f64 / best);
        Some(sent as f64 + SILENCE_FLOOR_MS.max(first_byte * 3.0).max(hopeless - sent as f64))
    }

    /// The peer's in-flight request cannot finish its range by the floor,
    /// even at twice its recent rate or the best shared rate, or it has been
    /// silent too long. The window ends now, so a stall lowers the rate.
    /// Never sooner than one first-byte time after the first byte.
    fn hopeless(&self, now: u64, source: Source) -> bool {
        if self.peer_only {
            return false;
        }
        let Some(lane) = self.lanes.get(&source) else { return false };
        let Some(&(range, sent)) = lane.in_flight.first() else {
            return false;
        };
        if lane.retired || !matches!(source, Source::Peer(_)) {
            return false;
        }
        let Some(first) = lane.first_byte_at else {
            return self.silence_at(source, sent, range).is_some_and(|at| now as f64 >= at);
        };
        if now.saturating_sub(sent) < 2 * first.saturating_sub(sent) {
            return false;
        }
        let Some(&(_, received)) = lane.flow.back() else { return false };
        let start = lane
            .flow
            .iter()
            .rev()
            .find(|(at, _)| *at + RATE_WINDOW_MS <= now)
            .or(lane.flow.front())
            .copied()
            .unwrap_or((now, received));
        let span = now.saturating_sub(start.0);
        if span < MIN_FLOW_MS {
            return false;
        }
        let recent = received.saturating_sub(start.1) as f64 / span as f64;
        let rate = (2.0 * recent).max(positive(self.shared_rate).unwrap_or(0.0));
        let (from, to) = self.piece_range_bytes(range);
        let left = (to - from) as f64 - received as f64;
        rate <= 0.0 || now as f64 + left.max(0.0) / rate > self.floor_at() as f64
    }

    /// Cancel a hopeless request and move its pieces to the other sources.
    fn abandon(&mut self, now: u64, source: Source) {
        let Source::Peer(peer) = source else { return };
        self.commands.push(Command::Abandon { peer });
        let pieces = self.retire(source);
        let pieces: Vec<u32> = pieces.into_iter().filter(|index| !self.covered(*index)).collect();
        self.assign(now, &pieces);
        self.rebalance_origin(now);
    }

    /// Bytes received so far on the peer's in-flight request. Abandons it
    /// when it cannot finish by the floor.
    pub fn progress(&mut self, now: u64, source: Source, received: u64) {
        if self.peer_only && now >= self.floor_at() {
            self.tick(now);
            return;
        }
        if self.finished || self.floor_reached {
            return;
        }
        let Some(lane) = self.lanes.get_mut(&source) else { return };
        if lane.retired || lane.in_flight.is_empty() || !matches!(source, Source::Peer(_)) {
            return;
        }
        lane.first_byte_at.get_or_insert(now);
        lane.flow.push_back((now, received));
        if lane.flow.len() > FLOW_POINTS {
            lane.flow.pop_front();
        }
        if self.hopeless(now, source) {
            self.abandon(now, source);
        }
    }

    /// Unverified pieces the endgame may still duplicate.
    fn endgame_pieces(&self) -> Vec<u32> {
        let left: Vec<u32> = (0..self.verified.len() as u32).filter(|&i| !self.verified[i as usize]).collect();
        if self.exclusive_origin || self.floor_reached || left.len() > ENDGAME_PIECES {
            return Vec::new();
        }
        left.into_iter().filter(|index| !self.duplicated.contains(index)).collect()
    }

    fn floor_at(&self) -> u64 {
        self.deadline.saturating_sub(self.config.origin_reserve_ms.max(0.0) as u64)
    }

    fn piece_range_bytes(&self, range: PieceRange) -> (usize, usize) {
        let from = u64::from(range.start) * self.piece_size;
        let to = (u64::from(range.end) * self.piece_size).min(self.size);
        (from as usize, to as usize)
    }

    fn unverified(&self, range: PieceRange) -> Vec<u32> {
        (range.start..range.end).filter(|&index| !self.verified[index as usize]).collect()
    }

    /// Assign pieces across the sources that can take more work.
    fn assign(&mut self, now: u64, needed: &[u32]) {
        if self.peer_only {
            for &index in needed {
                if (index as usize) < self.verified.len() && !self.covered(index) {
                    self.peer_pending.insert(index);
                }
            }
            self.refill_peer_only(now);
            return;
        }
        if needed.is_empty() || self.finished {
            return;
        }
        // A one-piece object cannot have both a disjoint source prefix and
        // a peer probe. Keep its ordinary source instead of duplicating it.
        if self.exclusive_origin && !self.origin_started && needed.len() == 1 {
            self.queue_origin(
                now,
                PieceRange {
                    start: needed[0],
                    end: needed[0] + 1,
                },
            );
            return;
        }
        // A busy source starts on new work only after what it already has.
        let peers: Vec<Estimate> = self
            .lanes
            .iter()
            .filter(|(source, lane)| matches!(source, Source::Peer(_)) && !lane.retired)
            .map(|(_, lane)| {
                let mut estimate = lane.estimate;
                let backlog = (lane.finish_at - now as f64).max(0.0);
                // An untested peer keeps no first-byte time, so the plan
                // still falls back to the shared one.
                if backlog > 0.0 {
                    let first_byte = non_negative(estimate.first_byte_ms)
                        .or(non_negative(self.shared_first_byte_ms))
                        .unwrap_or(0.0);
                    estimate.first_byte_ms = Some(first_byte.max(backlog));
                }
                estimate
            })
            .collect();
        let origin = self.lanes.get(&Source::Origin).map(|lane| lane.estimate);
        let available_ms = self.floor_at() as f64 - now as f64;
        let input = PlanInput {
            size: self.size,
            needed,
            peers: &peers,
            origin,
            shared_first_byte_ms: self.shared_first_byte_ms,
            shared_rate: self.shared_rate,
            available_ms,
            max_holders: self.config.max_holders,
        };
        let mut planned = if self.probe_peers.is_empty() {
            plan(&input)
        } else {
            let mut at = 0;
            let mut assignments = Vec::new();
            let holder_limit = input.max_holders.max(1);
            for estimate in &peers {
                if at >= needed.len() || assignments.len() >= holder_limit {
                    break;
                }
                if self.probe_peers.contains(&estimate.source) && self.probe_available.remove(&estimate.source) {
                    let index = needed[at];
                    let bytes = piece_bytes(self.size, self.piece_size, index);
                    let (_, first_byte, rate) = resolve(&[*estimate], &input)[0];
                    assignments.push(Assignment {
                        source: estimate.source,
                        ranges: vec![PieceRange {
                            start: index,
                            end: index + 1,
                        }],
                        bytes,
                        projected_ms: first_byte + bytes as f64 / rate,
                    });
                    at += 1;
                }
            }
            let slots = holder_limit.saturating_sub(assignments.len());
            let normal: Vec<Estimate> = if slots == 0 {
                Vec::new()
            } else {
                peers
                    .iter()
                    .filter(|estimate| !self.probe_peers.contains(&estimate.source))
                    .copied()
                    .collect()
            };
            let tail = plan(&PlanInput {
                needed: &needed[at..],
                peers: &normal,
                max_holders: slots,
                ..input.clone()
            });
            assignments.extend(tail.assignments);
            let projected_ms = assignments.iter().map(|assignment| assignment.projected_ms).fold(0.0, f64::max);
            Plan {
                assignments,
                projected_ms,
                late: projected_ms > input.available_ms,
            }
        };
        self.late = planned.late;
        if planned.assignments.is_empty() {
            // No peer can take it: origin always can.
            planned.assignments.push(Assignment {
                source: Source::Origin,
                ranges: runs(needed),
                bytes: 0,
                projected_ms: 0.0,
            });
        }
        for assignment in planned.assignments {
            let source = assignment.source;
            let lane = self.lanes.entry(source).or_insert_with(|| {
                Lane::new(
                    Estimate {
                        source,
                        first_byte_ms: None,
                        rate: None,
                    },
                    now,
                )
            });
            lane.queue.extend(assignment.ranges);
            // A peer's projection already includes its backlog.
            lane.finish_at = lane.finish_at.max(now as f64 + assignment.projected_ms.max(0.0));
            self.issue(now, assignment.source);
        }
    }

    fn active_peer_only_holders(&self) -> usize {
        self.lanes
            .values()
            .filter(|lane| !lane.retired && (!lane.in_flight.is_empty() || !lane.queue.is_empty()))
            .count()
    }

    fn peer_only_endgame_source(&self) -> Option<Source> {
        if self.active_peer_only_holders() >= self.config.max_holders.max(1) {
            return None;
        }
        self.lanes
            .iter()
            .filter(|(source, lane)| {
                !lane.retired
                    && lane.in_flight.is_empty()
                    && lane.queue.is_empty()
                    && !self.probe_peers.contains(*source)
                    && positive(lane.estimate.rate).is_some()
            })
            .max_by(|a, b| {
                positive(a.1.estimate.rate)
                    .unwrap()
                    .total_cmp(&positive(b.1.estimate.rate).unwrap())
                    .then(b.0.cmp(a.0))
            })
            .map(|(source, _)| *source)
    }

    /// Refill only idle holders. Verified probes unlock ordinary bounded
    /// batches; the rest stays owned by this canonical-sized pending set.
    fn refill_peer_only(&mut self, now: u64) {
        if self.finished || !self.started {
            return;
        }
        if now >= self.floor_at() {
            self.floor_reached = true;
            return self.fail();
        }
        let pending = std::mem::take(&mut self.peer_pending);
        self.peer_pending = pending.into_iter().filter(|&index| !self.covered(index)).collect();
        if !self.lanes.values().any(|lane| !lane.retired) {
            return self.fail();
        }
        let slots = self.config.max_holders.max(1).saturating_sub(self.active_peer_only_holders());
        if slots == 0 || self.peer_pending.is_empty() {
            return;
        }
        let idle: Vec<Estimate> = self
            .lanes
            .iter()
            .filter(|(source, lane)| {
                !lane.retired
                    && lane.in_flight.is_empty()
                    && lane.queue.is_empty()
                    && !self.probe_peers.contains(*source)
                    && positive(lane.estimate.rate).is_some()
            })
            .map(|(_, lane)| lane.estimate)
            .collect();
        if !idle.is_empty() {
            let needed: Vec<u32> = self.peer_pending.iter().copied().collect();
            let planned = plan(&PlanInput {
                size: self.size,
                needed: &needed,
                peers: &idle,
                origin: None,
                shared_first_byte_ms: self.shared_first_byte_ms,
                shared_rate: self.shared_rate,
                available_ms: self.floor_at() as f64 - now as f64,
                max_holders: slots,
            });
            self.late = planned.late;
            for assignment in planned.assignments {
                let Some(lane) = self.lanes.get_mut(&assignment.source) else {
                    continue;
                };
                lane.finish_at = now as f64 + assignment.projected_ms.max(0.0);
                lane.queue.extend(assignment.ranges.iter().copied());
                for range in assignment.ranges {
                    for index in range.start..range.end {
                        self.peer_pending.remove(&index);
                    }
                }
                self.issue(now, assignment.source);
            }
        }
        let slots = self.config.max_holders.max(1).saturating_sub(self.active_peer_only_holders());
        let probes: Vec<Source> = self
            .lanes
            .iter()
            .filter(|(source, lane)| {
                !lane.retired && lane.in_flight.is_empty() && lane.queue.is_empty() && self.probe_available.contains(*source)
            })
            .map(|(source, _)| *source)
            .take(slots)
            .collect();
        for source in probes {
            let Some(index) = self.peer_pending.pop_first() else { break };
            self.probe_available.remove(&source);
            let estimate = self.lanes[&source].estimate;
            let first = non_negative(estimate.first_byte_ms)
                .or(non_negative(self.shared_first_byte_ms))
                .unwrap_or(0.0);
            let rate = positive(estimate.rate).or(positive(self.shared_rate)).unwrap_or(MIN_RATE);
            let projected = first + piece_bytes(self.size, self.piece_size, index) as f64 / rate;
            self.late |= projected > (self.floor_at() - now) as f64;
            if let Some(lane) = self.lanes.get_mut(&source) {
                lane.finish_at = now as f64 + projected;
                lane.queue.push_back(PieceRange {
                    start: index,
                    end: index + 1,
                });
            }
            self.issue(now, source);
        }
    }

    /// Send queued work: one bounded range to a peer, all of it to origin.
    fn issue(&mut self, now: u64, source: Source) {
        let peer_piece_cap = (MAX_PEER_REQUEST_BYTES / self.piece_size)
            .max(1)
            .min(u64::from(MAX_PEER_REQUEST_PIECES)) as u32;
        let origin_tail_cap = (MAX_PEER_REQUEST_BYTES / self.piece_size).min(u64::from(MAX_PEER_REQUEST_PIECES)) as u32;
        let hold_tail = self.exclusive_origin
            && source == Source::Origin
            && !self.origin_started
            && !self.floor_reached
            && self.probe_peers.iter().any(|source| {
                self.lanes
                    .get(source)
                    .is_some_and(|lane| !lane.retired && !lane.in_flight.is_empty())
            });
        let Some(lane) = self.lanes.get_mut(&source) else { return };
        if self.exclusive_origin && source == Source::Origin && !lane.in_flight.is_empty() {
            return;
        }
        let queued: u32 = lane.queue.iter().map(|range| range.end - range.start).sum();
        let mut source_prefix = if hold_tail {
            queued - origin_tail_cap.min(queued.saturating_sub(1))
        } else {
            queued
        };
        if source == Source::Origin && queued > 0 {
            self.origin_started = true;
        }
        while let Some(mut range) = lane.queue.front().copied() {
            if matches!(source, Source::Peer(_)) && !lane.in_flight.is_empty() {
                return;
            }
            if self.exclusive_origin && source == Source::Origin && source_prefix == 0 {
                return;
            }
            lane.queue.pop_front();
            if matches!(source, Source::Peer(_)) || self.exclusive_origin {
                let cap = if source == Source::Origin { source_prefix } else { peer_piece_cap };
                let end = range.start.saturating_add(cap).min(range.end);
                if end < range.end {
                    lane.queue.push_front(PieceRange {
                        start: end,
                        end: range.end,
                    });
                    range.end = end;
                }
            }
            if source == Source::Origin {
                source_prefix -= range.end - range.start;
            }
            lane.in_flight.push((range, now));
            lane.first_byte_at = None;
            lane.flow.clear();
            lane.checked_at = now;
            self.commands.push(match source {
                Source::Peer(peer) => Command::Request { peer, range },
                Source::Origin => Command::FetchOrigin { range },
            });
        }
    }

    /// Take a lane out of this object and return its unfinished pieces.
    fn retire(&mut self, source: Source) -> Vec<u32> {
        let Some(lane) = self.lanes.get_mut(&source) else {
            return Vec::new();
        };
        lane.retired = true;
        let ranges: Vec<PieceRange> = lane
            .in_flight
            .drain(..)
            .map(|(range, _)| range)
            .chain(lane.queue.drain(..))
            .collect();
        let mut pieces: Vec<u32> = ranges.into_iter().flat_map(|range| self.unverified(range)).collect();
        pieces.sort_unstable();
        pieces.dedup();
        // Pieces still in flight elsewhere need no second copy.
        pieces.retain(|index| !self.in_flight_elsewhere(*index, source));
        pieces
    }

    fn in_flight_elsewhere(&self, index: u32, except: Source) -> bool {
        self.lanes.iter().any(|(source, lane)| *source != except && lane.holds(index))
    }

    /// A ranged response from `source`. Bytes for a range not in flight
    /// there (late or cancelled) are ignored.
    pub fn delivered(&mut self, now: u64, source: Source, range: PieceRange, bytes: &[u8]) {
        if self.peer_only && now >= self.floor_at() {
            self.tick(now);
            return;
        }
        if self.finished {
            return;
        }
        let Some(lane) = self.lanes.get_mut(&source) else { return };
        let Some(position) = lane.in_flight.iter().position(|(sent, _)| *sent == range) else {
            return;
        };
        let (sent, first_byte_at) = (lane.in_flight[position].1, lane.first_byte_at);
        let (from, to) = self.piece_range_bytes(range);
        // A wrong length fails the source with this range still in flight,
        // so its pieces are reassigned.
        if bytes.len() != to - from {
            return self.failed(now, source);
        }
        if let Some(lane) = self.lanes.get_mut(&source) {
            lane.in_flight.remove(position);
        }
        let mut bad = false;
        let mut fresh = false;
        for index in range.start..range.end {
            let (start, end) = self.piece_range_bytes(PieceRange {
                start: index,
                end: index + 1,
            });
            let piece = &bytes[start - from..end - from];
            if self.verified[index as usize] {
                continue;
            }
            if <[u8; 32]>::from(Sha256::digest(piece)) == self.hashes[index as usize] {
                self.data[start..end].copy_from_slice(piece);
                self.verified[index as usize] = true;
                fresh = true;
            } else {
                bad = true;
            }
        }
        if bad {
            return self.bad_piece(now, source);
        }
        if fresh {
            self.probe_peers.remove(&source);
            self.probe_available.remove(&source);
        }
        self.measure(now, source, sent, first_byte_at, (to - from) as u64);
        self.drop_redundant(now, source);
        if self.verified.iter().all(|done| *done) {
            return self.finish();
        }
        self.issue(now, source);
        if self.peer_only {
            self.refill_peer_only(now);
        } else {
            self.rebalance_origin(now);
        }
    }

    /// An untested peer's first verified request gives it an estimate for
    /// the rest of this object: first byte, then rate after it.
    fn measure(&mut self, now: u64, source: Source, sent: u64, first_byte_at: Option<u64>, bytes: u64) {
        let shared_first_byte = non_negative(self.shared_first_byte_ms);
        let Some(lane) = self.lanes.get_mut(&source) else { return };
        if !matches!(source, Source::Peer(_)) || positive(lane.estimate.rate).is_some() {
            return;
        }
        let first_byte = first_byte_at.map_or(shared_first_byte.unwrap_or(0.0), |at| at.saturating_sub(sent) as f64);
        let streaming = (now as f64 - sent as f64 - first_byte).max(1.0);
        lane.estimate.first_byte_ms = Some(first_byte);
        lane.estimate.rate = Some(bytes as f64 / streaming);
    }

    /// Rule 9: origin's pieces not yet delivered go to idle measured peers
    /// that can finish them before origin is projected to, or by the floor
    /// once origin is behind. Origin's request keeps running and the first
    /// verified copy wins; when the peers cover the rest, the object is
    /// delivered and the shell aborts the origin fetch.
    fn rebalance_origin(&mut self, now: u64) {
        if self.finished || self.floor_reached {
            return;
        }
        let Some(origin) = self.lanes.get(&Source::Origin) else { return };
        // Exclusive mode moves only work whose HTTP request has not begun.
        // The initial source prefix continues without a second physical copy.
        let origin_ranges: Vec<PieceRange> = if self.exclusive_origin {
            origin.queue.iter().copied().collect()
        } else {
            origin
                .in_flight
                .iter()
                .map(|(range, _)| *range)
                .chain(origin.queue.iter().copied())
                .collect()
        };
        let mut owed: Vec<u32> = origin_ranges
            .into_iter()
            .flat_map(|range| range.start..range.end)
            .filter(|&index| !self.verified[index as usize])
            .collect();
        owed.sort_unstable();
        owed.dedup();
        let peers = || {
            self.lanes
                .iter()
                .filter(|(source, lane)| matches!(source, Source::Peer(_)) && !lane.retired)
                .map(|(_, lane)| lane)
        };
        let pending: Vec<u32> = owed
            .iter()
            .copied()
            .filter(|&index| !peers().any(|lane| lane.holds(index)))
            .collect();
        let is_idle = |lane: &Lane| {
            !self.probe_peers.contains(&lane.estimate.source)
                && lane.in_flight.is_empty()
                && lane.queue.is_empty()
                && positive(lane.estimate.rate).is_some()
        };
        let idle: Vec<Estimate> = peers().filter(|lane| is_idle(lane)).map(|lane| lane.estimate).collect();
        if pending.is_empty() || idle.is_empty() {
            return;
        }
        // Busy peers not yet working on origin's pieces will be idle soon:
        // leave them their share, so the first idle peer does not take all.
        let busy = peers()
            .filter(|lane| !is_idle(lane) && !owed.iter().any(|&index| lane.holds(index)))
            .count();
        let share = (pending.len() * idle.len()).div_ceil(idle.len() + busy);
        let floor = self.floor_at() as f64;
        let until = if origin.finish_at > now as f64 {
            origin.finish_at.min(floor)
        } else {
            floor
        };
        let available_ms = until - now as f64;
        if available_ms <= 0.0 {
            return;
        }
        let input = PlanInput {
            size: self.size,
            needed: &pending,
            peers: &idle,
            origin: None,
            shared_first_byte_ms: self.shared_first_byte_ms,
            shared_rate: self.shared_rate,
            available_ms,
            max_holders: idle.len(),
        };
        let peers = resolve(&idle, &input);
        // Only what the peers can finish in time, taken from origin's tail.
        let capacity: usize = peers
            .iter()
            .map(|(_, first_byte, rate)| ((available_ms - first_byte).max(0.0) * rate / self.piece_size as f64).floor() as usize)
            .sum();
        let take = capacity.min(share);
        if take == 0 {
            return;
        }
        let needed = &pending[pending.len() - take..];
        let planned = split(&PlanInput { needed, ..input.clone() }, &peers);
        if self.exclusive_origin {
            let claimed: BTreeSet<u32> = planned
                .assignments
                .iter()
                .flat_map(|assignment| assignment.ranges.iter().flat_map(|range| range.start..range.end))
                .collect();
            let origin = self.lanes.get_mut(&Source::Origin).unwrap();
            let remaining: Vec<u32> = origin
                .queue
                .iter()
                .flat_map(|range| range.start..range.end)
                .filter(|index| !claimed.contains(index))
                .collect();
            origin.queue = runs(&remaining).into();
        }
        for assignment in planned.assignments {
            let Some(lane) = self.lanes.get_mut(&assignment.source) else {
                continue;
            };
            lane.queue.extend(assignment.ranges);
            lane.finish_at = lane.finish_at.max(now as f64 + assignment.projected_ms.max(0.0));
            self.issue(now, assignment.source);
        }
    }

    fn bad_piece(&mut self, now: u64, source: Source) {
        match source {
            Source::Peer(peer) => {
                self.commands.push(Command::Ban { peer });
                let pieces = self.retire(source);
                let mut pieces = pieces;
                for index in 0..self.verified.len() as u32 {
                    if !self.verified[index as usize] && !self.covered(index) && !pieces.contains(&index) {
                        pieces.push(index);
                    }
                }
                pieces.sort_unstable();
                self.assign(now, &pieces);
            }
            // Origin bytes that fail the commitment cannot be repaired here.
            Source::Origin => self.fail(),
        }
    }

    /// The piece is verified, or queued or in flight on a live lane.
    fn covered(&self, index: u32) -> bool {
        self.verified[index as usize] || self.lanes.values().any(|lane| lane.holds(index))
    }

    /// Cancel peers whose in-flight range another source has now verified.
    fn drop_redundant(&mut self, now: u64, winner: Source) {
        let redundant: Vec<Source> = self
            .lanes
            .iter()
            .filter(|(source, lane)| {
                // Origin has no cancel, so its fetch keeps running and its
                // lane stays live.
                **source != winner
                    && matches!(source, Source::Peer(_))
                    && !lane.retired
                    && !lane.in_flight.is_empty()
                    && lane
                        .in_flight
                        .iter()
                        .all(|(range, _)| (range.start..range.end).all(|i| self.verified[i as usize]))
            })
            .map(|(source, _)| *source)
            .collect();
        for source in redundant {
            if let Source::Peer(peer) = source {
                self.commands.push(Command::Cancel { peer });
            }
            let pieces = self.retire(source);
            let pieces: Vec<u32> = pieces.into_iter().filter(|index| !self.covered(*index)).collect();
            self.assign(now, &pieces);
        }
    }

    /// `none`, timeout, close or a wrong length from `source`.
    pub fn failed(&mut self, now: u64, source: Source) {
        if self.finished {
            return;
        }
        if source == Source::Origin {
            if !self.peer_only {
                self.fail();
            }
            return;
        }
        if self.lanes.get(&source).is_none_or(|lane| lane.retired) {
            return;
        }
        let pieces = self.retire(source);
        let pieces: Vec<u32> = pieces.into_iter().filter(|index| !self.covered(*index)).collect();
        self.assign(now, &pieces);
        self.rebalance_origin(now);
    }

    pub fn tick(&mut self, now: u64) {
        if self.finished {
            return;
        }
        if self.peer_only {
            if now >= self.floor_at() {
                self.floor_reached = true;
                self.fail();
            } else {
                self.endgame(now);
            }
            return;
        }
        // Rule 6: no peer may hold a piece past the origin floor.
        if !self.floor_reached && now >= self.floor_at() {
            self.floor_reached = true;
            let late: Vec<Source> = self
                .lanes
                .iter()
                .filter(|(source, lane)| {
                    matches!(source, Source::Peer(_)) && !lane.retired && (!lane.in_flight.is_empty() || !lane.queue.is_empty())
                })
                .map(|(source, _)| *source)
                .collect();
            let mut pieces = Vec::new();
            for source in late {
                if let Source::Peer(peer) = source {
                    self.commands.push(Command::Cancel { peer });
                }
                pieces.extend(self.retire(source));
            }
            pieces.retain(|index| !self.covered(*index));
            pieces.sort_unstable();
            pieces.dedup();
            for range in runs(&pieces) {
                self.queue_origin(now, range);
            }
            return;
        }
        let watched: Vec<Source> = self
            .lanes
            .keys()
            .copied()
            .filter(|source| self.watch_at(*source).is_some())
            .collect();
        for source in watched {
            if self.finished {
                return;
            }
            if self.hopeless(now, source) {
                self.abandon(now, source);
            } else if let Some(lane) = self.lanes.get_mut(&source) {
                lane.checked_at = now;
            }
        }
        self.endgame(now);
        self.rebalance_origin(now);
    }

    fn queue_origin(&mut self, now: u64, range: PieceRange) {
        if self.peer_only {
            return self.fail();
        }
        let origin = Estimate {
            source: Source::Origin,
            first_byte_ms: None,
            rate: None,
        };
        let lane = self.lanes.entry(Source::Origin).or_insert_with(|| Lane::new(origin, now));
        lane.queue.push_back(range);
        self.issue(now, Source::Origin);
    }

    /// Rule 4: with at most two pieces left, a source behind its projection
    /// has them duplicated to the fastest idle source; the first verified
    /// copy wins.
    fn endgame(&mut self, now: u64) {
        let pieces = self.endgame_pieces();
        let behind = self
            .lanes
            .values()
            .any(|lane| !lane.in_flight.is_empty() && pieces.iter().any(|index| lane.holds(*index)) && now as f64 >= lane.finish_at);
        if pieces.is_empty() || !behind {
            return;
        }
        let idle = if self.peer_only {
            let Some(source) = self.peer_only_endgame_source() else { return };
            source
        } else {
            self.lanes
                .iter()
                .filter(|(source, lane)| {
                    matches!(source, Source::Peer(_)) && !lane.retired && lane.in_flight.is_empty() && lane.queue.is_empty()
                })
                .max_by(|a, b| {
                    let rate = |lane: &Lane| positive(lane.estimate.rate).unwrap_or(0.0);
                    rate(a.1).total_cmp(&rate(b.1)).then(b.0.cmp(a.0))
                })
                .map(|(source, _)| *source)
                .unwrap_or(Source::Origin)
        };
        self.duplicated.extend(pieces.iter().copied());
        for range in runs(&pieces) {
            match idle {
                Source::Origin => self.queue_origin(now, range),
                source => {
                    if let Some(lane) = self.lanes.get_mut(&source) {
                        lane.queue.push_back(range);
                    }
                    self.issue(now, source);
                }
            }
        }
    }

    fn finish(&mut self) {
        if <[u8; 32]>::from(Sha256::digest(&self.data)) != self.whole {
            return self.fail();
        }
        self.close_out();
        self.commands.push(Command::Deliver(std::mem::take(&mut self.data)));
    }

    fn fail(&mut self) {
        self.close_out();
        self.commands.push(Command::Fail);
    }

    /// End the transfer: cancel every peer still sending and clear the lanes.
    fn close_out(&mut self) {
        self.finished = true;
        self.peer_pending.clear();
        for (source, lane) in self.lanes.iter_mut() {
            if let (Source::Peer(peer), false) = (source, lane.in_flight.is_empty()) {
                self.commands.push(Command::Cancel { peer: *peer });
            }
            lane.in_flight.clear();
            lane.queue.clear();
        }
    }
}
