//! UniFFI bindings for the RelaySwarm core, so Swift and Kotlin shells call the
//! same verification and scheduling as the browser's WebAssembly module.
//!
//! Signed events and the verifier's trust options cross as JSON text, in the
//! shapes `segment-commitment.mjs` takes, because shells already hold them as
//! Nostr JSON. Scheduler inputs and commands cross as typed records. Like the
//! core, nothing here reads a clock or performs I/O: the shell passes the time.

use relayswarm_proto::commitment::{self, FragmentContext, Trust};
use relayswarm_proto::link::{self, LinkConfig};
use relayswarm_proto::pieces::{self, PieceRange};
use relayswarm_proto::scheduler::{self, Command, Estimate, Source, TransferConfig};
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
