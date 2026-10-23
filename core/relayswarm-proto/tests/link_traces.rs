//! Replays `core/vectors/link-traces.json`, recorded from the real PeerLink.

use relayswarm_proto::link::{Link, LinkConfig, LinkEvent};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const EPOCH: u64 = 1_792_000_000_000;

fn bytes(spec: &Value) -> Vec<u8> {
    let len = spec["len"].as_u64().unwrap() as usize;
    let seed = spec["seed"].as_u64().unwrap() as usize;
    (0..len).map(|index| ((seed + index * 31) & 255) as u8).collect()
}

fn fingerprint(bytes: &[u8]) -> Value {
    json!({ "len": bytes.len(), "sha": &hex::encode(Sha256::digest(bytes))[..16] })
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

/// Events in the recorder's order: resolutions land after the step's other
/// events, as promise settlement does.
fn record(events: Vec<LinkEvent>) -> Vec<Value> {
    let (mut log, mut resolutions) = (Vec::new(), Vec::new());
    for event in events {
        match event {
            LinkEvent::SendText(text) => log.push(json!({ "sendText": text })),
            LinkEvent::SendBinary(chunk) => log.push(json!({ "sendBinary": fingerprint(&chunk) })),
            LinkEvent::Closed(reason) => log.push(json!({ "closed": reason })),
            LinkEvent::Report(report) => log.push(json!({ "result": {
                "outcome": report.outcome.as_str(), "receivedBytes": report.received_bytes,
                "metadataReceived": report.metadata_received, "draining": report.draining, "closeReason": report.close_reason } })),
            LinkEvent::Resolved { bytes, .. } => resolutions.push(json!({ "resolved": bytes.as_deref().map(fingerprint) })),
            LinkEvent::HaveChanged(added) => log.push(json!({ "haveChanged": added })),
            LinkEvent::ScheduleChanged => log.push(json!({ "scheduleChanged": true })),
            LinkEvent::ServeRequest(key) => log.push(json!({ "serveRequest": key })),
            LinkEvent::ServeRange { key, range } => log.push(json!({ "serveRange": [key, range.start, range.end] })),
            LinkEvent::UploadCancelled(bytes) => log.push(json!({ "uploadCancelled": bytes })),
            LinkEvent::Progress { received, size } => log.push(json!({ "progress": [received, size] })),
        }
    }
    log.extend(resolutions);
    log
}

fn state(link: &Link) -> Value {
    let (serving, rendition, _) = link.contribution();
    json!({
        "have": link.have().iter().collect::<Vec<_>>(),
        "fetching": link.fetching().iter().map(|(key, at)| json!([key, at])).collect::<Vec<_>>(),
        "renditions": link.renditions().iter().map(|(key, at)| json!([key, at])).collect::<Vec<_>>(),
        "serving": serving, "rendition": rendition, "busy": link.busy(),
        "outboundInFlight": link.outbound_in_flight(), "closed": link.closed(),
        "bytesIn": link.bytes_in(), "bytesOut": link.bytes_out(),
    })
}

fn replay(trace: &Value) -> Vec<String> {
    let config = &trace["config"];
    let mut link = Link::new(
        LinkConfig {
            max_segment_bytes: config["maxSegmentBytes"].as_u64().unwrap(),
            max_queued_requests: config["maxQueuedRequests"].as_u64().unwrap() as usize,
            drain_timeout_ms: config["drainTimeoutMs"].as_u64().unwrap(),
            reliable: config["reliable"].as_bool().unwrap(),
        },
        EPOCH,
    );
    let (mut now, mut last_request) = (EPOCH, None);
    let mut differences = Vec::new();
    let steps = trace["steps"].as_array().unwrap();
    for (index, (step, expected)) in steps.iter().zip(trace["expected"].as_array().unwrap()).enumerate() {
        let input = &step["in"];
        if let Some(text) = input.get("text") {
            link.handle_text(now, text.as_str().unwrap());
        } else if let Some(spec) = input.get("binary") {
            link.handle_binary(now, &bytes(spec));
        } else if let Some(request) = input.get("request") {
            let expected_size = request.get("expectedSize").and_then(Value::as_u64);
            last_request = link
                .request(
                    now,
                    request["key"].as_str().unwrap(),
                    request["timeoutMs"].as_u64().unwrap(),
                    expected_size,
                )
                .or(last_request);
        } else if let Some(kind) = input.get("abort") {
            if let Some(id) = last_request {
                link.abort(now, id, kind == "abandon");
            }
        } else if let Some(ms) = input.get("advance") {
            let target = now + ms.as_u64().unwrap();
            while let Some(deadline) = link.next_deadline().filter(|deadline| *deadline <= target) {
                now = now.max(deadline);
                link.tick(deadline);
            }
            now = target;
        } else if let Some(spec) = input.get("serve") {
            link.serve_response(now, (!spec.is_null()).then(|| bytes(spec)));
        } else if input.get("drain").is_some() {
            link.buffered_amount_low(now, 0);
        } else if let Some(reason) = input.get("close") {
            link.close(reason.as_str().unwrap());
        } else if let Some(keys) = input.get("sendHave") {
            link.send_have(&strings(keys));
        } else if let Some(change) = input.get("sendHaveChange") {
            link.send_have_change(&strings(&change["add"]), &strings(&change["del"]));
        } else if let Some(message) = input.get("sendContribution") {
            link.send_contribution(message["serving"].as_bool().unwrap(), message["rendition"].as_str());
        } else if let Some(message) = input.get("sendFetching") {
            link.send_fetching(message["k"].as_str().unwrap(), message["ms"].as_u64().unwrap());
        } else {
            panic!("unknown input {input}");
        }
        let events = Value::from(record(link.drain_events()));
        if events != expected["events"] {
            differences.push(format!(
                "{} step {index}: events\n  expected {}\n  got      {}",
                trace["name"], expected["events"], events
            ));
        }
        let snapshot = state(&link);
        if snapshot != expected["state"] {
            differences.push(format!(
                "{} step {index}: state\n  expected {}\n  got      {}",
                trace["name"], expected["state"], snapshot
            ));
        }
    }
    differences
}

#[test]
fn link_traces_match_the_javascript_peer_link() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/link-traces.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let traces = vectors["traces"].as_array().unwrap();
    assert!(traces.len() > 40);
    let differences: Vec<String> = traces.iter().flat_map(replay).collect();
    assert!(
        differences.is_empty(),
        "{} differences:\n{}",
        differences.len(),
        differences.join("\n")
    );
}
