//! The peer link through the facade: every recorded trace from the
//! JavaScript PeerLink, and a framing 2 exchange checked against the core.

use relayswarm_ffi::{self as ffi, LinkSettings, PeerLink, PeerLinkEvent, PieceSpan};
use relayswarm_proto::link::{Link, LinkConfig};
use relayswarm_proto::pieces::{range_bytes, PieceRange};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const EPOCH: u64 = 1_792_000_000_000;

fn bytes(spec: &Value) -> Vec<u8> {
    let len = spec["len"].as_u64().unwrap() as usize;
    let seed = spec["seed"].as_u64().unwrap() as usize;
    (0..len).map(|index| ((seed + index * 31) & 255) as u8).collect()
}

fn fingerprint(bytes: &[u8]) -> Value {
    json!({ "len": bytes.len(), "sha": &format!("{:x}", Sha256::digest(bytes))[..16] })
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

fn outcome(outcome: ffi::RequestOutcome) -> &'static str {
    use ffi::RequestOutcome as O;
    match outcome {
        O::Payload => "payload",
        O::None => "none",
        O::Timeout => "timeout",
        O::Abort => "abort",
        O::Abandoned => "abandoned",
        O::Closed => "closed",
        O::Busy => "busy",
        O::SendError => "send-error",
    }
}

/// Events in the recorder's order: resolutions land after the step's other
/// events, as promise settlement does.
fn record(events: Vec<PeerLinkEvent>) -> Vec<Value> {
    let (mut log, mut resolutions) = (Vec::new(), Vec::new());
    for event in events {
        match event {
            PeerLinkEvent::SendText { text } => log.push(json!({ "sendText": text })),
            PeerLinkEvent::SendBinary { bytes } => log.push(json!({ "sendBinary": fingerprint(&bytes) })),
            PeerLinkEvent::Closed { reason } => log.push(json!({ "closed": reason })),
            PeerLinkEvent::Report { report } => log.push(json!({ "result": {
                "outcome": outcome(report.outcome), "receivedBytes": report.received_bytes,
                "metadataReceived": report.metadata_received, "draining": report.draining, "closeReason": report.close_reason } })),
            PeerLinkEvent::Resolved { bytes, .. } => resolutions.push(json!({ "resolved": bytes.as_deref().map(fingerprint) })),
            PeerLinkEvent::HaveChanged { keys } => log.push(json!({ "haveChanged": keys })),
            PeerLinkEvent::ScheduleChanged => log.push(json!({ "scheduleChanged": true })),
            PeerLinkEvent::ServeRequest { key } => log.push(json!({ "serveRequest": key })),
            PeerLinkEvent::ServeRange { key, span } => log.push(json!({ "serveRange": [key, span.start, span.end] })),
            PeerLinkEvent::UploadCancelled { bytes } => log.push(json!({ "uploadCancelled": bytes })),
            PeerLinkEvent::Progress { received, size } => log.push(json!({ "progress": [received, size] })),
        }
    }
    log.extend(resolutions);
    log
}

fn state(link: &PeerLink, update: &ffi::LinkUpdate) -> Value {
    let sets = link.sets();
    let timed = |keys: &[ffi::TimedKey]| keys.iter().map(|entry| json!([entry.key, entry.at])).collect::<Vec<_>>();
    json!({
        "have": sets.have, "fetching": timed(&sets.fetching), "renditions": timed(&sets.renditions),
        "serving": sets.serving, "rendition": sets.rendition, "busy": update.busy,
        "outboundInFlight": update.outbound_in_flight, "closed": update.closed,
        "bytesIn": update.bytes_in, "bytesOut": update.bytes_out,
    })
}

fn replay(trace: &Value) -> Vec<String> {
    let config = &trace["config"];
    let link = PeerLink::new(
        LinkSettings {
            max_segment_bytes: config["maxSegmentBytes"].as_u64().unwrap(),
            max_queued_requests: config["maxQueuedRequests"].as_u64().unwrap() as u32,
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
        let mut events = Vec::new();
        let update = if let Some(text) = input.get("text") {
            link.handle_text(now, text.as_str().unwrap().to_owned())
        } else if let Some(spec) = input.get("binary") {
            link.handle_binary(now, bytes(spec))
        } else if let Some(request) = input.get("request") {
            let update = link.request(
                now,
                request["key"].as_str().unwrap().to_owned(),
                request["timeoutMs"].as_u64().unwrap(),
                request.get("expectedSize").and_then(Value::as_u64),
            );
            last_request = update.request_id.or(last_request);
            update
        } else if let Some(kind) = input.get("abort") {
            match last_request {
                Some(id) => link.abort(now, id, kind == "abandon"),
                None => link.state(),
            }
        } else if let Some(ms) = input.get("advance") {
            let target = now + ms.as_u64().unwrap();
            let mut update = link.state();
            events.append(&mut update.events);
            while let Some(deadline) = update.next_deadline.filter(|deadline| *deadline <= target) {
                now = now.max(deadline);
                update = link.tick(deadline);
                events.append(&mut update.events);
            }
            now = target;
            update
        } else if let Some(spec) = input.get("serve") {
            link.serve_response(now, (!spec.is_null()).then(|| bytes(spec)))
        } else if input.get("drain").is_some() {
            link.buffered_amount_low(now, 0)
        } else if let Some(reason) = input.get("close") {
            link.close_link(reason.as_str().unwrap().to_owned())
        } else if let Some(keys) = input.get("sendHave") {
            link.send_have(strings(keys))
        } else if let Some(change) = input.get("sendHaveChange") {
            link.send_have_change(strings(&change["add"]), strings(&change["del"]))
        } else if let Some(message) = input.get("sendContribution") {
            link.send_contribution(
                message["serving"].as_bool().unwrap(),
                message["rendition"].as_str().map(str::to_owned),
            )
        } else if let Some(message) = input.get("sendFetching") {
            link.send_fetching(message["k"].as_str().unwrap().to_owned(), message["ms"].as_u64().unwrap())
        } else {
            panic!("unknown input {input}");
        };
        let mut update = update;
        events.append(&mut update.events);
        let events = Value::from(record(events));
        if events != expected["events"] {
            differences.push(format!(
                "{} step {index}: events\n  expected {}\n  got      {}",
                trace["name"], expected["events"], events
            ));
        }
        let snapshot = state(&link, &update);
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
fn the_facade_replays_every_javascript_link_trace() {
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

const KEY: &str = "975052b682de73552ef5e56de7f57f1e60e96e807a40c129310b944f8685abda";

fn settings() -> LinkSettings {
    LinkSettings {
        max_segment_bytes: 1024 * 1024,
        max_queued_requests: 4,
        drain_timeout_ms: 10_000,
        reliable: true,
    }
}

fn config() -> LinkConfig {
    LinkConfig {
        max_segment_bytes: 1024 * 1024,
        max_queued_requests: 4,
        drain_timeout_ms: 10_000,
        reliable: true,
    }
}

/// Frames one side sends, for the other side.
fn frames(events: &[PeerLinkEvent]) -> Vec<PeerLinkEvent> {
    events
        .iter()
        .filter(|event| matches!(event, PeerLinkEvent::SendText { .. } | PeerLinkEvent::SendBinary { .. }))
        .cloned()
        .collect()
}

#[test]
fn a_piece_range_exchange_matches_the_core() {
    let size = 200_000u64;
    let object: Vec<u8> = (0..size as usize).map(|index| ((index * 31 + 7) & 255) as u8).collect();
    let span = PieceSpan { start: 1, end: 3 };

    // Through the facade.
    let (requester, holder) = (PeerLink::new(settings(), EPOCH), PeerLink::new(settings(), EPOCH));
    let mut log = Vec::new();
    let asked = requester.request_range(EPOCH, KEY.to_owned(), 5_000, span, size);
    assert_eq!(asked.request_id, Some(1));
    log.extend(asked.events.clone());
    let mut to_holder = frames(&asked.events);
    let mut to_requester = Vec::new();
    let mut resolved = None;
    for _ in 0..64 {
        for frame in to_holder.drain(..) {
            let PeerLinkEvent::SendText { text } = frame else { unreachable!() };
            let update = holder.handle_text(EPOCH, text);
            log.extend(update.events.clone());
            for event in &update.events {
                if let PeerLinkEvent::ServeRange { key, span: wanted } = event {
                    assert_eq!((key.as_str(), *wanted), (KEY, span));
                    let served = holder.serve_response(EPOCH, Some(object.clone()));
                    log.extend(served.events.clone());
                    to_requester.extend(frames(&served.events));
                }
            }
        }
        if to_requester.is_empty() {
            let drained = holder.buffered_amount_low(EPOCH, 0);
            log.extend(drained.events.clone());
            to_requester.extend(frames(&drained.events));
        }
        for frame in to_requester.drain(..) {
            let update = match frame {
                PeerLinkEvent::SendText { text } => requester.handle_text(EPOCH, text),
                PeerLinkEvent::SendBinary { bytes } => requester.handle_binary(EPOCH, bytes),
                _ => unreachable!(),
            };
            log.extend(update.events.clone());
            for event in update.events {
                if let PeerLinkEvent::Resolved { bytes, .. } = event {
                    resolved = Some(bytes);
                }
            }
        }
        if resolved.is_some() {
            break;
        }
    }
    let (from, to) = range_bytes(size, PieceRange { start: 1, end: 3 }).unwrap();
    assert_eq!(resolved, Some(Some(object[from as usize..to as usize].to_vec())));

    // The same exchange on the core's links, converted with the facade's own
    // mapping: the facade adds nothing and drops nothing.
    let (mut requester, mut holder) = (Link::new(config(), EPOCH), Link::new(config(), EPOCH));
    let mut core_log: Vec<PeerLinkEvent> = Vec::new();
    let mut take = |link: &mut Link| -> Vec<PeerLinkEvent> {
        let events: Vec<PeerLinkEvent> = link.drain_events().into_iter().map(Into::into).collect();
        core_log.extend(events.clone());
        events
    };
    requester.request_range(EPOCH, KEY, 5_000, PieceRange { start: 1, end: 3 }, size);
    let mut to_holder = frames(&take(&mut requester));
    let mut to_requester = Vec::new();
    let mut done = false;
    for _ in 0..64 {
        for frame in to_holder.drain(..) {
            let PeerLinkEvent::SendText { text } = frame else { unreachable!() };
            holder.handle_text(EPOCH, &text);
            let events = take(&mut holder);
            if events.iter().any(|event| matches!(event, PeerLinkEvent::ServeRange { .. })) {
                holder.serve_response(EPOCH, Some(object.clone()));
                to_requester.extend(frames(&take(&mut holder)));
            }
        }
        if to_requester.is_empty() {
            holder.buffered_amount_low(EPOCH, 0);
            to_requester.extend(frames(&take(&mut holder)));
        }
        for frame in to_requester.drain(..) {
            match frame {
                PeerLinkEvent::SendText { text } => requester.handle_text(EPOCH, &text),
                PeerLinkEvent::SendBinary { bytes } => requester.handle_binary(EPOCH, &bytes),
                _ => unreachable!(),
            }
            done |= take(&mut requester)
                .iter()
                .any(|event| matches!(event, PeerLinkEvent::Resolved { .. }));
        }
        if done {
            break;
        }
    }
    assert_eq!(log, core_log);
}

#[test]
fn link_limits_are_the_cores() {
    let limits = ffi::link_limits();
    assert_eq!(limits.chunk_bytes, relayswarm_proto::link::CHUNK_BYTES as u64);
    assert_eq!(limits.low_water_bytes, relayswarm_proto::link::LOW_WATER_BYTES);
    assert_eq!(limits.high_water_bytes, relayswarm_proto::link::HIGH_WATER_BYTES);
    assert_eq!(limits.max_have_keys as usize, relayswarm_proto::link::MAX_HAVE_KEYS);
}
