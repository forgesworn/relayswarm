//! Multi-holder scheduling for one schema 3 object (CORE-SPEC section 6).
//!
//! [`plan`] is a pure function: it splits the pieces still needed across
//! sources so that all are projected to finish together, and adds origin for
//! the tail when peers alone would be late. [`Transfer`] runs one object: it
//! issues ranged requests, verifies every piece against the signed
//! commitment, bans a holder that sends a bad piece, reassigns failed work,
//! hands outstanding pieces to origin at the deadline and duplicates the last
//! pieces of a lagging source. It delivers only a fully verified object.
//!
//! Nothing here is wired into the loader yet.

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
/// At most this many unverified pieces left starts the endgame.
pub const ENDGAME_PIECES: usize = 2;
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
    // Origin's own rate, or the peers' floor when it has none measured.
    let origin = resolve(&[origin], input)[0];
    peers.push(origin);
    split(input, &peers)
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
    /// The peer sent a piece that failed its hash: ban it for this object
    /// and charge it under the existing ban rules.
    Ban { peer: u64 },
    /// Every piece verified and the whole object matches.
    Deliver(Vec<u8>),
    /// The object cannot be completed here; fetch it whole from origin.
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
}

impl Lane {
    fn new(estimate: Estimate, now: u64) -> Self {
        Lane {
            estimate,
            queue: VecDeque::new(),
            in_flight: Vec::new(),
            finish_at: now as f64,
            retired: false,
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
    size: u64,
    piece_size: u64,
    hashes: Vec<[u8; 32]>,
    whole: [u8; 32],
    deadline: u64,
    data: Vec<u8>,
    verified: Vec<bool>,
    lanes: BTreeMap<Source, Lane>,
    shared_first_byte_ms: Option<f64>,
    shared_rate: Option<f64>,
    /// Pieces already duplicated by the endgame.
    duplicated: BTreeSet<u32>,
    floor_reached: bool,
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
            size,
            piece_size: commitment_piece_size(size as i64) as u64,
            hashes,
            whole: decode(sha256)?,
            deadline,
            data: vec![0; size as usize],
            verified: vec![false; count],
            lanes: BTreeMap::new(),
            shared_first_byte_ms: None,
            shared_rate: None,
            duplicated: BTreeSet::new(),
            floor_reached: false,
            finished: false,
            commands: Vec::new(),
        })
    }

    pub fn drain_commands(&mut self) -> Vec<Command> {
        std::mem::take(&mut self.commands)
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    /// Plan and issue the first requests. `peers` are the eligible holders;
    /// origin is always a source.
    pub fn start(&mut self, now: u64, peers: &[Estimate], origin: Estimate, shared_first_byte_ms: Option<f64>, shared_rate: Option<f64>) {
        self.shared_first_byte_ms = shared_first_byte_ms;
        self.shared_rate = shared_rate;
        for estimate in peers.iter().chain(std::iter::once(&origin)) {
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
        let floor = (!self.floor_reached).then(|| self.floor_at());
        // Lagging sources matter only once the endgame could act on them.
        let left = self.endgame_pieces();
        let lag = self
            .lanes
            .values()
            .filter(|lane| !lane.in_flight.is_empty() && left.iter().any(|index| lane.holds(*index)))
            .map(|lane| lane.finish_at.ceil() as u64);
        floor.into_iter().chain(lag).min()
    }

    /// Unverified pieces the endgame may still duplicate.
    fn endgame_pieces(&self) -> Vec<u32> {
        let left: Vec<u32> = (0..self.verified.len() as u32).filter(|&i| !self.verified[i as usize]).collect();
        if self.floor_reached || left.len() > ENDGAME_PIECES {
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
        if needed.is_empty() || self.finished {
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
                estimate.first_byte_ms = Some(estimate.first_byte_ms.unwrap_or(0.0).max(backlog));
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
        let mut planned = plan(&input);
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

    /// Send queued work: one range at a time to a peer, all of it to origin.
    fn issue(&mut self, now: u64, source: Source) {
        let Some(lane) = self.lanes.get_mut(&source) else { return };
        while let Some(range) = lane.queue.front().copied() {
            if matches!(source, Source::Peer(_)) && !lane.in_flight.is_empty() {
                return;
            }
            lane.queue.pop_front();
            lane.in_flight.push((range, now));
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
        if self.finished {
            return;
        }
        let Some(lane) = self.lanes.get_mut(&source) else { return };
        let Some(position) = lane.in_flight.iter().position(|(sent, _)| *sent == range) else {
            return;
        };
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
            } else {
                bad = true;
            }
        }
        if bad {
            return self.bad_piece(now, source);
        }
        self.drop_redundant(now, source);
        if self.verified.iter().all(|done| *done) {
            return self.finish();
        }
        self.issue(now, source);
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
                **source != winner
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
            return self.fail();
        }
        if self.lanes.get(&source).is_none_or(|lane| lane.retired) {
            return;
        }
        let pieces = self.retire(source);
        let pieces: Vec<u32> = pieces.into_iter().filter(|index| !self.covered(*index)).collect();
        self.assign(now, &pieces);
    }

    pub fn tick(&mut self, now: u64) {
        if self.finished {
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
        self.endgame(now);
    }

    fn queue_origin(&mut self, now: u64, range: PieceRange) {
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
        let idle = self
            .lanes
            .iter()
            .filter(|(source, lane)| {
                matches!(source, Source::Peer(_)) && !lane.retired && lane.in_flight.is_empty() && lane.queue.is_empty()
            })
            .max_by(|a, b| {
                let rate = |lane: &Lane| positive(lane.estimate.rate).unwrap_or(0.0);
                rate(a.1).total_cmp(&rate(b.1)).then(b.0.cmp(a.0))
            })
            .map(|(source, _)| *source)
            .unwrap_or(Source::Origin);
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
        self.finished = true;
        for (source, lane) in self.lanes.iter_mut() {
            if let (Source::Peer(peer), false) = (source, lane.in_flight.is_empty()) {
                self.commands.push(Command::Cancel { peer: *peer });
            }
            lane.in_flight.clear();
            lane.queue.clear();
        }
        self.commands.push(Command::Deliver(std::mem::take(&mut self.data)));
    }

    fn fail(&mut self) {
        self.finished = true;
        for (source, lane) in self.lanes.iter_mut() {
            if let (Source::Peer(peer), false) = (source, lane.in_flight.is_empty()) {
                self.commands.push(Command::Cancel { peer: *peer });
            }
            lane.in_flight.clear();
            lane.queue.clear();
        }
        self.commands.push(Command::Fail);
    }
}
