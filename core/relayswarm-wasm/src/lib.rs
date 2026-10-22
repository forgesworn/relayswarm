//! WebAssembly exports with a plain C ABI, so any WebAssembly host can call
//! them without generated glue. The caller writes UTF-8 JSON into memory from
//! `rs_alloc`, calls `rs_call`, then reads the result from `rs_result_ptr`.
//!
//! Input is the JSON array `[event, options, atMs]` (`options` and `atMs` are
//! ignored by the stream check). `rs_call` returns the result length in bytes,
//! or -1 for rejection (`null` in `segment-commitment.mjs`). Results are JSON:
//! `true` for a valid stream authorisation, otherwise the verified content.

use relayswarm_proto::commitment::{self, FragmentContext, Trust};
use serde_json::{Map, Value};
use std::cell::RefCell;

pub const OP_STREAM: u32 = 0;
pub const OP_DELEGATION: u32 = 1;
pub const OP_COMMITMENT: u32 = 2;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
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
