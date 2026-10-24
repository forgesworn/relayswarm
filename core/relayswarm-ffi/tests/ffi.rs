//! The facade gives the same answers as the core it wraps: the shared
//! commitment vectors, and a scripted multi-holder transfer replayed through
//! both.

use relayswarm_ffi as ffi;
use relayswarm_proto::pieces::{piece_count, range_bytes, PieceRange};
use relayswarm_proto::scheduler::{self, Command, Estimate, Source, TransferConfig};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/commitments.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors file")).expect("vectors JSON")
}

fn verify(entry: &Value, at: i64) -> Value {
    let event = entry["event"].to_string();
    let mut options = json!({ "streamEvent": entry["streamEvent"], "swarmId": entry["swarmId"] });
    for name in [
        "revokedDelegationIds",
        "delegationRevocations",
        "key",
        "maxSegmentBytes",
        "delegation",
    ] {
        if let Some(value) = entry.get(name) {
            options[name] = value.clone();
        }
    }
    options["context"] = entry["normalised"].clone();
    let options = options.to_string();
    let parsed = |text: Option<String>| {
        text.map(|text| serde_json::from_str(&text).expect("content JSON"))
            .unwrap_or(Value::Null)
    };
    match entry["op"].as_str().expect("op") {
        "stream" => {
            if ffi::valid_stream_authorisation(event) {
                json!(true)
            } else {
                Value::Null
            }
        }
        "delegation" => parsed(ffi::verify_commitment_delegation(event, options, at)),
        "commitment" => parsed(ffi::verify_segment_commitment(event, options, at)),
        other => panic!("unknown op {other}"),
    }
}

#[test]
fn the_facade_matches_the_javascript_verifier_vectors() {
    let vectors = vectors();
    let at = vectors["at"].as_i64().expect("at");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() > 100);
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|entry| {
            let actual = verify(entry, at);
            (actual != entry["expected"]).then(|| format!("{}: expected {} got {}", entry["name"], entry["expected"], actual))
        })
        .collect();
    assert!(failures.is_empty(), "{} vectors differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn malformed_json_is_rejection() {
    assert!(!ffi::valid_stream_authorisation("{".into()));
    assert_eq!(ffi::verify_segment_commitment("{}".into(), "not json".into(), 0), None);
    assert_eq!(ffi::verify_commitment_delegation("[".into(), "{}".into(), 0), None);
}

#[test]
fn piece_helpers_match_the_core() {
    for size in [1, 65_535, 65_536, 1_000_000, 16 * 1024 * 1024] {
        assert_eq!(ffi::piece_count(size), piece_count(size));
        let count = piece_count(size).unwrap();
        let span = ffi::PieceSpan { start: 0, end: count };
        assert_eq!(ffi::piece_span_bytes(size, span), Some(ffi::ByteSpan { from: 0, to: size }));
        assert_eq!(ffi::piece_span_bytes(size, ffi::PieceSpan { start: 0, end: count + 1 }), None);
    }
    assert_eq!(ffi::piece_count(0), None);
}

const SIZE: u64 = 6 * 65_536 + 1_000;

fn object() -> Vec<u8> {
    (0..SIZE).map(|i| (i * 7 + 1) as u8).collect()
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn commitment(object: &[u8]) -> (String, Vec<String>) {
    let piece = ffi::commitment_piece_size(SIZE) as usize;
    (hex(object), object.chunks(piece).map(hex).collect())
}

/// One answer the script delivers: when, from whom, and whether it is corrupt.
#[derive(Clone, Copy)]
struct Pending {
    at: u64,
    source: Source,
    range: PieceRange,
}

/// A scripted swarm: peer 1 answers in 40 ms, peer 2 in 90 ms but corrupts its
/// first answer, origin in 30 ms. Each step goes to `apply`, which returns the
/// commands as the core's own type.
fn script(mut apply: impl FnMut(u64, Step) -> Vec<Command>) -> Vec<Command> {
    let object = object();
    let delay = |source: Source| match source {
        Source::Peer(1) => 40,
        Source::Peer(_) => 90,
        Source::Origin => 30,
    };
    let mut log = Vec::new();
    let mut queue: Vec<Pending> = Vec::new();
    let mut corrupted = false;
    let handle = |at: u64, commands: Vec<Command>, queue: &mut Vec<Pending>, log: &mut Vec<Command>| {
        for command in &commands {
            match *command {
                Command::Request { peer, range } => queue.push(Pending {
                    at: at + delay(Source::Peer(peer)),
                    source: Source::Peer(peer),
                    range,
                }),
                Command::FetchOrigin { range } => queue.push(Pending {
                    at: at + delay(Source::Origin),
                    source: Source::Origin,
                    range,
                }),
                Command::Cancel { peer } | Command::Abandon { peer } | Command::Ban { peer } => {
                    queue.retain(|p| p.source != Source::Peer(peer))
                }
                _ => {}
            }
        }
        log.extend(commands);
    };
    let started = apply(10, Step::Start);
    handle(10, started, &mut queue, &mut log);
    while !queue.is_empty() {
        queue.sort_by_key(|p| p.at);
        let next = queue.remove(0);
        let (from, to) = range_bytes(SIZE, next.range).expect("range");
        let mut bytes = object[from as usize..to as usize].to_vec();
        if next.source == Source::Peer(2) && !corrupted {
            corrupted = true;
            bytes[0] ^= 0xff;
        }
        let commands = apply(next.at, Step::Delivered(next.source, next.range, bytes));
        let done = commands.iter().any(|c| matches!(c, Command::Deliver(_) | Command::Fail));
        handle(next.at, commands, &mut queue, &mut log);
        if done {
            break;
        }
    }
    log
}

enum Step {
    Start,
    Delivered(Source, PieceRange, Vec<u8>),
}

fn back(command: ffi::TransferCommand) -> Command {
    let range = |span: ffi::PieceSpan| PieceRange {
        start: span.start,
        end: span.end,
    };
    match command {
        ffi::TransferCommand::Request { peer, span } => Command::Request { peer, range: range(span) },
        ffi::TransferCommand::FetchOrigin { span } => Command::FetchOrigin { range: range(span) },
        ffi::TransferCommand::Cancel { peer } => Command::Cancel { peer },
        ffi::TransferCommand::Abandon { peer } => Command::Abandon { peer },
        ffi::TransferCommand::Ban { peer } => Command::Ban { peer },
        ffi::TransferCommand::Deliver { bytes } => Command::Deliver(bytes),
        ffi::TransferCommand::Fail => Command::Fail,
    }
}

fn to_ffi(source: Source) -> ffi::TransferSource {
    match source {
        Source::Peer(peer) => ffi::TransferSource::Peer { peer },
        Source::Origin => ffi::TransferSource::Origin,
    }
}

#[test]
fn a_transfer_through_the_facade_issues_the_cores_commands() {
    let (sha256, pieces) = commitment(&object());
    let piece_refs: Vec<&str> = pieces.iter().map(String::as_str).collect();
    let deadline = 4_000;

    let mut core = scheduler::Transfer::new(
        TransferConfig {
            max_holders: 3,
            origin_reserve_ms: 0.0,
        },
        SIZE,
        &sha256,
        &piece_refs,
        deadline,
    )
    .unwrap();
    let expected = script(|now, step| {
        match step {
            Step::Start => core.start(
                now,
                &[
                    Estimate {
                        source: Source::Peer(1),
                        first_byte_ms: None,
                        rate: Some(1_000.0),
                    },
                    Estimate {
                        source: Source::Peer(2),
                        first_byte_ms: None,
                        rate: None,
                    },
                ],
                Estimate {
                    source: Source::Origin,
                    first_byte_ms: None,
                    rate: Some(500.0),
                },
                Some(20.0),
                Some(1_000.0),
            ),
            Step::Delivered(source, range, bytes) => core.delivered(now, source, range, &bytes),
        }
        core.drain_commands()
    });

    let settings = ffi::TransferSettings {
        max_holders: 3,
        origin_reserve_ms: 0.0,
    };
    let facade = ffi::Transfer::new(settings, SIZE, sha256.clone(), pieces.clone(), deadline).unwrap();
    let actual = script(|now, step| {
        let state = match step {
            Step::Start => facade.start(
                now,
                vec![
                    ffi::PeerTiming {
                        peer: 1,
                        timing: ffi::Timing {
                            first_byte_ms: None,
                            rate: Some(1_000.0),
                        },
                    },
                    ffi::PeerTiming {
                        peer: 2,
                        timing: ffi::Timing {
                            first_byte_ms: None,
                            rate: None,
                        },
                    },
                ],
                ffi::Timing {
                    first_byte_ms: None,
                    rate: Some(500.0),
                },
                ffi::Timing {
                    first_byte_ms: Some(20.0),
                    rate: Some(1_000.0),
                },
            ),
            Step::Delivered(source, range, bytes) => facade.delivered(
                now,
                to_ffi(source),
                ffi::PieceSpan {
                    start: range.start,
                    end: range.end,
                },
                bytes,
            ),
        };
        state.commands.into_iter().map(back).collect()
    });

    assert_eq!(actual, expected);
    assert!(
        expected.iter().any(|c| matches!(c, Command::Ban { peer: 2 })),
        "the corrupt piece bans peer 2"
    );
    assert!(matches!(expected.last(), Some(Command::Deliver(bytes)) if *bytes == object()));
}

#[test]
fn a_piece_list_that_does_not_fit_is_an_error() {
    let settings = ffi::TransferSettings {
        max_holders: ffi::DEFAULT_MAX_HOLDERS,
        origin_reserve_ms: ffi::DEFAULT_ORIGIN_RESERVE_MS,
    };
    let (sha256, mut pieces) = commitment(&object());
    pieces.pop();
    assert!(matches!(
        ffi::Transfer::new(settings, SIZE, sha256, pieces, 1_000),
        Err(ffi::CoreError::InvalidTransfer)
    ));
}

/// Reverses every object's keys, as a host serialising a dictionary might.
fn reversed(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(object.iter().rev().map(|(k, v)| (k.clone(), reversed(v))).collect()),
        other => other.clone(),
    }
}

#[test]
fn the_media_context_may_arrive_in_any_key_order() {
    let vectors = vectors();
    let at = vectors["at"].as_i64().expect("at");
    let encrypted: Vec<&Value> = vectors["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|entry| entry["normalised"]["media"]["encryption"].is_object() && !entry["expected"].is_null())
        .collect();
    assert!(!encrypted.is_empty());
    for entry in encrypted {
        let mut shuffled = entry.clone();
        shuffled["normalised"] = reversed(&entry["normalised"]);
        assert_eq!(verify(&shuffled, at), entry["expected"], "{}", entry["name"]);
    }
}
