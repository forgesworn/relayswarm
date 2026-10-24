//! Framing 2: piece ranges on `want` and `meta`. The JavaScript link has no
//! ranges, so these cases are written against the Rust link directly.

use relayswarm_proto::link::{Link, LinkConfig, LinkEvent, Outcome};
use relayswarm_proto::pieces::{piece_count, range_bytes, PieceRange};
use serde_json::{json, Value};

const NOW: u64 = 1_792_000_000_000;
const KEY: &str = "975052b682de73552ef5e56de7f57f1e60e96e807a40c129310b944f8685abda";
const SIZE: usize = 200_000;

fn config() -> LinkConfig {
    LinkConfig {
        max_segment_bytes: 1024 * 1024,
        max_queued_requests: 4,
        drain_timeout_ms: 10_000,
        reliable: true,
    }
}

fn object(len: usize) -> Vec<u8> {
    (0..len).map(|index| ((index * 31 + 7) & 255) as u8).collect()
}

const fn range(start: u32, end: u32) -> PieceRange {
    PieceRange { start, end }
}

fn texts(events: &[LinkEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| match event {
            LinkEvent::SendText(text) => Some(serde_json::from_str(text).unwrap()),
            _ => None,
        })
        .collect()
}

fn closed(events: &[LinkEvent]) -> Option<&'static str> {
    events.iter().find_map(|event| match event {
        LinkEvent::Closed(reason) => Some(*reason),
        _ => None,
    })
}

fn resolved(events: &[LinkEvent]) -> Option<Option<Vec<u8>>> {
    events.iter().find_map(|event| match event {
        LinkEvent::Resolved { bytes, .. } => Some(bytes.clone()),
        _ => None,
    })
}

/// A holder answers one want, draining as the channel reports space.
fn serve(holder: &mut Link, want: Value, bytes: Option<Vec<u8>>) -> Vec<LinkEvent> {
    holder.handle_text(NOW, &want.to_string());
    let mut events = holder.drain_events();
    if events
        .iter()
        .any(|event| matches!(event, LinkEvent::ServeRequest(key) | LinkEvent::ServeRange { key, .. } if key == KEY))
    {
        holder.serve_response(NOW, bytes);
        for _ in 0..64 {
            holder.buffered_amount_low(NOW, 0);
        }
        events.extend(holder.drain_events());
    }
    events
}

/// Deliver the holder's frames to the requester.
fn deliver(requester: &mut Link, events: &[LinkEvent]) -> Vec<LinkEvent> {
    for event in events {
        match event {
            LinkEvent::SendText(text) => requester.handle_text(NOW, text),
            LinkEvent::SendBinary(chunk) => requester.handle_binary(NOW, chunk),
            _ => {}
        }
    }
    requester.drain_events()
}

#[test]
fn a_holder_serves_exactly_the_requested_pieces() {
    let bytes = object(SIZE);
    let mut holder = Link::new(config(), NOW);
    let events = serve(
        &mut holder,
        json!({ "t": "want", "id": 9, "k": KEY, "p": [1, 3] }),
        Some(bytes.clone()),
    );
    let sent = texts(&events);
    assert_eq!(sent[0], json!({ "t": "meta", "id": 9, "size": 131_072, "p": [1, 3] }));
    assert_eq!(sent.last().unwrap(), &json!({ "t": "eof", "id": 9 }));
    let body: Vec<u8> = events
        .iter()
        .filter_map(|event| match event {
            LinkEvent::SendBinary(chunk) => Some(chunk.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(body, bytes[65_536..196_608]);
    assert_eq!(holder.bytes_out(), 131_072);
    assert!(events.contains(&LinkEvent::ServeRange {
        key: KEY.into(),
        range: range(1, 3)
    }));
    assert!(!holder.closed());
}

#[test]
fn a_holder_answers_none_for_pieces_its_object_lacks() {
    let mut holder = Link::new(config(), NOW);
    let events = serve(
        &mut holder,
        json!({ "t": "want", "id": 1, "k": KEY, "p": [3, 5] }),
        Some(object(SIZE)),
    );
    assert_eq!(texts(&events), vec![json!({ "t": "none", "id": 1 })]);
    assert!(!holder.closed());
    // The queue moves on: a whole-object want still works.
    let events = serve(&mut holder, json!({ "t": "want", "id": 2, "k": KEY }), Some(object(SIZE)));
    assert_eq!(texts(&events)[0], json!({ "t": "meta", "id": 2, "size": SIZE }));
}

#[test]
fn a_malformed_range_closes_the_holder_link() {
    for p in [
        json!([3, 3]),
        json!([4, 3]),
        json!([0, 65]),
        json!([-1, 2]),
        json!([0.5, 2]),
        json!([0]),
        json!([0, 1, 2]),
        json!("0-1"),
        json!(null),
    ] {
        let mut holder = Link::new(config(), NOW);
        holder.handle_text(NOW, &json!({ "t": "want", "id": 1, "k": KEY, "p": p }).to_string());
        assert_eq!(closed(&holder.drain_events()), Some("protocol"), "p = {p}");
    }
}

#[test]
fn a_requester_receives_a_range_end_to_end() {
    let bytes = object(SIZE);
    let mut requester = Link::new(config(), NOW);
    let mut holder = Link::new(config(), NOW);
    let mut assembled = Vec::new();
    for piece_range in [range(0, 2), range(2, 3), range(3, 4)] {
        let id = requester.request_range(NOW, KEY, 5_000, piece_range, SIZE as u64).unwrap();
        let want = texts(&requester.drain_events()).remove(0);
        assert_eq!(
            want,
            json!({ "t": "want", "id": id, "k": KEY, "p": [piece_range.start, piece_range.end] })
        );
        let served = serve(&mut holder, want, Some(bytes.clone()));
        let received = deliver(&mut requester, &served);
        let part = resolved(&received).unwrap().unwrap();
        let (from, to) = range_bytes(SIZE as u64, piece_range).unwrap();
        assert_eq!(part, bytes[from as usize..to as usize]);
        assembled.extend(part);
    }
    assert_eq!(assembled, bytes);
    assert_eq!(piece_count(SIZE as u64), Some(4));
    assert!(!requester.closed() && !holder.closed());
}

#[test]
fn a_framing_1_answer_to_a_range_closes_the_requester_link() {
    // A framing 1 holder ignores the range and sends the whole object.
    let mut requester = Link::new(config(), NOW);
    let id = requester.request_range(NOW, KEY, 5_000, range(1, 2), SIZE as u64).unwrap();
    requester.drain_events();
    requester.handle_text(NOW, &json!({ "t": "meta", "id": id, "size": SIZE }).to_string());
    let events = requester.drain_events();
    assert_eq!(closed(&events), Some("protocol"));
    assert!(events
        .iter()
        .any(|event| matches!(event, LinkEvent::Report(report) if report.outcome == Outcome::Closed)));
}

#[test]
fn a_range_answer_must_echo_the_range_and_its_exact_size() {
    for meta in [
        json!({ "t": "meta", "id": 1, "size": 65_536, "p": [2, 3] }),
        json!({ "t": "meta", "id": 1, "size": 65_537, "p": [1, 2] }),
        json!({ "t": "meta", "id": 1, "size": 65_536, "p": [1, 2, 3] }),
    ] {
        let mut requester = Link::new(config(), NOW);
        assert_eq!(requester.request_range(NOW, KEY, 5_000, range(1, 2), SIZE as u64), Some(1));
        requester.drain_events();
        requester.handle_text(NOW, &meta.to_string());
        assert_eq!(closed(&requester.drain_events()), Some("protocol"), "meta = {meta}");
    }
}

#[test]
fn a_range_outside_the_object_is_not_requested() {
    let mut requester = Link::new(config(), NOW);
    assert_eq!(requester.request_range(NOW, KEY, 5_000, range(3, 5), SIZE as u64), None);
    assert_eq!(requester.request_range(NOW, KEY, 5_000, range(0, 1), 0), None);
    assert!(requester.drain_events().is_empty());
    assert!(!requester.busy());
}

#[test]
fn a_matching_cancel_ends_a_backpressured_range_without_a_low_water_event() {
    let size = 6 * 1024 * 1024;
    let bytes = object(size);
    let mut holder = Link::new(
        LinkConfig {
            max_segment_bytes: size as u64,
            drain_timeout_ms: 3_000,
            ..config()
        },
        NOW,
    );
    holder.handle_text(NOW, &json!({ "t": "want", "id": 7, "k": KEY, "p": [0, 64] }).to_string());
    holder.drain_events();
    holder.serve_response(NOW, Some(bytes));
    let queued = holder.drain_events();
    let sent: u64 = queued
        .iter()
        .filter_map(|event| match event {
            LinkEvent::SendBinary(bytes) => Some(bytes.len() as u64),
            _ => None,
        })
        .sum();
    assert!(sent > 128 * 1024 && sent < size as u64);
    assert!(holder.upload_waiting());

    for id in [json!(8), json!("7"), json!(7.5), Value::Null] {
        holder.handle_text(NOW + 100, &json!({ "t": "cancel", "id": id }).to_string());
        assert!(holder.drain_events().is_empty(), "an unmatched cancel cannot bypass backpressure");
        assert!(holder.upload_waiting());
    }
    holder.handle_text(NOW + 100, &json!({ "t": "cancel", "id": 7 }).to_string());
    let cancelled = holder.drain_events();
    assert_eq!(texts(&cancelled), vec![json!({ "t": "eof", "id": 7 })]);
    assert!(cancelled.iter().all(|event| !matches!(event, LinkEvent::SendBinary(_))));
    assert!(cancelled.contains(&LinkEvent::UploadCancelled(size as u64 - sent)));
    assert_eq!(holder.bytes_out(), sent);
    assert_eq!(holder.outbound_in_flight(), 0);
    assert_eq!(holder.next_deadline(), None);
    holder.tick(NOW + 10_000);
    assert!(!holder.closed(), "the cancelled upload no longer owns a drain timer");
    holder.buffered_amount_low(NOW + 10_000, 0);
    assert!(
        holder.drain_events().is_empty(),
        "a late low-water event cannot resume the cancelled upload"
    );

    holder.handle_text(NOW + 10_001, &json!({ "t": "want", "id": 9, "k": KEY, "p": [0, 1] }).to_string());
    holder.drain_events();
    holder.serve_response(NOW + 10_001, Some(object(size)));
    let next = holder.drain_events();
    assert_eq!(texts(&next).last(), Some(&json!({ "t": "eof", "id": 9 })));
    assert_eq!(holder.bytes_out(), sent + 98_304);
    assert!(!holder.closed());
}
