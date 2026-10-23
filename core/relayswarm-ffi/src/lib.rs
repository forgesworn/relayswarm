//! UniFFI bindings for the RelaySwarm core, so Swift and Kotlin shells call the
//! same verification and scheduling as the browser's WebAssembly module.
//!
//! Signed events and the verifier's trust options cross as JSON text, in the
//! shapes `segment-commitment.mjs` takes, because shells already hold them as
//! Nostr JSON. Scheduler inputs and commands cross as typed records. Like the
//! core, nothing here reads a clock or performs I/O: the shell passes the time.

use relayswarm_proto::commitment::{self, FragmentContext, Trust};
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
