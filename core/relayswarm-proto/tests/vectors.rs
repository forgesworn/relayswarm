//! Runs the JavaScript-generated vectors in `core/vectors/commitments.json`.

use relayswarm_proto::commitment::{
    valid_stream_authorisation, verify_commitment_delegation, verify_segment_commitment, FragmentContext, Trust,
};
use serde_json::{json, Value};

fn load() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/commitments.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors file")).expect("vectors JSON")
}

fn list(entry: &Value, name: &str) -> Vec<Value> {
    entry.get(name).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn context(normalised: &Value) -> FragmentContext {
    let field = |name: &str| normalised.get(name).cloned().unwrap_or(Value::Null);
    FragmentContext {
        sequence: field("sequence"),
        discontinuity: field("discontinuity"),
        part: field("part"),
        level: normalised["level"].as_str().expect("level string").to_owned(),
        frag_type: field("fragType"),
        decrypt_method: field("decryptMethod"),
        media: normalised.get("media").filter(|media| !media.is_null()).cloned(),
    }
}

fn run(entry: &Value, at: i64) -> Value {
    let op = entry["op"].as_str().expect("op");
    if op == "stream" {
        return if valid_stream_authorisation(&entry["event"]) {
            json!(true)
        } else {
            Value::Null
        };
    }
    let revoked = list(entry, "revokedDelegationIds");
    let revocations = list(entry, "delegationRevocations");
    let trust = Trust {
        stream_event: &entry["streamEvent"],
        swarm_id: entry["swarmId"].as_str().expect("swarmId"),
        revoked_delegation_ids: &revoked,
        delegation_revocations: &revocations,
    };
    let result = match op {
        "delegation" => verify_commitment_delegation(entry.get("event"), &trust, at),
        "commitment" => verify_segment_commitment(
            &entry["event"],
            &trust,
            entry["key"].as_str().expect("key"),
            &context(&entry["normalised"]),
            &entry["maxSegmentBytes"],
            entry.get("delegation"),
            at,
        ),
        other => panic!("unknown op {other}"),
    };
    result.map(Value::Object).unwrap_or(Value::Null)
}

#[test]
fn vectors_match_the_javascript_verifier() {
    let vectors = load();
    let at = vectors["at"].as_i64().expect("at");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() > 100);
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|entry| {
            let actual = run(entry, at);
            (actual != entry["expected"]).then(|| format!("{}: expected {} got {}", entry["name"], entry["expected"], actual))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} vectors differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// JSON.parse turns `1.0` into 1 before the event is hashed, so an envelope
/// written with `1.0` must verify exactly as the integer form does.
#[test]
fn integral_float_envelope_fields_verify_like_their_integer_form() {
    let vectors = load();
    let stream = vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "stream: valid")
        .unwrap()["event"]
        .clone();
    let text = serde_json::to_string(&stream).unwrap();
    let created = stream["created_at"].as_i64().unwrap();
    let floated = text.replace(&format!("\"created_at\":{created}"), &format!("\"created_at\":{created}.0"));
    let kinded = floated.replace("\"kind\":30311", "\"kind\":3.0311e4");
    assert_ne!(text, kinded);
    assert!(valid_stream_authorisation(&serde_json::from_str(&kinded).unwrap()));
}
