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
        .any(|event| matches!(event, LinkEvent::ServeRequest(key) if key == KEY))
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
