//! WebAssembly exports with a plain C ABI, so any WebAssembly host can call
//! them without generated glue. The caller writes UTF-8 JSON into memory from
//! `rs_alloc`, calls `rs_call`, then reads the result from `rs_result_ptr`.
//!
//! Input is the JSON array `[event, options, atMs]` (`options` and `atMs` are
//! ignored by the stream check). `rs_call` returns the result length in bytes,
//! or -1 for rejection (`null` in `segment-commitment.mjs`). Results are JSON:
//! `true` for a valid stream authorisation, otherwise the verified content.
//!
//! Peer selection (`rs_sel_*`) takes and returns plain numbers, so infinities
//! and doubles cross unchanged. NaN stands for JavaScript `null`. Each
//! instance holds one selection state, so each swarm instantiates its own.

use relayswarm_proto::commitment::{self, FragmentContext, Trust};
use relayswarm_proto::selection::{LinkView, PeerSelection};
use serde_json::{Map, Value};
use std::cell::RefCell;

pub const OP_STREAM: u32 = 0;
pub const OP_DELEGATION: u32 = 1;
pub const OP_COMMITMENT: u32 = 2;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static SELECTION: RefCell<PeerSelection> = RefCell::new(PeerSelection::new());
    static NUMBERS: RefCell<[f64; 6]> = const { RefCell::new([0.0; 6]) };
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

fn content(value: Option<Map<String, Value>>) -> Option<Value> {
    value.map(Value::Object)
}

/// One verifier call on parsed input; `None` is rejection.
pub fn call(op: u32, input: &Value) -> Option<Value> {
    let event = input.get(0)?;
    if op == OP_STREAM {
        return commitment::valid_stream_authorisation(event).then_some(Value::Bool(true));
    }
    let options = input.get(1)?;
    let at_ms = input.get(2)?.as_f64()? as i64;
    let (revoked, revocations) = (list(options, "revokedDelegationIds"), list(options, "delegationRevocations"));
    let trust = Trust {
        stream_event: &options["streamEvent"],
        swarm_id: options["swarmId"].as_str()?,
        revoked_delegation_ids: &revoked,
        delegation_revocations: &revocations,
    };
    match op {
        OP_DELEGATION => content(commitment::verify_commitment_delegation(Some(event), &trust, at_ms)),
        OP_COMMITMENT => {
            // The reduced fragment context: sequence, discontinuity, part,
            // level, fragType, decryptMethod and media.
            let context = &options["context"];
            let field = |name: &str| context.get(name).cloned().unwrap_or(Value::Null);
            let context = FragmentContext {
                sequence: field("sequence"),
                discontinuity: field("discontinuity"),
                part: field("part"),
                level: context["level"].as_str()?.to_owned(),
                frag_type: field("fragType"),
                decrypt_method: field("decryptMethod"),
                media: context.get("media").filter(|media| !media.is_null()).cloned(),
            };
            let delegation = options.get("delegation").filter(|delegation| !delegation.is_null());
            content(commitment::verify_segment_commitment(
                event,
                &trust,
                options["key"].as_str()?,
                &context,
                &options["maxSegmentBytes"],
                delegation,
                at_ms,
            ))
        }
        _ => None,
    }
}

/// Bytes for the caller's input, freed by `rs_free`.
#[no_mangle]
pub extern "C" fn rs_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer` and `len` must come from one `rs_alloc` call, freed once.
#[no_mangle]
pub unsafe extern "C" fn rs_free(pointer: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(pointer, 0, len.max(1)));
}

/// # Safety
/// `pointer` must address `len` initialised bytes from `rs_alloc`.
#[no_mangle]
pub unsafe extern "C" fn rs_call(op: u32, pointer: *const u8, len: usize) -> i32 {
    let bytes = std::slice::from_raw_parts(pointer, len);
    let result = serde_json::from_slice::<Value>(bytes).ok().and_then(|input| call(op, &input));
    RESULT.with(|cell| {
        let mut buffer = cell.borrow_mut();
        buffer.clear();
        match result {
            Some(value) => {
                buffer.extend_from_slice(value.to_string().as_bytes());
                buffer.len() as i32
            }
            None => -1,
        }
    })
}

/// Where the latest `rs_call` result starts; valid until the next call.
#[no_mangle]
pub extern "C" fn rs_result_ptr() -> *const u8 {
    RESULT.with(|cell| cell.borrow().as_ptr())
}

fn or_nan(value: Option<f64>) -> f64 {
    value.unwrap_or(f64::NAN)
}

fn numbers(values: [f64; 6]) -> *const f64 {
    NUMBERS.with(|cell| {
        *cell.borrow_mut() = values;
        cell.as_ptr() as *const f64
    })
}

fn with_selection<T>(run: impl FnOnce(&mut PeerSelection) -> T) -> T {
    SELECTION.with(|cell| run(&mut cell.borrow_mut()))
}

/// `first_byte_ms` is NaN for none.
#[no_mangle]
pub extern "C" fn rs_sel_observe(now: f64, first_byte_ms: f64, bytes: f64, flow_ms: f64, total_flow_ms: f64) {
    let first_byte = (!first_byte_ms.is_nan()).then_some(first_byte_ms);
    with_selection(|selection| selection.observe(now as u64, first_byte, bytes, flow_ms, Some(total_flow_ms)));
}

#[no_mangle]
pub extern "C" fn rs_sel_record(now: f64, link: u32, elapsed_ms: f64, bytes: f64) {
    with_selection(|selection| selection.record(now as u64, u64::from(link), elapsed_ms, bytes));
}

#[no_mangle]
pub extern "C" fn rs_sel_forget(link: u32) {
    with_selection(|selection| selection.forget(u64::from(link)));
}

/// Choose among `count` link handles at `links` (little-endian u32 each),
/// which the caller has already filtered for open, idle, untried links
/// holding the key. Returns the chosen handle, or -1 for none.
///
/// # Safety
/// `links` must address `count * 4` initialised bytes from `rs_alloc`.
#[no_mangle]
pub unsafe extern "C" fn rs_sel_select(links: *const u8, count: usize, size: f64, deadline_ms: f64) -> f64 {
    let bytes = std::slice::from_raw_parts(links, count * 4);
    let views: Vec<LinkView> = bytes
        .chunks_exact(4)
        .map(|chunk| LinkView {
            id: u64::from(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])),
            pubkey: "",
            closed: false,
            busy: false,
            has_key: true,
        })
        .collect();
    with_selection(|selection| selection.select(&views, &[], size, deadline_ms)).map_or(-1.0, |id| id as f64)
}

/// First byte, rate, last observation time, turn and order, at the returned
/// address until the next `rs_sel_*` call.
#[no_mangle]
pub extern "C" fn rs_sel_state() -> *const f64 {
    let values = with_selection(|selection| {
        [
            or_nan(selection.first_byte_ms()),
            or_nan(selection.rate()),
            selection.last_observed_at() as f64,
            f64::from(selection.turn()),
            selection.order() as f64,
            0.0,
        ]
    });
    numbers(values)
}

#[no_mangle]
pub extern "C" fn rs_sel_project(size: f64) -> f64 {
    or_nan(with_selection(|selection| selection.project_ms(size)))
}

#[no_mangle]
pub extern "C" fn rs_sel_minimum(size: f64) -> f64 {
    with_selection(|selection| selection.minimum_ms(size))
}

#[no_mangle]
pub extern "C" fn rs_sel_estimate(link: u32, size: f64) -> f64 {
    or_nan(with_selection(|selection| selection.estimate(u64::from(link), size)))
}

/// Attempts, latency, throughput, failure rate, consecutive failures and
/// last selected, at the returned address until the next `rs_sel_*` call.
#[no_mangle]
pub extern "C" fn rs_sel_summary(link: u32) -> *const f64 {
    let value = with_selection(|selection| selection.summary(u64::from(link)));
    numbers([
        f64::from(value.attempts),
        or_nan(value.latency_ms),
        or_nan(value.throughput_bytes_per_second),
        value.failure_rate,
        f64::from(value.consecutive_failures),
        value.last_selected as f64,
    ])
}

// --- peer links -------------------------------------------------------------

use relayswarm_proto::link::{Link, LinkConfig, LinkEvent};
use relayswarm_proto::pieces::PieceRange;
use std::collections::HashMap;

thread_local! {
    static LINKS: RefCell<HashMap<u32, Link>> = RefCell::new(HashMap::new());
    static NEXT_LINK: RefCell<u32> = const { RefCell::new(1) };
}

pub const LINK_TEXT: u32 = 0;
pub const LINK_BINARY: u32 = 1;
pub const LINK_REQUEST: u32 = 2;
pub const LINK_ABORT: u32 = 3;
pub const LINK_CLOSE: u32 = 4;
pub const LINK_TICK: u32 = 5;
pub const LINK_SERVE: u32 = 6;
pub const LINK_BUFFERED_LOW: u32 = 7;
pub const LINK_SEND_HAVE: u32 = 8;
pub const LINK_SEND_HAVE_CHANGE: u32 = 9;
pub const LINK_SEND_CONTRIBUTION: u32 = 10;
pub const LINK_SEND_FETCHING: u32 = 11;
pub const LINK_STATE: u32 = 12;
pub const LINK_SETS: u32 = 13;
/// Framing 2: `a` timeout, `b` object size, input `[key, start, end]`.
pub const LINK_REQUEST_RANGE: u32 = 14;

const EVENT_SEND_TEXT: u8 = 1;
const EVENT_SEND_BINARY: u8 = 2;
const EVENT_CLOSED: u8 = 3;
const EVENT_REPORT: u8 = 4;
const EVENT_RESOLVED: u8 = 5;
const EVENT_HAVE_CHANGED: u8 = 6;
const EVENT_SCHEDULE_CHANGED: u8 = 7;
const EVENT_SERVE_REQUEST: u8 = 8;
const EVENT_UPLOAD_CANCELLED: u8 = 9;
const EVENT_PROGRESS: u8 = 10;

/// Scalars at the start of every link frame, as little-endian doubles.
pub const LINK_HEADER: usize = 13;

fn push_event(out: &mut Vec<u8>, tag: u8, payload: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

fn doubles(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

fn opt(value: Option<u64>) -> f64 {
    value.map_or(f64::NAN, |value| value as f64)
}

/// A frame: the header scalars, then events as tag, u32 length, payload.
fn frame(link: &mut Link, request: Option<u64>) -> Vec<u8> {
    let mut out = doubles(&[
        link.version() as f64,
        f64::from(u8::from(link.closed())),
        f64::from(u8::from(link.busy())),
        f64::from(u8::from(link.transferring())),
        link.outbound_in_flight() as f64,
        link.bytes_in() as f64,
        link.bytes_out() as f64,
        link.opened_at() as f64,
        link.last_served_at() as f64,
        link.last_delivered_at() as f64,
        opt(link.next_deadline()),
        opt(request),
        f64::from(u8::from(link.upload_waiting())),
    ]);
    for event in link.drain_events() {
        match event {
            LinkEvent::SendText(text) => push_event(&mut out, EVENT_SEND_TEXT, text.as_bytes()),
            LinkEvent::SendBinary(bytes) => push_event(&mut out, EVENT_SEND_BINARY, &bytes),
            LinkEvent::Closed(reason) => push_event(&mut out, EVENT_CLOSED, reason.as_bytes()),
            LinkEvent::Report(report) => {
                let json = serde_json::json!({
                    "id": report.id, "outcome": report.outcome.as_str(), "receivedBytes": report.received_bytes,
                    "metadataReceived": report.metadata_received, "draining": report.draining, "closeReason": report.close_reason,
                });
                push_event(&mut out, EVENT_REPORT, json.to_string().as_bytes());
            }
            LinkEvent::Resolved { id, bytes } => {
                let mut payload = doubles(&[opt(id)]);
                payload.push(u8::from(bytes.is_some()));
                payload.extend_from_slice(bytes.as_deref().unwrap_or_default());
                push_event(&mut out, EVENT_RESOLVED, &payload);
            }
            LinkEvent::HaveChanged(keys) => push_event(&mut out, EVENT_HAVE_CHANGED, Value::from(keys).to_string().as_bytes()),
            LinkEvent::ScheduleChanged => push_event(&mut out, EVENT_SCHEDULE_CHANGED, &[]),
            LinkEvent::ServeRequest(key) => push_event(&mut out, EVENT_SERVE_REQUEST, key.as_bytes()),
            LinkEvent::UploadCancelled(bytes) => push_event(&mut out, EVENT_UPLOAD_CANCELLED, &doubles(&[bytes as f64])),
            LinkEvent::Progress { received, size } => push_event(&mut out, EVENT_PROGRESS, &doubles(&[received as f64, size as f64])),
        }
    }
    out
}

fn sets(link: &Link) -> Vec<u8> {
    let fetching: Vec<Value> = link.fetching().iter().map(|(key, at)| serde_json::json!([key, at])).collect();
    let renditions: Vec<Value> = link.renditions().iter().map(|(key, at)| serde_json::json!([key, at])).collect();
    let (serving, rendition, at) = link.contribution();
    serde_json::json!({
        "have": link.have().iter().collect::<Vec<_>>(),
        "fetching": fetching,
        "renditions": renditions,
        "serving": serving, "rendition": rendition, "at": at,
        "closeReason": link.close_reason(),
    })
    .to_string()
    .into_bytes()
}

/// A whole number of milliseconds from a double; NaN and negatives are 0.
fn ms(value: f64) -> u64 {
    value as u64
}

/// A new link; returns its handle, never reused.
#[no_mangle]
pub extern "C" fn rs_link_new(max_segment_bytes: f64, max_queued_requests: f64, drain_timeout_ms: f64, reliable: u32, now: f64) -> u32 {
    let config = LinkConfig {
        max_segment_bytes: ms(max_segment_bytes),
        max_queued_requests: ms(max_queued_requests) as usize,
        drain_timeout_ms: ms(drain_timeout_ms),
        reliable: reliable != 0,
    };
    let handle = NEXT_LINK.with(|next| {
        let mut next = next.borrow_mut();
        let handle = *next;
        *next += 1;
        handle
    });
    LINKS.with(|links| links.borrow_mut().insert(handle, Link::new(config, ms(now))));
    handle
}

#[no_mangle]
pub extern "C" fn rs_link_free(handle: u32) {
    LINKS.with(|links| links.borrow_mut().remove(&handle));
}

/// One operation on a link; returns the frame's length at `rs_result_ptr`,
/// or -1 for an unknown handle or operation. `open` is the channel's state
/// before the call: bit 0 open, bit 1 ordered and fully reliable. `bytes`/`len` carry the operation's text or bytes, and
/// `a`/`b` its numbers.
///
/// # Safety
/// `bytes` must address `len` initialised bytes from `rs_alloc` (or `len` 0).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn rs_link_call(handle: u32, op: u32, now: f64, open: u32, a: f64, b: f64, bytes: *const u8, len: usize) -> i32 {
    let input = if len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(bytes, len)
    };
    let text = || std::str::from_utf8(input).ok();
    let json = || serde_json::from_slice::<Value>(input).ok();
    let strings = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    let now = ms(now);
    let out = LINKS.with(|links| {
        let mut links = links.borrow_mut();
        let link = links.get_mut(&handle)?;
        if op == LINK_SETS {
            return Some(sets(link));
        }
        link.set_channel_open(open & 1 != 0);
        link.set_reliable(open & 2 != 0);
        let mut request = None;
        match op {
            LINK_TEXT => link.handle_text(now, text()?),
            LINK_BINARY => link.handle_binary(now, input),
            LINK_REQUEST => {
                // b: NaN for no expected size; a negative never matches.
                let expected = if b.is_nan() {
                    None
                } else if b < 0.0 {
                    Some(u64::MAX)
                } else {
                    Some(ms(b))
                };
                request = link.request(now, text()?, ms(a), expected);
            }
            LINK_REQUEST_RANGE => {
                let args = json()?;
                let key = args.get(0)?.as_str()?;
                let start = u32::try_from(args.get(1)?.as_u64()?).ok()?;
                let end = u32::try_from(args.get(2)?.as_u64()?).ok()?;
                request = link.request_range(now, key, ms(a), PieceRange { start, end }, ms(b));
            }
            LINK_ABORT => link.abort(now, ms(a), b != 0.0),
            LINK_CLOSE => link.close(text()?),
            LINK_TICK => link.tick(now),
            LINK_SERVE => {
                link.observe_buffered(ms(b));
                link.serve_response(now, (a != 0.0).then(|| input.to_vec()));
            }
            LINK_BUFFERED_LOW => link.buffered_amount_low(now, ms(a)),
            LINK_SEND_HAVE => link.send_have(&strings(json().as_ref())),
            LINK_SEND_HAVE_CHANGE => {
                let change = json()?;
                link.send_have_change(&strings(change.get("add")), &strings(change.get("del")));
            }
            LINK_SEND_CONTRIBUTION => {
                let rendition = json()?;
                link.send_contribution(a != 0.0, rendition.as_str());
            }
            LINK_SEND_FETCHING => link.send_fetching(text()?, ms(a)),
            LINK_STATE => {}
            _ => return None,
        }
        Some(frame(link, request))
    });
    RESULT.with(|cell| {
        let mut buffer = cell.borrow_mut();
        buffer.clear();
        match out {
            Some(bytes) => {
                buffer.extend_from_slice(&bytes);
                buffer.len() as i32
            }
            None => -1,
        }
    })
}

// --- neighbour discovery ----------------------------------------------------
//
// `rs_disc_call(op, now, pointer, len)` takes a JSON array of arguments and
// leaves a JSON result at `rs_result_ptr`, returning its length or -1 for
// malformed input. Queries return a bare value. Mutations return
// `{"r": result, "s": state}`, where the state is every context, the open
// window and the three counters the core owns, so the host can keep its
// own objects in step. Contexts, windows and attempts are numeric IDs.

use relayswarm_proto::discovery::{AttemptId, Candidate, ContextId, Found, NeighbourDiscovery};

thread_local! {
    static DISCOVERY: RefCell<NeighbourDiscovery> = RefCell::new(NeighbourDiscovery::new());
    /// The latest choice, for the `begin` that follows it.
    static FOUND: RefCell<Option<Found>> = const { RefCell::new(None) };
}

pub const DISC_CONTEXT: u32 = 0;
pub const DISC_DEMAND: u32 = 1;
pub const DISC_HINT: u32 = 2;
pub const DISC_HOLDER_MISS: u32 = 3;
pub const DISC_HOLDER_AHEAD: u32 = 4;
pub const DISC_STALE: u32 = 5;
pub const DISC_FORGET: u32 = 6;
pub const DISC_CURRENT: u32 = 7;
pub const DISC_CANDIDATES: u32 = 8;
pub const DISC_CHOOSE: u32 = 9;
pub const DISC_HINTED: u32 = 10;
pub const DISC_BEGIN: u32 = 11;
pub const DISC_VALID: u32 = 12;
pub const DISC_REPLACED: u32 = 13;
pub const DISC_ALLOCATED: u32 = 14;
pub const DISC_ABANDONED: u32 = 15;
pub const DISC_FAILED: u32 = 16;
pub const DISC_END: u32 = 17;
pub const DISC_VERIFIED: u32 = 18;
pub const DISC_LIVE: u32 = 19;
pub const DISC_RESERVED: u32 = 20;
pub const DISC_SUPPRESSES: u32 = 21;
pub const DISC_SNAPSHOT: u32 = 22;
pub const DISC_CLEAR: u32 = 23;

fn candidate_json(candidate: &Candidate) -> Value {
    serde_json::json!([candidate.pubkey, candidate.have, candidate.ticket, candidate.at])
}

fn found_json(found: Option<Found>) -> Value {
    let value = found.as_ref().map_or(Value::Null, |found| {
        serde_json::json!({ "context": context_id(found.context), "mediaType": found.media_type.as_str(),
            "candidate": candidate_json(&found.candidate), "key": found.key })
    });
    FOUND.with(|cell| *cell.borrow_mut() = found);
    value
}

fn context_id(id: ContextId) -> u64 {
    id.value()
}

fn discovery_state(discovery: &NeighbourDiscovery) -> Value {
    let contexts: Vec<Value> = discovery
        .contexts()
        .map(|context| {
            serde_json::json!({ "id": context_id(context.id), "mediaType": context.media_type.as_str(), "rendition": context.rendition,
                "keys": context.keys, "lastDemandAt": context.last_demand_at, "activityAt": context.activity_at, "spent": context.spent })
        })
        .collect();
    let window = discovery.window().map_or(Value::Null, |window| {
        serde_json::json!({ "id": window.id, "context": context_id(window.context), "mediaType": window.media_type.as_str(),
            "createdAt": window.created_at, "expiresAt": window.expires_at, "vacant": window.vacant, "victim": window.victim,
            "attempt": window.attempt.as_ref().map(|attempt| serde_json::json!({ "id": attempt.id.value(), "pubkey": attempt.pubkey,
                "ticket": attempt.ticket, "key": attempt.key, "dial": attempt.dial })) })
    });
    let counters = &discovery.counters;
    serde_json::json!({ "c": contexts, "w": window, "n": [counters.checks, counters.replacements, counters.verified] })
}

/// One discovery operation; `None` for malformed input.
pub fn discovery_call(discovery: &mut NeighbourDiscovery, op: u32, now: u64, args: &Value) -> Option<Value> {
    let arg = |index: usize| args.get(index).unwrap_or(&Value::Null);
    let text = |index: usize| arg(index).as_str();
    let id = |index: usize| arg(index).as_u64();
    let context = |index: usize| id(index).map(ContextId::from_value);
    let attempt = |index: usize| id(index).map(AttemptId::from_value);
    let pubkeys = |index: usize| -> Vec<String> {
        arg(index).as_array().map_or_else(Vec::new, |values| {
            values.iter().filter_map(|value| value.as_str().map(str::to_owned)).collect()
        })
    };
    let result = match op {
        DISC_CONTEXT => Value::from(discovery.context(now, text(0)?, text(1)?).map(context_id)),
        DISC_DEMAND => Value::from(discovery.demand(now, text(0)?, text(1)?, text(2)?).map(context_id)),
        DISC_HINT => {
            let have: Vec<&str> = arg(1).as_array()?.iter().filter_map(Value::as_str).collect();
            discovery.hint(now, text(0)?, &have, text(2));
            Value::Null
        }
        DISC_HOLDER_MISS => {
            discovery.holder_miss(now, context(0), text(1)?, text(2)?);
            return Some(Value::Null);
        }
        DISC_HOLDER_AHEAD => {
            discovery.holder_ahead(context(0), text(1)?);
            return Some(Value::Null);
        }
        DISC_STALE => return Some(Value::Bool(discovery.stale(now, context(0), text(1)?))),
        DISC_FORGET => {
            discovery.forget(text(0)?);
            return Some(Value::Null);
        }
        DISC_CURRENT => return Some(Value::Bool(context(0).is_some_and(|context| discovery.current(now, context)))),
        DISC_CANDIDATES => return Some(Value::Array(discovery.candidates().map(candidate_json).collect())),
        DISC_CHOOSE => {
            let (eligible, unmet) = (pubkeys(0), pubkeys(1));
            let found = discovery.choose(
                now,
                |candidate| eligible.contains(&candidate.pubkey),
                |media| unmet.iter().any(|value| value == media.as_str()),
                arg(2).as_bool()?,
            );
            return Some(found_json(found));
        }
        DISC_HINTED => {
            let eligible = pubkeys(1);
            let found = context(0)
                .and_then(|context| discovery.hinted(now, context, &|candidate: &Candidate| eligible.contains(&candidate.pubkey)));
            return Some(found_json(found));
        }
        DISC_BEGIN => {
            let found = FOUND.with(|cell| cell.borrow_mut().take())?;
            Value::from(discovery.begin(now, &found).map(AttemptId::value))
        }
        DISC_VALID => return Some(Value::Bool(attempt(0).is_some_and(|attempt| discovery.valid(now, attempt)))),
        DISC_REPLACED => Value::Bool(attempt(0).is_some_and(|attempt| discovery.replaced(now, attempt, text(1)))),
        DISC_ALLOCATED => {
            discovery.allocated(attempt(0)?, id(1)?);
            Value::Null
        }
        DISC_ABANDONED => {
            discovery.abandoned(attempt(0)?);
            Value::Null
        }
        DISC_FAILED => {
            discovery.failed(id(0)?);
            Value::Null
        }
        DISC_END => Value::Bool(discovery.end()),
        DISC_VERIFIED => Value::Bool(discovery.verified(context(0))),
        DISC_LIVE => return Some(Value::Bool(discovery.live(now))),
        DISC_RESERVED => return Some(Value::Bool(discovery.reserved(now))),
        DISC_SUPPRESSES => return Some(Value::Bool(discovery.suppresses(now, text(0)?))),
        DISC_SNAPSHOT => {
            let snapshot = discovery.snapshot(now);
            let counters = &snapshot.counters;
            return Some(
                serde_json::json!({ "v": 1, "candidateCapacity": 64, "candidates": snapshot.candidates, "contexts": snapshot.contexts,
                "requestedKeys": snapshot.requested_keys, "replacementSpent": snapshot.replacement_spent,
                "opportunityActive": snapshot.opportunity_active, "remainingMs": snapshot.remaining_ms,
                "vacancyReserved": snapshot.vacancy_reserved, "counters": { "checks": counters.checks, "replacements": counters.replacements,
                    "expired": counters.expired, "opened": counters.opened, "verified": counters.verified,
                    "staleHolder": counters.stale_holder, "staleBlocked": counters.stale_blocked } }),
            );
        }
        DISC_CLEAR => {
            discovery.clear();
            FOUND.with(|cell| *cell.borrow_mut() = None);
            Value::Null
        }
        _ => return None,
    };
    Some(serde_json::json!({ "r": result, "s": discovery_state(discovery) }))
}

/// # Safety
/// `pointer` must address `len` initialised bytes from `rs_alloc`.
#[no_mangle]
pub unsafe extern "C" fn rs_disc_call(op: u32, now: f64, pointer: *const u8, len: usize) -> i32 {
    let bytes = std::slice::from_raw_parts(pointer, len);
    let result = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|args| DISCOVERY.with(|cell| discovery_call(&mut cell.borrow_mut(), op, now as u64, &args)));
    RESULT.with(|cell| {
        let mut buffer = cell.borrow_mut();
        buffer.clear();
        match result {
            Some(value) => {
                buffer.extend_from_slice(value.to_string().as_bytes());
                buffer.len() as i32
            }
            None => -1,
        }
    })
}

// --- multi-holder transfer ---------------------------------------------------
//
// `rs_xfer_new(size, deadline, max_holders, origin_reserve_ms, pointer, len)`
// takes `{"sha256": hex, "pieces": [hex]}` and returns a handle, or 0 when
// the pieces do not fit the size. `rs_xfer_call(handle, op, now, source, a,
// b, pointer, len)` returns the length at `rs_result_ptr` of a u32 JSON
// length, the JSON `{"c": commands, "next": ms|null, "late", "finished"}` and
// then the delivered object's bytes, if a command is `deliver`. `source` is a
// peer handle, or -1 for origin; `a`/`b` are a piece range.

use relayswarm_proto::scheduler::{Command, Estimate, Source, Transfer, TransferConfig};

thread_local! {
    static TRANSFERS: RefCell<HashMap<u32, Transfer>> = RefCell::new(HashMap::new());
    static NEXT_TRANSFER: RefCell<u32> = const { RefCell::new(1) };
}

pub const XFER_START: u32 = 0;
pub const XFER_DELIVERED: u32 = 1;
pub const XFER_FAILED: u32 = 2;
pub const XFER_TICK: u32 = 3;
pub const XFER_STATE: u32 = 4;

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

/// `[id, firstByteMs|null, rate|null]` for a peer, `[firstByteMs, rate]` for origin.
/// Peers, origin, then the shared first byte and rate.
type Estimates = (Vec<Estimate>, Estimate, Option<f64>, Option<f64>);

fn estimates(args: &Value) -> Option<Estimates> {
    let peers = args.get("peers")?.as_array()?;
    let peers = peers
        .iter()
        .map(|entry| {
            Some(Estimate {
                source: Source::Peer(entry.get(0)?.as_u64()?),
                first_byte_ms: number(entry.get(1)),
                rate: number(entry.get(2)),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let origin = args.get("origin")?;
    let origin = Estimate {
        source: Source::Origin,
        first_byte_ms: number(origin.get(0)),
        rate: number(origin.get(1)),
    };
    Some((peers, origin, number(args.get("sharedFirstByteMs")), number(args.get("sharedRate"))))
}

fn transfer_frame(transfer: &mut Transfer) -> Vec<u8> {
    let mut payload = Vec::new();
    let commands: Vec<Value> = transfer
        .drain_commands()
        .into_iter()
        .map(|command| match command {
            Command::Request { peer, range } => serde_json::json!({ "t": "request", "peer": peer, "p": [range.start, range.end] }),
            Command::FetchOrigin { range } => serde_json::json!({ "t": "origin", "p": [range.start, range.end] }),
            Command::Cancel { peer } => serde_json::json!({ "t": "cancel", "peer": peer }),
            Command::Ban { peer } => serde_json::json!({ "t": "ban", "peer": peer }),
            Command::Deliver(bytes) => {
                payload = bytes;
                serde_json::json!({ "t": "deliver" })
            }
            Command::Fail => serde_json::json!({ "t": "fail" }),
        })
        .collect();
    let json = serde_json::json!({
        "c": commands, "next": transfer.next_deadline(), "late": transfer.late(), "finished": transfer.finished(),
    })
    .to_string();
    let mut out = (json.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(json.as_bytes());
    out.extend_from_slice(&payload);
    out
}

/// # Safety
/// `pointer` must address `len` initialised bytes from `rs_alloc`.
#[no_mangle]
pub unsafe extern "C" fn rs_xfer_new(
    size: f64,
    deadline: f64,
    max_holders: f64,
    origin_reserve_ms: f64,
    pointer: *const u8,
    len: usize,
) -> u32 {
    let input = if len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(pointer, len)
    };
    let made = serde_json::from_slice::<Value>(input).ok().and_then(|args| {
        let sha256 = args.get("sha256")?.as_str()?;
        let pieces: Vec<&str> = args.get("pieces")?.as_array()?.iter().map(Value::as_str).collect::<Option<_>>()?;
        let config = TransferConfig {
            max_holders: (ms(max_holders) as usize).max(1),
            origin_reserve_ms: origin_reserve_ms.max(0.0),
        };
        Transfer::new(config, ms(size), sha256, &pieces, ms(deadline))
    });
    let Some(transfer) = made else { return 0 };
    let handle = NEXT_TRANSFER.with(|next| {
        let mut next = next.borrow_mut();
        let handle = *next;
        *next += 1;
        handle
    });
    TRANSFERS.with(|transfers| transfers.borrow_mut().insert(handle, transfer));
    handle
}

#[no_mangle]
pub extern "C" fn rs_xfer_free(handle: u32) {
    TRANSFERS.with(|transfers| transfers.borrow_mut().remove(&handle));
}

/// # Safety
/// `pointer` must address `len` initialised bytes from `rs_alloc` (or `len` 0).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn rs_xfer_call(handle: u32, op: u32, now: f64, source: f64, a: f64, b: f64, pointer: *const u8, len: usize) -> i32 {
    let input = if len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(pointer, len)
    };
    let now = ms(now);
    let source = if source < 0.0 { Source::Origin } else { Source::Peer(ms(source)) };
    let range = PieceRange {
        start: ms(a) as u32,
        end: ms(b) as u32,
    };
    let out = TRANSFERS.with(|transfers| {
        let mut transfers = transfers.borrow_mut();
        let transfer = transfers.get_mut(&handle)?;
        match op {
            XFER_START => {
                let (peers, origin, first_byte, rate) = estimates(&serde_json::from_slice::<Value>(input).ok()?)?;
                transfer.start(now, &peers, origin, first_byte, rate);
            }
            XFER_DELIVERED => transfer.delivered(now, source, range, input),
            XFER_FAILED => transfer.failed(now, source),
            XFER_TICK => transfer.tick(now),
            XFER_STATE => {}
            _ => return None,
        }
        Some(transfer_frame(transfer))
    });
    RESULT.with(|cell| {
        let mut buffer = cell.borrow_mut();
        buffer.clear();
        match out {
            Some(bytes) => {
                buffer.extend_from_slice(&bytes);
                buffer.len() as i32
            }
            None => -1,
        }
    })
}
