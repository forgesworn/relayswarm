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
pub const LINK_HEADER: usize = 12;

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
/// before the call. `bytes`/`len` carry the operation's text or bytes, and
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
        link.set_channel_open(open != 0);
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
            LINK_SETS => return Some(sets(link)),
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
