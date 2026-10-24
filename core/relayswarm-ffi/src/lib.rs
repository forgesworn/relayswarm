//! UniFFI bindings for the RelaySwarm core, so Swift and Kotlin shells call the
//! same verification and scheduling as the browser's WebAssembly module.
//!
//! Signed events and the verifier's trust options cross as JSON text, in the
//! shapes `segment-commitment.mjs` takes, because shells already hold them as
//! Nostr JSON. Scheduler inputs and commands cross as typed records. Like the
//! core, nothing here reads a clock or performs I/O: the shell passes the time.

use relayswarm_proto::commitment::{self, FragmentContext, Trust};
use relayswarm_proto::discovery::{self, AttemptId, ContextId, MediaType};
use relayswarm_proto::link::{self, LinkConfig};
use relayswarm_proto::pieces::{self, PieceRange};
use relayswarm_proto::scheduler::{self, Command, Estimate, Source, TransferConfig};
use relayswarm_proto::selection;
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex, MutexGuard};

uniffi::setup_scaffolding!();

pub const DEFAULT_MAX_HOLDERS: u32 = scheduler::DEFAULT_MAX_HOLDERS as u32;
pub const DEFAULT_ORIGIN_RESERVE_MS: f64 = scheduler::DEFAULT_ORIGIN_RESERVE_MS;

#[derive(Debug, uniffi::Error)]
pub enum CoreError {
    /// The piece list does not fit the object size, or a digest is not hex.
    InvalidTransfer,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::InvalidTransfer => f.write_str("invalid transfer"),
        }
    }
}

impl std::error::Error for CoreError {}

// Commitment verification. `None` is rejection, as `null` is in JavaScript.

fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// A missing list is empty. Any other non-array fails the JavaScript
/// `Array.isArray` check, which only a delegated commitment reaches; 257
/// entries fails the same check in the core at the same point.
fn list(options: &Value, name: &str) -> Vec<Value> {
    match options.get(name) {
        None => Vec::new(),
        Some(Value::Array(values)) => values.clone(),
        Some(_) => vec![Value::Null; 257],
    }
}

fn content(value: Option<Map<String, Value>>) -> Option<String> {
    value.map(|content| Value::Object(content).to_string())
}

fn with_trust<T>(options: &Value, run: impl FnOnce(&Trust) -> Option<T>) -> Option<T> {
    let (revoked, revocations) = (list(options, "revokedDelegationIds"), list(options, "delegationRevocations"));
    let trust = Trust {
        stream_event: &options["streamEvent"],
        swarm_id: options["swarmId"].as_str()?,
        revoked_delegation_ids: &revoked,
        delegation_revocations: &revocations,
    };
    run(&trust)
}

/// `validStreamAuthorisation(event)`.
#[uniffi::export]
pub fn valid_stream_authorisation(event_json: String) -> bool {
    parse(&event_json).is_some_and(|event| commitment::valid_stream_authorisation(&event))
}

/// `verifyCommitmentDelegation(event, options, atMs)`: the delegation content
/// as JSON, or `None`. `options` carries `streamEvent`, `swarmId` and the
/// optional revocation lists.
#[uniffi::export]
pub fn verify_commitment_delegation(event_json: String, options_json: String, at_ms: i64) -> Option<String> {
    let (event, options) = (parse(&event_json)?, parse(&options_json)?);
    with_trust(&options, |trust| {
        content(commitment::verify_commitment_delegation(Some(&event), trust, at_ms))
    })
}

/// `value` with `names` first, in that order, then any other keys as given.
fn ordered(value: &Value, names: &[&str], inner: impl Fn(&str, &Value) -> Value) -> Value {
    let Value::Object(object) = value else { return value.clone() };
    let mut out = Map::new();
    for name in names {
        if let Some(field) = object.get(*name) {
            out.insert((*name).to_owned(), inner(name, field));
        }
    }
    for (name, field) in object {
        if !out.contains_key(name) {
            out.insert(name.clone(), field.clone());
        }
    }
    Value::Object(out)
}

/// The core compares `encryption` as `JSON.stringify` text, as the loader
/// does. The loader always builds the context in one key order; a Swift or
/// Kotlin host serialising a dictionary may not, so the facade restores it.
fn canonical_media(media: &Value) -> Value {
    ordered(media, &["playlist", "mediaType", "encryption"], |name, field| {
        if name == "encryption" {
            ordered(field, &["method", "keyPath", "iv", "keyFormat"], |_, value| value.clone())
        } else {
            field.clone()
        }
    })
}

/// `verifySegmentCommitment(event, options, atMs)`: the commitment content as
/// JSON, or `None`. Besides the trust inputs, `options` carries `key`,
/// `maxSegmentBytes`, an optional `delegation` event and the reduced fragment
/// `context` (`sequence`, `discontinuity`, `part`, `level`, `fragType`,
/// `decryptMethod`, `media`). The caller still checks the received bytes
/// against the content's `sha256` and `size`.
#[uniffi::export]
pub fn verify_segment_commitment(event_json: String, options_json: String, at_ms: i64) -> Option<String> {
    let (event, options) = (parse(&event_json)?, parse(&options_json)?);
    let context = &options["context"];
    let field = |name: &str| context.get(name).cloned().unwrap_or(Value::Null);
    let context = FragmentContext {
        sequence: field("sequence"),
        discontinuity: field("discontinuity"),
        part: field("part"),
        level: context["level"].as_str()?.to_owned(),
        frag_type: field("fragType"),
        decrypt_method: field("decryptMethod"),
        media: context.get("media").filter(|media| !media.is_null()).map(canonical_media),
    };
    let delegation = options.get("delegation").filter(|delegation| !delegation.is_null());
    with_trust(&options, |trust| {
        content(commitment::verify_segment_commitment(
            &event,
            trust,
            options["key"].as_str()?,
            &context,
            &options["maxSegmentBytes"],
            delegation,
            at_ms,
        ))
    })
}

// Schema 3 pieces.

/// Pieces `start..end`, end exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PieceSpan {
    pub start: u32,
    pub end: u32,
}

impl From<PieceSpan> for PieceRange {
    fn from(span: PieceSpan) -> Self {
        PieceRange {
            start: span.start,
            end: span.end,
        }
    }
}

impl From<PieceRange> for PieceSpan {
    fn from(range: PieceRange) -> Self {
        PieceSpan {
            start: range.start,
            end: range.end,
        }
    }
}

/// Byte offsets `from..to`, end exclusive, for an HTTP `Range` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ByteSpan {
    pub from: u64,
    pub to: u64,
}

/// The schema 3 piece size for an object of `size` bytes.
#[uniffi::export]
pub fn commitment_piece_size(size: u64) -> u64 {
    commitment::commitment_piece_size(size.min(i64::MAX as u64) as i64) as u64
}

/// The number of pieces in an object of `size` bytes, or `None` when empty.
#[uniffi::export]
pub fn piece_count(size: u64) -> Option<u32> {
    pieces::piece_count(size)
}

/// The bytes `span` covers in an object of `size` bytes, or `None` when the
/// span is empty or runs past the last piece.
#[uniffi::export]
pub fn piece_span_bytes(size: u64, span: PieceSpan) -> Option<ByteSpan> {
    pieces::range_bytes(size, span.into()).map(|(from, to)| ByteSpan { from, to })
}

// The multi-holder transfer scheduler.

/// Where pieces come from. `peer` is the shell's own link handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TransferSource {
    Peer { peer: u64 },
    Origin,
}

impl From<TransferSource> for Source {
    fn from(source: TransferSource) -> Self {
        match source {
            TransferSource::Peer { peer } => Source::Peer(peer),
            TransferSource::Origin => Source::Origin,
        }
    }
}

/// Known timing for one source. `rate` is payload bytes per millisecond after
/// the first byte; `None` means untested.
#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct Timing {
    pub first_byte_ms: Option<f64>,
    pub rate: Option<f64>,
}

/// An eligible holder: open, framing 2, holding the object, not banned.
#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct PeerTiming {
    pub peer: u64,
    pub timing: Timing,
}

/// Settings for one transfer.
#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct TransferSettings {
    pub max_holders: u32,
    pub origin_reserve_ms: f64,
}

/// The core's defaults, which the browser loader uses too. UniFFI does not
/// export constants, so bindings read them here.
#[uniffi::export]
pub fn default_transfer_settings() -> TransferSettings {
    TransferSettings {
        max_holders: DEFAULT_MAX_HOLDERS,
        origin_reserve_ms: DEFAULT_ORIGIN_RESERVE_MS,
    }
}

/// What the shell must do, in order.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TransferCommand {
    /// Send a framing 2 `want` for these pieces on this peer's link.
    Request { peer: u64, span: PieceSpan },
    /// Fetch these pieces from origin with an HTTP `Range` request.
    FetchOrigin { span: PieceSpan },
    /// Abort the peer's request for this object.
    Cancel { peer: u64 },
    /// As `Cancel`, for a hopeless request; the shell may count it abandoned.
    Abandon { peer: u64 },
    /// A piece failed its hash: ban the peer for this object.
    Ban { peer: u64 },
    /// The whole object, every piece and the whole digest verified. The shell
    /// aborts any origin fetch still running.
    Deliver { bytes: Vec<u8> },
    /// Fetch the object whole from origin; abort any origin range fetch.
    Fail,
}

impl From<Command> for TransferCommand {
    fn from(command: Command) -> Self {
        match command {
            Command::Request { peer, range } => TransferCommand::Request { peer, span: range.into() },
            Command::FetchOrigin { range } => TransferCommand::FetchOrigin { span: range.into() },
            Command::Cancel { peer } => TransferCommand::Cancel { peer },
            Command::Abandon { peer } => TransferCommand::Abandon { peer },
            Command::Ban { peer } => TransferCommand::Ban { peer },
            Command::Deliver(bytes) => TransferCommand::Deliver { bytes },
            Command::Fail => TransferCommand::Fail,
        }
    }
}

/// The commands from one call, and when to call `tick` next.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct TransferState {
    pub commands: Vec<TransferCommand>,
    pub next_deadline: Option<u64>,
    pub late: bool,
    pub finished: bool,
    /// Bytes of the object verified so far, each piece counted once.
    pub verified_bytes: u64,
}

/// One object fetched from several holders and origin, piece by piece. Every
/// method takes the shell's current time in milliseconds.
#[derive(uniffi::Object)]
pub struct Transfer {
    inner: Mutex<scheduler::Transfer>,
}

impl Transfer {
    fn lock(&self) -> MutexGuard<'_, scheduler::Transfer> {
        // A panic cannot leave the scheduler half-updated in a way a shell
        // could observe differently, so a poisoned lock is still usable.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state(transfer: &mut scheduler::Transfer) -> TransferState {
        TransferState {
            commands: transfer.drain_commands().into_iter().map(Into::into).collect(),
            next_deadline: transfer.next_deadline(),
            late: transfer.late(),
            finished: transfer.finished(),
            verified_bytes: transfer.verified_bytes(),
        }
    }
}

#[uniffi::export]
impl Transfer {
    /// A transfer of `size` bytes committed to `sha256` and the schema 3
    /// `pieces` (already verified), due at `deadline`.
    #[uniffi::constructor]
    pub fn new(settings: TransferSettings, size: u64, sha256: String, pieces: Vec<String>, deadline: u64) -> Result<Arc<Self>, CoreError> {
        let config = TransferConfig {
            max_holders: (settings.max_holders as usize).max(1),
            origin_reserve_ms: if settings.origin_reserve_ms.is_finite() {
                settings.origin_reserve_ms.max(0.0)
            } else {
                0.0
            },
        };
        let pieces: Vec<&str> = pieces.iter().map(String::as_str).collect();
        let transfer = scheduler::Transfer::new(config, size, &sha256, &pieces, deadline).ok_or(CoreError::InvalidTransfer)?;
        Ok(Arc::new(Transfer {
            inner: Mutex::new(transfer),
        }))
    }

    /// Plan and issue the first requests. `shared` is the swarm-wide estimate
    /// used for untested peers.
    pub fn start(&self, now: u64, peers: Vec<PeerTiming>, origin: Timing, shared: Timing) -> TransferState {
        let peers: Vec<Estimate> = peers
            .iter()
            .map(|peer| Estimate {
                source: Source::Peer(peer.peer),
                first_byte_ms: peer.timing.first_byte_ms,
                rate: peer.timing.rate,
            })
            .collect();
        let origin = Estimate {
            source: Source::Origin,
            first_byte_ms: origin.first_byte_ms,
            rate: origin.rate,
        };
        let mut transfer = self.lock();
        transfer.start(now, &peers, origin, shared.first_byte_ms, shared.rate);
        Self::state(&mut transfer)
    }

    /// `received` bytes of the source's current request have arrived.
    pub fn progress(&self, now: u64, source: TransferSource, received: u64) -> TransferState {
        let mut transfer = self.lock();
        transfer.progress(now, source.into(), received);
        Self::state(&mut transfer)
    }

    /// The source answered `span` with `bytes`, which the core verifies.
    pub fn delivered(&self, now: u64, source: TransferSource, span: PieceSpan, bytes: Vec<u8>) -> TransferState {
        let mut transfer = self.lock();
        transfer.delivered(now, source.into(), span.into(), &bytes);
        Self::state(&mut transfer)
    }

    /// The source's current request failed or its link closed.
    pub fn failed(&self, now: u64, source: TransferSource) -> TransferState {
        let mut transfer = self.lock();
        transfer.failed(now, source.into());
        Self::state(&mut transfer)
    }

    /// The time from the last state's `next_deadline` has come.
    pub fn tick(&self, now: u64) -> TransferState {
        let mut transfer = self.lock();
        transfer.tick(now);
        Self::state(&mut transfer)
    }
}

// One peer link: the data channel protocol between two viewers.

/// The link's fixed sizes. The shell sets its channel's low-water threshold
/// to `low_water_bytes`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LinkLimits {
    pub chunk_bytes: u64,
    pub high_water_bytes: u64,
    pub low_water_bytes: u64,
    pub max_have_keys: u32,
}

#[uniffi::export]
pub fn link_limits() -> LinkLimits {
    LinkLimits {
        chunk_bytes: link::CHUNK_BYTES as u64,
        high_water_bytes: link::HIGH_WATER_BYTES,
        low_water_bytes: link::LOW_WATER_BYTES,
        max_have_keys: link::MAX_HAVE_KEYS as u32,
    }
}

/// Settings for one link.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LinkSettings {
    pub max_segment_bytes: u64,
    pub max_queued_requests: u32,
    pub drain_timeout_ms: u64,
    /// Ordered, fully reliable channel: an abandoned response may be drained.
    pub reliable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RequestOutcome {
    Payload,
    None,
    Timeout,
    Abort,
    Abandoned,
    Closed,
    Busy,
    SendError,
}

impl From<link::Outcome> for RequestOutcome {
    fn from(outcome: link::Outcome) -> Self {
        match outcome {
            link::Outcome::Payload => RequestOutcome::Payload,
            link::Outcome::None => RequestOutcome::None,
            link::Outcome::Timeout => RequestOutcome::Timeout,
            link::Outcome::Abort => RequestOutcome::Abort,
            link::Outcome::Abandoned => RequestOutcome::Abandoned,
            link::Outcome::Closed => RequestOutcome::Closed,
            link::Outcome::Busy => RequestOutcome::Busy,
            link::Outcome::SendError => RequestOutcome::SendError,
        }
    }
}

/// The logical result of one request, reported once.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RequestReport {
    pub id: Option<u64>,
    pub outcome: RequestOutcome,
    pub received_bytes: u64,
    pub metadata_received: bool,
    pub draining: bool,
    pub close_reason: Option<String>,
}

/// What the shell must do or learn, in order.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PeerLinkEvent {
    /// Send this text frame on the channel.
    SendText {
        text: String,
    },
    /// Send this binary frame on the channel.
    SendBinary {
        bytes: Vec<u8>,
    },
    /// The link closed; close the channel and connection.
    Closed {
        reason: String,
    },
    Report {
        report: RequestReport,
    },
    /// The request's bytes, or `None`. Resolved once, possibly before the
    /// link finishes draining the response. The shell hashes them.
    Resolved {
        id: Option<u64>,
        bytes: Option<Vec<u8>>,
    },
    HaveChanged {
        keys: Vec<String>,
    },
    ScheduleChanged,
    /// The remote wants this key; answer with `serve_response`.
    ServeRequest {
        key: String,
    },
    /// The remote wants these pieces of this key. Answer with the whole held
    /// object; the link sends only the span. Charge the span's bytes against
    /// upload allowances.
    ServeRange {
        key: String,
        span: PieceSpan,
    },
    UploadCancelled {
        bytes: u64,
    },
    Progress {
        received: u64,
        size: u64,
    },
}

impl From<link::LinkEvent> for PeerLinkEvent {
    fn from(event: link::LinkEvent) -> Self {
        use link::LinkEvent as E;
        match event {
            E::SendText(text) => PeerLinkEvent::SendText { text },
            E::SendBinary(bytes) => PeerLinkEvent::SendBinary { bytes },
            E::Closed(reason) => PeerLinkEvent::Closed { reason: reason.to_owned() },
            E::Report(report) => PeerLinkEvent::Report {
                report: RequestReport {
                    id: report.id,
                    outcome: report.outcome.into(),
                    received_bytes: report.received_bytes,
                    metadata_received: report.metadata_received,
                    draining: report.draining,
                    close_reason: report.close_reason.map(str::to_owned),
                },
            },
            E::Resolved { id, bytes } => PeerLinkEvent::Resolved { id, bytes },
            E::HaveChanged(keys) => PeerLinkEvent::HaveChanged { keys },
            E::ScheduleChanged => PeerLinkEvent::ScheduleChanged,
            E::ServeRequest(key) => PeerLinkEvent::ServeRequest { key },
            E::ServeRange { key, range } => PeerLinkEvent::ServeRange { key, span: range.into() },
            E::UploadCancelled(bytes) => PeerLinkEvent::UploadCancelled { bytes },
            E::Progress { received, size } => PeerLinkEvent::Progress { received, size },
        }
    }
}

/// The events from one call, the request ID `request`/`request_range`
/// assigned, and the link's scalar state. When `version` changes, read
/// `sets` again.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LinkUpdate {
    pub events: Vec<PeerLinkEvent>,
    pub request_id: Option<u64>,
    pub version: u64,
    pub closed: bool,
    pub busy: bool,
    pub transferring: bool,
    pub outbound_in_flight: u32,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub opened_at: u64,
    pub last_served_at: u64,
    pub last_delivered_at: u64,
    pub next_deadline: Option<u64>,
    pub upload_waiting: bool,
}

/// A key with the time it was announced or expires.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TimedKey {
    pub key: String,
    pub at: u64,
}

/// What the remote has announced.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LinkSets {
    pub have: Vec<String>,
    /// Keys the remote is fetching, with each lease's expiry.
    pub fetching: Vec<TimedKey>,
    /// Renditions the remote plays, with when each was last announced.
    pub renditions: Vec<TimedKey>,
    pub serving: bool,
    pub rendition: Option<String>,
    pub contribution_at: u64,
    pub close_reason: Option<String>,
}

fn timed<'a>(entries: impl IntoIterator<Item = (&'a String, &'a u64)>) -> Vec<TimedKey> {
    entries
        .into_iter()
        .map(|(key, at)| TimedKey { key: key.clone(), at: *at })
        .collect()
}

/// One data channel between two viewers. Every method that takes `now` takes
/// the shell's current time in milliseconds; call `tick` at `next_deadline`.
#[derive(uniffi::Object)]
pub struct PeerLink {
    inner: Mutex<link::Link>,
}

impl PeerLink {
    fn lock(&self) -> MutexGuard<'_, link::Link> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn run(&self, apply: impl FnOnce(&mut link::Link) -> Option<u64>) -> LinkUpdate {
        let mut link = self.lock();
        let request_id = apply(&mut link);
        LinkUpdate {
            events: link.drain_events().into_iter().map(Into::into).collect(),
            request_id,
            version: link.version(),
            closed: link.closed(),
            busy: link.busy(),
            transferring: link.transferring(),
            outbound_in_flight: link.outbound_in_flight() as u32,
            bytes_in: link.bytes_in(),
            bytes_out: link.bytes_out(),
            opened_at: link.opened_at(),
            last_served_at: link.last_served_at(),
            last_delivered_at: link.last_delivered_at(),
            next_deadline: link.next_deadline(),
            upload_waiting: link.upload_waiting(),
        }
    }
}

#[uniffi::export]
impl PeerLink {
    #[uniffi::constructor]
    pub fn new(settings: LinkSettings, now: u64) -> Arc<Self> {
        let config = LinkConfig {
            max_segment_bytes: settings.max_segment_bytes,
            max_queued_requests: settings.max_queued_requests as usize,
            drain_timeout_ms: settings.drain_timeout_ms,
            reliable: settings.reliable,
        };
        Arc::new(PeerLink {
            inner: Mutex::new(link::Link::new(config, now)),
        })
    }

    /// Whether the channel is open. A closed or closing channel sends
    /// nothing and cannot drain an abandoned response. Starts open.
    pub fn set_channel_open(&self, open: bool) {
        self.lock().set_channel_open(open);
    }

    /// Whether the channel is ordered and fully reliable.
    pub fn set_reliable(&self, reliable: bool) {
        self.lock().set_reliable(reliable);
    }

    /// The channel's `bufferedAmount`, before `serve_response`.
    pub fn observe_buffered(&self, buffered: u64) {
        self.lock().observe_buffered(buffered);
    }

    /// The remote's announcements; read again when `version` changes.
    pub fn sets(&self) -> LinkSets {
        let link = self.lock();
        let (serving, rendition, contribution_at) = link.contribution();
        LinkSets {
            have: link.have().iter().cloned().collect(),
            fetching: timed(link.fetching()),
            renditions: timed(link.renditions()),
            serving,
            rendition: rendition.map(str::to_owned),
            contribution_at,
            close_reason: link.close_reason().map(str::to_owned),
        }
    }

    /// The current state, with any events not yet taken.
    pub fn state(&self) -> LinkUpdate {
        self.run(|_| None)
    }

    pub fn handle_text(&self, now: u64, text: String) -> LinkUpdate {
        self.run(|link| {
            link.handle_text(now, &text);
            None
        })
    }

    pub fn handle_binary(&self, now: u64, chunk: Vec<u8>) -> LinkUpdate {
        self.run(|link| {
            link.handle_binary(now, &chunk);
            None
        })
    }

    /// Ask for the whole object `key`; `request_id` is `None` when refused.
    pub fn request(&self, now: u64, key: String, timeout_ms: u64, expected_size: Option<u64>) -> LinkUpdate {
        self.run(|link| link.request(now, &key, timeout_ms, expected_size))
    }

    /// Framing 2: ask for pieces `span` of `key`, an object of `object_size`
    /// bytes. Send only to a holder that advertised framing 2.
    pub fn request_range(&self, now: u64, key: String, timeout_ms: u64, span: PieceSpan, object_size: u64) -> LinkUpdate {
        self.run(|link| link.request_range(now, &key, timeout_ms, span.into(), object_size))
    }

    /// Abort request `id`; `abandoned` when it was hopeless rather than unwanted.
    pub fn abort(&self, now: u64, id: u64, abandoned: bool) -> LinkUpdate {
        self.run(|link| {
            link.abort(now, id, abandoned);
            None
        })
    }

    /// Close the link with one of the known reasons; others close as `host`.
    /// Not `close`: Kotlin bindings already have `close()`, which frees the
    /// object.
    pub fn close_link(&self, reason: String) -> LinkUpdate {
        self.run(|link| {
            link.close(&reason);
            None
        })
    }

    pub fn tick(&self, now: u64) -> LinkUpdate {
        self.run(|link| {
            link.tick(now);
            None
        })
    }

    /// Answer the oldest `ServeRequest` or `ServeRange` with the held
    /// object, or `None` when it is no longer held.
    pub fn serve_response(&self, now: u64, bytes: Option<Vec<u8>>) -> LinkUpdate {
        self.run(|link| {
            link.serve_response(now, bytes);
            None
        })
    }

    /// The channel's `bufferedamountlow` fired with `buffered` bytes queued.
    pub fn buffered_amount_low(&self, now: u64, buffered: u64) -> LinkUpdate {
        self.run(|link| {
            link.buffered_amount_low(now, buffered);
            None
        })
    }

    pub fn send_have(&self, keys: Vec<String>) -> LinkUpdate {
        self.run(|link| {
            link.send_have(&keys);
            None
        })
    }

    pub fn send_have_change(&self, add: Vec<String>, del: Vec<String>) -> LinkUpdate {
        self.run(|link| {
            link.send_have_change(&add, &del);
            None
        })
    }

    pub fn send_contribution(&self, serving: bool, rendition: Option<String>) -> LinkUpdate {
        self.run(|link| {
            link.send_contribution(serving, rendition.as_deref());
            None
        })
    }

    /// Announce that this viewer is fetching `key`, for `lease_ms`.
    pub fn send_fetching(&self, key: String, lease_ms: u64) -> LinkUpdate {
        self.run(|link| {
            link.send_fetching(&key, lease_ms);
            None
        })
    }
}

// Peer selection. Links are the shell's own numeric handles; a reconnected
// peer takes a new handle and starts without history.

/// One link as selection sees it at the moment of choice.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SelectableLink {
    pub id: u64,
    pub pubkey: String,
    pub closed: bool,
    pub busy: bool,
    /// The link advertises the requested key.
    pub has_key: bool,
}

/// One link's measured history.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LinkObservation {
    pub attempts: u32,
    pub latency_ms: Option<f64>,
    pub throughput_bytes_per_second: Option<f64>,
    pub failure_rate: f64,
    pub consecutive_failures: u32,
    pub last_selected: u64,
}

impl From<selection::Observation> for LinkObservation {
    fn from(value: selection::Observation) -> Self {
        LinkObservation {
            attempts: value.attempts,
            latency_ms: value.latency_ms,
            throughput_bytes_per_second: value.throughput_bytes_per_second,
            failure_rate: value.failure_rate,
            consecutive_failures: value.consecutive_failures,
            last_selected: value.last_selected,
        }
    }
}

/// Chooses which link to ask for a segment, from shared and per-link
/// measurements, as `peer-selection.mjs` does. One per swarm.
#[derive(uniffi::Object)]
pub struct PeerSelection {
    inner: Mutex<selection::PeerSelection>,
}

impl PeerSelection {
    fn lock(&self) -> MutexGuard<'_, selection::PeerSelection> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[uniffi::export]
impl PeerSelection {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(PeerSelection {
            inner: Mutex::new(selection::PeerSelection::new()),
        })
    }

    /// One attempt's timing: first byte in milliseconds, then a rate as
    /// bytes over milliseconds from the latest part of its flow, and how long
    /// the whole flow ran (`None` means `flow_ms`).
    pub fn observe(&self, now: u64, first_byte_ms: Option<f64>, bytes: f64, flow_ms: f64, total_flow_ms: Option<f64>) {
        self.lock().observe(now, first_byte_ms, bytes, flow_ms, total_flow_ms);
    }

    /// One attempt on `link`: `bytes` delivered, 0 for a failure.
    pub fn record(&self, now: u64, link: u64, elapsed_ms: f64, bytes: f64) {
        self.lock().record(now, link, elapsed_ms, bytes);
    }

    /// Drop a closed link's history.
    pub fn forget(&self, link: u64) {
        self.lock().forget(link);
    }

    /// Choose a link for a key of `size` bytes, or `None`. `tried` holds
    /// pubkeys already asked for this key; `deadline_ms` may be infinite.
    pub fn select(&self, links: Vec<SelectableLink>, tried: Vec<String>, size: f64, deadline_ms: f64) -> Option<u64> {
        let views: Vec<selection::LinkView> = links
            .iter()
            .map(|link| selection::LinkView {
                id: link.id,
                pubkey: &link.pubkey,
                closed: link.closed,
                busy: link.busy,
                has_key: link.has_key,
            })
            .collect();
        let tried: Vec<&str> = tried.iter().map(String::as_str).collect();
        self.lock().select(&views, &tried, size, deadline_ms)
    }

    pub fn first_byte_ms(&self) -> Option<f64> {
        self.lock().first_byte_ms()
    }

    /// Shared bytes per millisecond.
    pub fn rate(&self) -> Option<f64> {
        self.lock().rate()
    }

    pub fn project_ms(&self, size: f64) -> Option<f64> {
        self.lock().project_ms(size)
    }

    pub fn minimum_ms(&self, size: f64) -> f64 {
        self.lock().minimum_ms(size)
    }

    pub fn last_observed_at(&self) -> u64 {
        self.lock().last_observed_at()
    }

    pub fn turn(&self) -> u32 {
        self.lock().turn()
    }

    pub fn order(&self) -> u64 {
        self.lock().order()
    }

    pub fn summary(&self, link: u64) -> LinkObservation {
        self.lock().summary(link).into()
    }

    pub fn estimate(&self, link: u64, size: f64) -> Option<f64> {
        self.lock().estimate(link, size)
    }
}

// Neighbour discovery. Media types arrive as the strings HLS uses; any type
// other than "main" or "audio" has no context, as in JavaScript. Contexts and
// attempts are numeric IDs where the JavaScript compares object identity.

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum DiscoveryMedia {
    Main,
    Audio,
}

impl From<MediaType> for DiscoveryMedia {
    fn from(value: MediaType) -> Self {
        match value {
            MediaType::Main => DiscoveryMedia::Main,
            MediaType::Audio => DiscoveryMedia::Audio,
        }
    }
}

/// A holder that has missed keys in one context.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DiscoveryHolder {
    pub pubkey: String,
    pub first_miss_at: u64,
    pub misses: u32,
    pub last_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DiscoveryContext {
    pub id: u64,
    pub media_type: DiscoveryMedia,
    pub rendition: String,
    pub keys: Vec<String>,
    pub last_demand_at: Option<u64>,
    pub activity_at: u64,
    /// The context's one replacement is spent until a verified segment.
    pub spent: bool,
    /// In the order of their first miss.
    pub holders: Vec<DiscoveryHolder>,
}

impl From<&discovery::Context> for DiscoveryContext {
    fn from(value: &discovery::Context) -> Self {
        DiscoveryContext {
            id: value.id.value(),
            media_type: value.media_type.into(),
            rendition: value.rendition.clone(),
            keys: value.keys.clone(),
            last_demand_at: value.last_demand_at,
            activity_at: value.activity_at,
            spent: value.spent,
            holders: value
                .holders
                .iter()
                .map(|(pubkey, holder)| DiscoveryHolder {
                    pubkey: pubkey.clone(),
                    first_miss_at: holder.first_miss_at,
                    misses: holder.misses,
                    last_key: holder.last_key.clone(),
                })
                .collect(),
        }
    }
}

/// A peer's latest hint.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DiscoveryCandidate {
    pub pubkey: String,
    pub have: Vec<String>,
    pub ticket: Option<String>,
    pub at: u64,
}

impl From<&discovery::Candidate> for DiscoveryCandidate {
    fn from(value: &discovery::Candidate) -> Self {
        DiscoveryCandidate {
            pubkey: value.pubkey.clone(),
            have: value.have.clone(),
            ticket: value.ticket.clone(),
            at: value.at,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DiscoveryAttempt {
    pub id: u64,
    pub pubkey: String,
    pub ticket: Option<String>,
    pub key: String,
    pub dial: Option<u64>,
}

/// The single replacement window.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DiscoveryWindow {
    pub id: u64,
    /// The context the window serves, which may since have been replaced.
    pub context: u64,
    pub media_type: DiscoveryMedia,
    pub created_at: u64,
    pub expires_at: u64,
    pub attempt: Option<DiscoveryAttempt>,
    pub vacant: bool,
    pub victim: Option<String>,
}

/// A hinted candidate for a demanded key.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FoundHolder {
    pub context: u64,
    pub media_type: DiscoveryMedia,
    pub candidate: DiscoveryCandidate,
    pub key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DiscoveryCounters {
    pub checks: u64,
    pub replacements: u64,
    pub expired: u64,
    pub opened: u64,
    pub verified: u64,
    pub stale_holder: u64,
    pub stale_blocked: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DiscoverySnapshot {
    pub candidates: u32,
    pub contexts: u32,
    pub requested_keys: u32,
    pub replacement_spent: u32,
    pub opportunity_active: bool,
    pub remaining_ms: u64,
    pub vacancy_reserved: bool,
    pub counters: DiscoveryCounters,
}

struct DiscoveryState {
    discovery: discovery::NeighbourDiscovery,
    /// The latest `choose` or `hinted` result, for the `begin` that follows.
    found: Option<discovery::Found>,
}

/// Demand, hints, holder misses and the single replacement window, as
/// `neighbour-discovery.mjs` keeps them. The shell owns admission, slots and
/// connections. One per swarm.
#[derive(uniffi::Object)]
pub struct NeighbourDiscovery {
    inner: Mutex<DiscoveryState>,
}

impl NeighbourDiscovery {
    fn lock(&self) -> MutexGuard<'_, DiscoveryState> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn keep(&self, found: Option<discovery::Found>) -> Option<FoundHolder> {
        let result = found.as_ref().map(|found| FoundHolder {
            context: found.context.value(),
            media_type: found.media_type.into(),
            candidate: (&found.candidate).into(),
            key: found.key.clone(),
        });
        self.lock().found = found;
        result
    }
}

#[uniffi::export]
impl NeighbourDiscovery {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(NeighbourDiscovery {
            inner: Mutex::new(DiscoveryState {
                discovery: discovery::NeighbourDiscovery::new(),
                found: None,
            }),
        })
    }

    /// The live context for this media type and rendition, created or reset
    /// after 30 s without activity or demand.
    pub fn context(&self, now: u64, media_type: String, rendition: String) -> Option<u64> {
        self.lock().discovery.context(now, &media_type, &rendition).map(ContextId::value)
    }

    /// Record demand for `key`; keeps the two most recent keys, with an
    /// in-flight attempt's key pinned first.
    pub fn demand(&self, now: u64, media_type: String, rendition: String, key: String) -> Option<u64> {
        self.lock()
            .discovery
            .demand(now, &media_type, &rendition, &key)
            .map(ContextId::value)
    }

    /// A peer's advertised keys and ticket, newest last, at most 64 peers.
    pub fn hint(&self, now: u64, pubkey: String, have: Vec<String>, ticket: Option<String>) {
        let have: Vec<&str> = have.iter().map(String::as_str).collect();
        self.lock().discovery.hint(now, &pubkey, &have, ticket.as_deref());
    }

    /// This holder lacked `key` at the deadline; one miss per distinct key.
    pub fn holder_miss(&self, now: u64, context: Option<u64>, pubkey: String, key: String) {
        self.lock()
            .discovery
            .holder_miss(now, context.map(ContextId::from_value), &pubkey, &key);
    }

    /// The holder answered ahead of the deadline; clears its misses here.
    pub fn holder_ahead(&self, context: Option<u64>, pubkey: String) {
        self.lock().discovery.holder_ahead(context.map(ContextId::from_value), &pubkey);
    }

    /// The holder has missed on enough distinct keys for long enough.
    pub fn stale(&self, now: u64, context: Option<u64>, pubkey: String) -> bool {
        self.lock().discovery.stale(now, context.map(ContextId::from_value), &pubkey)
    }

    /// Drop this peer's misses in every context; its hint stays.
    pub fn forget(&self, pubkey: String) {
        self.lock().discovery.forget(&pubkey);
    }

    /// The context is live, recently active and recently demanded.
    pub fn current(&self, now: u64, context: u64) -> bool {
        self.lock().discovery.current(now, ContextId::from_value(context))
    }

    /// A hinted candidate for an unmet current context, or `None`. Only
    /// candidates in `eligible` (pubkeys) are considered, and only media
    /// types in `unmet`. With `room` (a free slot), a context whose one
    /// replacement is spent is still considered.
    pub fn choose(&self, now: u64, eligible: Vec<String>, unmet: Vec<String>, room: bool) -> Option<FoundHolder> {
        let found = self.lock().discovery.choose(
            now,
            |candidate| eligible.contains(&candidate.pubkey),
            |media| unmet.iter().any(|value| value == media.as_str()),
            room,
        );
        self.keep(found)
    }

    /// A fresh eligible candidate hinting a key this context demands.
    pub fn hinted(&self, now: u64, context: u64, eligible: Vec<String>) -> Option<FoundHolder> {
        let found = self
            .lock()
            .discovery
            .hinted(now, ContextId::from_value(context), &|candidate: &discovery::Candidate| {
                eligible.contains(&candidate.pubkey)
            });
        self.keep(found)
    }

    /// Open the replacement window if none is open, then start one attempt
    /// on the holder the latest `choose` or `hinted` returned. Each result
    /// begins at most once; `None` without one.
    pub fn begin(&self, now: u64) -> Option<u64> {
        let mut state = self.lock();
        let found = state.found.take()?;
        state.discovery.begin(now, &found).map(AttemptId::value)
    }

    /// The attempt is still the window's, current and freshly hinted.
    pub fn valid(&self, now: u64, attempt: u64) -> bool {
        self.lock().discovery.valid(now, AttemptId::from_value(attempt))
    }

    /// Spend this context's one replacement, dropping `victim` for the attempt.
    pub fn replaced(&self, now: u64, attempt: u64, victim: Option<String>) -> bool {
        self.lock()
            .discovery
            .replaced(now, AttemptId::from_value(attempt), victim.as_deref())
    }

    /// The attempt's connection was allocated as `dial`.
    pub fn allocated(&self, attempt: u64, dial: u64) {
        self.lock().discovery.allocated(AttemptId::from_value(attempt), dial);
    }

    pub fn abandoned(&self, attempt: u64) {
        self.lock().discovery.abandoned(AttemptId::from_value(attempt));
    }

    /// The connection `dial` failed.
    pub fn failed(&self, dial: u64) {
        self.lock().discovery.failed(dial);
    }

    /// Close the current window.
    pub fn end(&self) -> bool {
        self.lock().discovery.end()
    }

    /// A verified peer segment re-arms the context's replacement.
    pub fn verified(&self, context: Option<u64>) -> bool {
        self.lock().discovery.verified(context.map(ContextId::from_value))
    }

    /// The replacement window is open.
    pub fn live(&self, now: u64) -> bool {
        self.lock().discovery.live(now)
    }

    /// The open window holds a vacated slot for a current context.
    pub fn reserved(&self, now: u64) -> bool {
        self.lock().discovery.reserved(now)
    }

    /// This peer is the live window's victim.
    pub fn suppresses(&self, now: u64, pubkey: String) -> bool {
        self.lock().discovery.suppresses(now, &pubkey)
    }

    pub fn contexts(&self) -> Vec<DiscoveryContext> {
        self.lock().discovery.contexts().map(Into::into).collect()
    }

    pub fn candidates(&self) -> Vec<DiscoveryCandidate> {
        self.lock().discovery.candidates().map(Into::into).collect()
    }

    pub fn window(&self) -> Option<DiscoveryWindow> {
        self.lock().discovery.window().map(|window| DiscoveryWindow {
            id: window.id,
            context: window.context.value(),
            media_type: window.media_type.into(),
            created_at: window.created_at,
            expires_at: window.expires_at,
            attempt: window.attempt.as_ref().map(|attempt| DiscoveryAttempt {
                id: attempt.id.value(),
                pubkey: attempt.pubkey.clone(),
                ticket: attempt.ticket.clone(),
                key: attempt.key.clone(),
                dial: attempt.dial,
            }),
            vacant: window.vacant,
            victim: window.victim.clone(),
        })
    }

    pub fn snapshot(&self, now: u64) -> DiscoverySnapshot {
        let snapshot = self.lock().discovery.snapshot(now);
        let counters = snapshot.counters;
        DiscoverySnapshot {
            candidates: snapshot.candidates as u32,
            contexts: snapshot.contexts as u32,
            requested_keys: snapshot.requested_keys as u32,
            replacement_spent: snapshot.replacement_spent as u32,
            opportunity_active: snapshot.opportunity_active,
            remaining_ms: snapshot.remaining_ms,
            vacancy_reserved: snapshot.vacancy_reserved,
            counters: DiscoveryCounters {
                checks: counters.checks,
                replacements: counters.replacements,
                expired: counters.expired,
                opened: counters.opened,
                verified: counters.verified,
                stale_holder: counters.stale_holder,
                stale_blocked: counters.stale_blocked,
            },
        }
    }

    /// Drop every context, candidate and the window; counters stay.
    pub fn clear(&self) {
        let mut state = self.lock();
        state.discovery.clear();
        state.found = None;
    }
}

/// Supply already known for one rendition's next segment. The host filters
/// open, idle, unbanned, non-stale framing 2 HAVE holders; no discovery runs.
#[derive(Clone, Debug, uniffi::Record)]
pub struct PlayerSupply {
    pub rendition: String,
    pub size: Option<u64>,
    pub peers: Vec<PeerTiming>,
    pub origin: Option<Timing>,
    pub shared: Timing,
    pub available_ms: f64,
    pub max_holders: u32,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PlayerHint {
    pub rendition: String,
    pub eligible_holders: u32,
    pub projected_ms: Option<f64>,
}

/// Advisory command; may only break ties between origin-sustainable levels.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum PlayerCommand {
    PlayerHint { hint: PlayerHint },
}

#[uniffi::export]
pub fn player_hint(supply: PlayerSupply) -> PlayerCommand {
    let peers: Vec<Estimate> = supply
        .peers
        .iter()
        .map(|p| Estimate {
            source: Source::Peer(p.peer),
            first_byte_ms: p.timing.first_byte_ms,
            rate: p.timing.rate,
        })
        .collect();
    let origin = supply.origin.map(|timing| Estimate {
        source: Source::Origin,
        first_byte_ms: timing.first_byte_ms,
        rate: timing.rate,
    });
    let relayswarm_proto::player_hint::Command::PlayerHint(hint) =
        relayswarm_proto::player_hint::player_hint(&relayswarm_proto::player_hint::Supply {
            rendition: &supply.rendition,
            size: supply.size,
            peers: &peers,
            origin,
            shared_first_byte_ms: supply.shared.first_byte_ms,
            shared_rate: supply.shared.rate,
            available_ms: supply.available_ms,
            max_holders: supply.max_holders as usize,
        });
    PlayerCommand::PlayerHint {
        hint: PlayerHint {
            rendition: hint.rendition,
            eligible_holders: hint.eligible_holders,
            projected_ms: hint.projected_ms,
        },
    }
}
