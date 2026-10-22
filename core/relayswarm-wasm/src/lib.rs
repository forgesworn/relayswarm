//! WebAssembly bindings. Values cross the boundary as JSON text, so the
//! JavaScript caller passes `JSON.stringify` of its own objects and parses
//! the result; `null` means rejection, as in `segment-commitment.mjs`.

use relayswarm_proto::commitment::{self, FragmentContext, Trust};
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn list(options: &Value, name: &str) -> Vec<Value> {
    options.get(name).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn result(value: Option<Map<String, Value>>) -> Option<String> {
    value.map(|map| Value::Object(map).to_string())
}

/// `validStreamAuthorisation(event)`.
#[wasm_bindgen(js_name = validStreamAuthorisation)]
pub fn valid_stream_authorisation(event: &str) -> bool {
    commitment::valid_stream_authorisation(&parse(event))
}

/// `verifyCommitmentDelegation(event, { streamEvent, swarmId, revokedDelegationIds, delegationRevocations }, at)`.
#[wasm_bindgen(js_name = verifyCommitmentDelegation)]
pub fn verify_commitment_delegation(event: &str, options: &str, at_ms: f64) -> Option<String> {
    let event = parse(event);
    let options = parse(options);
    let (revoked, revocations) = (list(&options, "revokedDelegationIds"), list(&options, "delegationRevocations"));
    let trust = Trust {
        stream_event: &options["streamEvent"],
        swarm_id: options["swarmId"].as_str()?,
        revoked_delegation_ids: &revoked,
        delegation_revocations: &revocations,
    };
    result(commitment::verify_commitment_delegation(Some(&event), &trust, at_ms as i64))
}

/// `verifySegmentCommitment(event, options, at)`, where `options.context` is
/// the reduced fragment context (sequence, discontinuity, part, level,
/// fragType, decryptMethod, media).
#[wasm_bindgen(js_name = verifySegmentCommitment)]
pub fn verify_segment_commitment(event: &str, options: &str, at_ms: f64) -> Option<String> {
    let event = parse(event);
    let options = parse(options);
    let (revoked, revocations) = (list(&options, "revokedDelegationIds"), list(&options, "delegationRevocations"));
    let trust = Trust {
        stream_event: &options["streamEvent"],
        swarm_id: options["swarmId"].as_str()?,
        revoked_delegation_ids: &revoked,
        delegation_revocations: &revocations,
    };
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
    result(commitment::verify_segment_commitment(
        &event,
        &trust,
        options["key"].as_str()?,
        &context,
        &options["maxSegmentBytes"],
        delegation,
        at_ms as i64,
    ))
}
