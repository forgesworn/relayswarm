//! Replays seeded PeerSelection and NeighbourDiscovery sequences recorded from
//! the JavaScript by `npm run proto:traces` (written under `core/target/`).

use relayswarm_proto::discovery::{ContextId, MediaType, NeighbourDiscovery};
use relayswarm_proto::selection::{LinkView, PeerSelection};
use serde_json::{json, Value};

const EPOCH: u64 = 1_792_000_000_000;
const LINKS: [&str; 5] = ["l0", "l1", "l2", "l3", "l4"];
const MEDIA: [&str; 3] = ["main", "audio", "video"];

fn pad(name: &str, fill: char) -> String {
    format!("{}{}", fill.to_string().repeat(64 - (name.len() - 1)), &name[1..])
}

/// Deep equality with numbers compared as doubles, as JSON from JavaScript
/// writes integral doubles without a fraction.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, x)| b.get(key).is_some_and(|y| same(x, y))),
        _ => left == right,
    }
}

fn load() -> Option<Value> {
    let path = std::env::var("RELAYSWARM_JS_TRACES")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../target/js-traces/selection-traces.json").to_owned());
    match std::fs::read_to_string(&path) {
        Ok(text) => Some(serde_json::from_str(&text).unwrap()),
        Err(_) if std::env::var("RELAYSWARM_REQUIRE_JS_TRACES").is_err() => {
            eprintln!("skipping: {path} is missing; run npm run proto:traces");
            None
        }
        Err(error) => panic!("{path}: {error}"),
    }
}

fn number(value: Option<f64>) -> Value {
    value.map_or(Value::Null, Value::from)
}

fn selection_step(selection: &PeerSelection, result: Value) -> Value {
    json!({
        "result": result,
        "firstByteMs": number(selection.first_byte_ms()),
        "rate": number(selection.rate()),
        "project": ([0.0, 1000.0, 670000.0].map(|size| number(selection.project_ms(size)))),
        "minimum": selection.minimum_ms(670000.0),
        "lastObservedAt": selection.last_observed_at(),
        "turn": selection.turn(),
        "order": selection.order(),
        "links": (0..LINKS.len() as u64).map(|id| {
            let value = selection.summary(id);
            json!({ "attempts": value.attempts, "latencyMs": number(value.latency_ms),
                "throughputBytesPerSecond": number(value.throughput_bytes_per_second), "failureRate": value.failure_rate,
                "consecutiveFailures": value.consecutive_failures, "lastSelected": value.last_selected,
                "estimate": number(selection.estimate(id, 670000.0)) })
        }).collect::<Vec<_>>(),
    })
}

fn replay_selection(sequence: &Value) -> Vec<String> {
    let mut selection = PeerSelection::new();
    let mut now = EPOCH;
    let pubkeys: Vec<String> = LINKS.iter().map(|name| pad(name, 'e')).collect();
    let mut differences = Vec::new();
    for (index, (op, expected)) in sequence["ops"]
        .as_array()
        .unwrap()
        .iter()
        .zip(sequence["expected"].as_array().unwrap())
        .enumerate()
    {
        let f = |name: &str| op.get(name).and_then(Value::as_f64);
        let mut result = Value::Null;
        match op["op"].as_str().unwrap() {
            "advance" => now += op["ms"].as_u64().unwrap(),
            "observe" => selection.observe(now, f("firstByteMs"), f("bytes").unwrap(), f("flowMs").unwrap(), f("totalFlowMs")),
            "forget" => selection.forget(LINKS.iter().position(|name| *name == op["link"]).unwrap() as u64),
            "record" => {
                let link = LINKS.iter().position(|name| *name == op["link"]).unwrap() as u64;
                selection.record(now, link, f("elapsedMs").unwrap(), f("bytes").unwrap());
            }
            "select" => {
                let key = op["key"].as_str().unwrap();
                let views: Vec<LinkView> = op["links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|state| {
                        let id = LINKS.iter().position(|name| *name == state["name"]).unwrap();
                        LinkView {
                            id: id as u64,
                            pubkey: &pubkeys[id],
                            closed: state["closed"].as_bool().unwrap(),
                            busy: state["busy"].as_bool().unwrap(),
                            has_key: state["has"].as_array().unwrap().iter().any(|has| has == key),
                        }
                    })
                    .collect();
                let tried: Vec<&str> = op["tried"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap())
                    .collect();
                let picked = selection.select(&views, &tried, f("size").unwrap(), f("deadlineMs").unwrap_or(f64::INFINITY));
                result = picked.map_or(Value::Null, |id| Value::from(LINKS[id as usize]));
            }
            other => panic!("unknown op {other}"),
        }
        let actual = selection_step(&selection, result);
        if !same(&actual, expected) {
            differences.push(format!(
                "selection seed {} step {index} {op}\n  expected {expected}\n  got      {actual}",
                sequence["seed"]
            ));
            break;
        }
    }
    differences
}

fn discovery_step(
    discovery: &NeighbourDiscovery,
    now: u64,
    held: &[(MediaType, ContextId)],
    attempt: Option<relayswarm_proto::discovery::AttemptId>,
    result: Value,
    peers: &[String],
) -> Value {
    let held_for = |media: &str| MediaType::parse(media).and_then(|media| held.iter().find(|(m, _)| *m == media).map(|(_, id)| *id));
    let snapshot = discovery.snapshot(now);
    let counters = &snapshot.counters;
    json!({
        "result": result,
        "valid": attempt.map_or(Value::Null, |attempt| Value::from(discovery.valid(now, attempt))),
        "live": discovery.live(now),
        "reserved": discovery.reserved(now),
        "suppresses": peers.iter().map(|pubkey| discovery.suppresses(now, pubkey)).collect::<Vec<_>>(),
        "stale": MEDIA.iter().map(|media| peers.iter().map(|pubkey| discovery.stale(now, held_for(media), pubkey)).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "current": MEDIA.iter().map(|media| held_for(media).map_or(Value::Null, |id| Value::from(discovery.current(now, id)))).collect::<Vec<_>>(),
        "window": discovery.window().map_or(Value::Null, |window| json!({
            "mediaType": window.media_type.as_str(), "createdAt": window.created_at, "expiresAt": window.expires_at,
            "vacant": window.vacant, "victim": window.victim,
            "attempt": window.attempt.as_ref().map_or(Value::Null, |attempt| json!({
                "pubkey": attempt.pubkey, "key": attempt.key, "ticket": attempt.ticket, "dial": attempt.dial })),
        })),
        "contexts": discovery.contexts().map(|context| json!({
            "mediaType": context.media_type.as_str(), "rendition": context.rendition, "keys": context.keys,
            "lastDemandAt": context.last_demand_at, "activityAt": context.activity_at, "spent": context.spent,
            "holders": context.holders.iter().map(|(pubkey, entry)| json!([pubkey, entry.first_miss_at, entry.misses, entry.last_key])).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "candidates": discovery.candidates().map(|candidate| json!([candidate.pubkey, candidate.have, candidate.ticket, candidate.at])).collect::<Vec<_>>(),
        "snapshot": {
            "v": 1, "candidateCapacity": 64, "candidates": snapshot.candidates, "contexts": snapshot.contexts,
            "requestedKeys": snapshot.requested_keys, "replacementSpent": snapshot.replacement_spent, "replacementRearmMs": 20000,
            "opportunityActive": snapshot.opportunity_active, "remainingMs": snapshot.remaining_ms,
            "vacancyReserved": snapshot.vacancy_reserved,
            "counters": { "checks": counters.checks, "replacements": counters.replacements, "expired": counters.expired,
                "opened": counters.opened, "verified": counters.verified, "staleHolder": counters.stale_holder,
                "staleBlocked": counters.stale_blocked, "heldMiss": counters.held_miss, "rearmed": counters.rearmed, "victimUnhelpful": counters.victim_unhelpful, "victimServing": counters.victim_serving, "victimConsumer": counters.victim_consumer, "unmetNoHint": counters.unmet_no_hint, "unmetIneligible": counters.unmet_ineligible },
        },
    })
}

fn replay_discovery(sequence: &Value) -> Vec<String> {
    let mut discovery = NeighbourDiscovery::new();
    let mut now = EPOCH;
    let peers: Vec<String> = ["p0", "p1", "p2", "p3"].iter().map(|name| pad(name, 'c')).collect();
    let mut held: Vec<(MediaType, ContextId)> = Vec::new();
    let mut attempt = None;
    let mut differences = Vec::new();
    for (index, (op, expected)) in sequence["ops"]
        .as_array()
        .unwrap()
        .iter()
        .zip(sequence["expected"].as_array().unwrap())
        .enumerate()
    {
        let s = |name: &str| op[name].as_str().unwrap_or_default().to_owned();
        let hold = |held: &mut Vec<(MediaType, ContextId)>, media: &str, id: ContextId| {
            let media = MediaType::parse(media).unwrap();
            held.retain(|(m, _)| *m != media);
            held.push((media, id));
        };
        let held_for = |held: &[(MediaType, ContextId)], media: &str| {
            MediaType::parse(media).and_then(|media| held.iter().find(|(m, _)| *m == media).map(|(_, id)| *id))
        };
        let mut result = Value::Null;
        match op["op"].as_str().unwrap() {
            "advance" => now += op["ms"].as_u64().unwrap(),
            "context" => {
                let id = discovery.context(now, &s("mediaType"), &s("rendition"));
                if let Some(id) = id {
                    hold(&mut held, &s("mediaType"), id);
                }
                result = Value::from(id.is_some());
            }
            "demand" => {
                if let Some(id) = discovery.demand(now, &s("mediaType"), &s("rendition"), &s("key")) {
                    hold(&mut held, &s("mediaType"), id);
                    result = json!(discovery.contexts().find(|context| context.id == id).unwrap().keys);
                }
            }
            "hint" => {
                let have: Vec<&str> = op["have"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
                discovery.hint(now, &s("pubkey"), &have, op["ticket"].as_str());
            }
            "holderMiss" => {
                let context = held_for(&held, &s("mediaType"));
                discovery.holder_miss(now, context, &s("pubkey"), &s("key"));
                result = Value::from(discovery.stale(now, context, &s("pubkey")));
            }
            "holderAhead" => discovery.holder_ahead(held_for(&held, &s("mediaType")), &s("pubkey")),
            "forget" => discovery.forget(&s("pubkey")),
            "choose" => {
                let eligible: Vec<&str> = op["eligible"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
                let unmet: Vec<&str> = op["unmet"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
                let found = discovery.choose(
                    now,
                    |candidate| eligible.contains(&candidate.pubkey.as_str()),
                    |media| unmet.contains(&media.as_str()),
                    op["room"].as_bool().unwrap(),
                );
                if let Some(found) = found {
                    result = json!({ "mediaType": found.media_type.as_str(), "pubkey": found.candidate.pubkey, "key": found.key });
                    if op["begin"].as_bool().unwrap() {
                        let begun = discovery.begin(now, &found);
                        if begun.is_some() {
                            attempt = begun;
                        }
                        result["begun"] = Value::from(begun.is_some());
                    }
                }
            }
            "replaced" => {
                if let Some(id) = attempt {
                    result = Value::from(discovery.replaced(now, id, op["victim"].as_str()));
                }
            }
            "allocated" => {
                if let Some(id) = attempt {
                    discovery.allocated(id, op["dial"].as_u64().unwrap());
                }
            }
            "abandoned" => {
                if let Some(id) = attempt {
                    discovery.abandoned(id);
                }
            }
            "failed" => discovery.failed(op["dial"].as_u64().unwrap()),
            "end" => result = Value::from(discovery.end()),
            "verified" => result = Value::from(discovery.verified(held_for(&held, &s("mediaType")))),
            "clear" => {
                discovery.clear();
                held.clear();
                attempt = None;
            }
            "noop" => {}
            other => panic!("unknown op {other}"),
        }
        let actual = discovery_step(&discovery, now, &held, attempt, result, &peers);
        if !same(&actual, expected) {
            differences.push(format!(
                "discovery seed {} step {index} {op}\n  expected {expected}\n  got      {actual}",
                sequence["seed"]
            ));
            break;
        }
    }
    differences
}

#[test]
fn selection_and_discovery_match_the_javascript() {
    let Some(traces) = load() else { return };
    let mut differences: Vec<String> = traces["selection"].as_array().unwrap().iter().flat_map(replay_selection).collect();
    differences.extend(traces["discovery"].as_array().unwrap().iter().flat_map(replay_discovery));
    assert!(
        differences.is_empty(),
        "{} sequences differ:\n{}",
        differences.len(),
        differences.join("\n")
    );
}
