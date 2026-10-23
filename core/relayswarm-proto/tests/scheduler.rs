//! Multi-holder planning and transfer (CORE-SPEC section 6). Rust-only, as
//! the JavaScript loader has no counterpart.

use relayswarm_proto::pieces::{piece_count, range_bytes, PieceRange};
use relayswarm_proto::scheduler::{plan, Command, Estimate, Plan, PlanInput, Source, Transfer, TransferConfig, MIN_RATE};
use sha2::{Digest, Sha256};

const MS: f64 = 1.0;

fn peer(id: u64, first_byte_ms: Option<f64>, rate: Option<f64>) -> Estimate {
    Estimate {
        source: Source::Peer(id),
        first_byte_ms,
        rate,
    }
}

fn origin(first_byte_ms: f64, rate: f64) -> Estimate {
    Estimate {
        source: Source::Origin,
        first_byte_ms: Some(first_byte_ms),
        rate: Some(rate),
    }
}

fn input<'a>(size: u64, needed: &'a [u32], peers: &'a [Estimate], origin: Option<Estimate>, available_ms: f64) -> PlanInput<'a> {
    PlanInput {
        size,
        needed,
        peers,
        origin,
        shared_first_byte_ms: None,
        shared_rate: None,
        available_ms,
        max_holders: 3,
    }
}

fn all(size: u64) -> Vec<u32> {
    (0..piece_count(size).unwrap()).collect()
}

fn pieces_of(plan: &Plan, source: Source) -> Vec<u32> {
    plan.assignments
        .iter()
        .filter(|a| a.source == source)
        .flat_map(|a| a.ranges.iter().flat_map(|r| r.start..r.end))
        .collect()
}

fn covered(plan: &Plan) -> Vec<u32> {
    let mut pieces: Vec<u32> = plan
        .assignments
        .iter()
        .flat_map(|a| a.ranges.iter().flat_map(|r| r.start..r.end))
        .collect();
    pieces.sort_unstable();
    pieces
}

#[test]
fn equal_peers_share_the_pieces_evenly() {
    let size = 4 * 65_536;
    let peers = [peer(1, Some(0.0), Some(100.0)), peer(2, Some(0.0), Some(100.0))];
    let planned = plan(&input(size, &all(size), &peers, None, 10_000.0));
    assert_eq!(pieces_of(&planned, Source::Peer(1)), vec![0, 1]);
    assert_eq!(pieces_of(&planned, Source::Peer(2)), vec![2, 3]);
    assert!(!planned.late);
    assert!((planned.projected_ms - 2.0 * 65_536.0 / 100.0).abs() < 1e-9);
}

#[test]
fn faster_peers_take_more_and_go_first() {
    let size = 6 * 65_536;
    let peers = [peer(1, Some(0.0), Some(50.0)), peer(2, Some(0.0), Some(100.0))];
    let planned = plan(&input(size, &all(size), &peers, None, 10_000.0));
    assert_eq!(pieces_of(&planned, Source::Peer(2)), vec![0, 1, 2, 3]);
    assert_eq!(pieces_of(&planned, Source::Peer(1)), vec![4, 5]);
}

#[test]
fn a_slow_first_byte_earns_a_smaller_share() {
    let size = 8 * 65_536;
    // Peer 2 starts 1,311 ms late: two pieces' worth at 100 bytes/ms.
    let peers = [peer(1, Some(0.0), Some(100.0)), peer(2, Some(2.0 * 655.36), Some(100.0))];
    let planned = plan(&input(size, &all(size), &peers, None, 10_000.0));
    assert_eq!(pieces_of(&planned, Source::Peer(1)).len(), 5);
    assert_eq!(pieces_of(&planned, Source::Peer(2)).len(), 3);
}

#[test]
fn an_untested_peer_gets_the_median_of_tested_peers() {
    let size = 5 * 65_536;
    let peers = [
        peer(1, Some(0.0), Some(40.0)),
        peer(2, Some(0.0), Some(100.0)),
        peer(3, Some(0.0), None),
    ];
    let planned = plan(&input(size, &all(size), &peers, None, 100_000.0));
    // Upper median of {40, 100} is 100: peer 3 ties peer 2.
    assert_eq!(
        pieces_of(&planned, Source::Peer(3)).len(),
        pieces_of(&planned, Source::Peer(2)).len()
    );
    // Nothing tested and no shared estimate: the rate floor.
    let untested = [peer(4, None, None)];
    let planned = plan(&input(65_536, &[0], &untested, None, 100_000.0));
    assert!((planned.projected_ms - 65_536.0 / MIN_RATE).abs() < 1e-6);
}

#[test]
fn at_most_max_holders_peers_are_used_and_origin_is_extra() {
    let size = 16 * 65_536;
    let peers: Vec<Estimate> = (1..=5).map(|id| peer(id, Some(0.0), Some(10.0 * id as f64))).collect();
    let planned = plan(&input(size, &all(size), &peers, None, 1e9));
    let used: Vec<Source> = planned.assignments.iter().map(|a| a.source).collect();
    assert_eq!(used, vec![Source::Peer(5), Source::Peer(4), Source::Peer(3)]);
}

#[test]
fn late_peers_hand_the_tail_to_origin_instead_of_declining() {
    // R70's shape: about 670 KB at about 190 KB/s with 1.86 s left.
    let size = 675_108;
    let peers = [peer(1, Some(700.0), Some(190.0))];
    let alone = plan(&input(size, &all(size), &peers, None, 1_860.0));
    assert!(alone.late);
    let planned = plan(&input(size, &all(size), &peers, Some(origin(150.0, 1_000.0)), 1_860.0));
    assert!(!planned.late, "{planned:?}");
    let tail = pieces_of(&planned, Source::Origin);
    assert!(tail.contains(&(piece_count(size).unwrap() - 1)), "origin takes the tail");
    assert_eq!(planned.assignments.last().unwrap().source, Source::Origin);
    assert_eq!(covered(&planned), all(size));
}

#[test]
fn gaps_in_the_needed_pieces_become_separate_ranges() {
    let size = 8 * 65_536;
    let needed = [0, 1, 4, 5, 7];
    let peers = [peer(1, Some(0.0), Some(100.0))];
    let planned = plan(&input(size, &needed, &peers, None, 1e9));
    assert_eq!(
        planned.assignments[0].ranges,
        vec![
            PieceRange { start: 0, end: 2 },
            PieceRange { start: 4, end: 6 },
            PieceRange { start: 7, end: 8 }
        ]
    );
    assert_eq!(planned.assignments[0].bytes, 5 * 65_536);
}

#[test]
fn without_peers_origin_takes_everything_and_without_either_the_plan_is_late() {
    let size = 3 * 65_536;
    let planned = plan(&input(size, &all(size), &[], Some(origin(100.0, 500.0)), 1e9));
    assert_eq!(pieces_of(&planned, Source::Origin), all(size));
    let nothing = plan(&input(size, &all(size), &[], None, 1e9));
    assert!(nothing.late && nothing.assignments.is_empty());
}

#[test]
fn every_needed_piece_is_assigned_exactly_once() {
    let mut seed: u64 = 0x5eed;
    let mut next = move || {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        seed >> 33
    };
    for _ in 0..2_000 {
        let size = 1 + next() % (16 * 1024 * 1024);
        let count = piece_count(size).unwrap();
        let needed: Vec<u32> = (0..count).filter(|_| next() % 4 != 0).collect();
        let peers: Vec<Estimate> = (0..next() % 6)
            .map(|id| {
                let rate = (next() % 3 != 0).then(|| 1.0 + (next() % 2_000) as f64);
                let first_byte = (next() % 3 != 0).then(|| (next() % 3_000) as f64);
                peer(id, first_byte, rate)
            })
            .collect();
        let with_origin = (next() % 2 == 0).then(|| origin((next() % 500) as f64, 1.0 + (next() % 5_000) as f64));
        let available = (next() % 6_000) as f64 * MS;
        let planned = plan(&input(size, &needed, &peers, with_origin, available));
        if planned.assignments.is_empty() {
            assert!(needed.is_empty() || (peers.is_empty() && with_origin.is_none()));
            continue;
        }
        assert_eq!(covered(&planned), needed, "size {size} peers {peers:?} origin {with_origin:?}");
        assert!(planned.assignments.iter().filter(|a| matches!(a.source, Source::Peer(_))).count() <= 3);
        for assignment in &planned.assignments {
            assert!(!assignment.ranges.is_empty());
            for range in &assignment.ranges {
                assert!(range_bytes(size, *range).is_some());
            }
        }
    }
}

// --- Transfer ---------------------------------------------------------------

const NOW: u64 = 1_000_000;
const SIZE: usize = 5 * 65_536 + 1_000;

fn object() -> Vec<u8> {
    (0..SIZE).map(|i| ((i * 131 + 17) % 251) as u8).collect()
}

fn hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn transfer(bytes: &[u8], deadline: u64) -> Transfer {
    let hashes: Vec<String> = bytes.chunks(65_536).map(hex).collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    Transfer::new(TransferConfig::default(), bytes.len() as u64, &hex(bytes), &refs, deadline).unwrap()
}

fn slice(bytes: &[u8], range: PieceRange) -> &[u8] {
    let (from, to) = range_bytes(bytes.len() as u64, range).unwrap();
    &bytes[from as usize..to as usize]
}

fn requests(commands: &[Command]) -> Vec<(Source, PieceRange)> {
    commands
        .iter()
        .filter_map(|command| match command {
            Command::Request { peer, range } => Some((Source::Peer(*peer), *range)),
            Command::FetchOrigin { range } => Some((Source::Origin, *range)),
            _ => None,
        })
        .collect()
}

fn delivered(commands: &[Command]) -> Option<&Vec<u8>> {
    commands.iter().find_map(|command| match command {
        Command::Deliver(bytes) => Some(bytes),
        _ => None,
    })
}

/// Answer every request honestly, except from `bad` (one flipped byte) and
/// from `silent` (never answers), until nothing more is asked.
fn run(transfer: &mut Transfer, bytes: &[u8], bad: Option<u64>, silent: Option<u64>) -> Vec<Command> {
    let mut log = Vec::new();
    let mut commands = transfer.drain_commands();
    for _ in 0..64 {
        let asked = requests(&commands);
        log.extend(commands);
        if asked.is_empty() {
            break;
        }
        for (source, range) in asked {
            if silent.is_some_and(|id| source == Source::Peer(id)) {
                continue;
            }
            let mut answer = slice(bytes, range).to_vec();
            if bad.is_some_and(|id| source == Source::Peer(id)) {
                answer[0] ^= 0xff;
            }
            transfer.delivered(NOW + 10, source, range, &answer);
        }
        commands = transfer.drain_commands();
    }
    log
}

#[test]
fn two_peers_deliver_a_verified_object() {
    let bytes = object();
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(
        NOW,
        &[peer(1, Some(50.0), Some(200.0)), peer(2, Some(50.0), Some(200.0))],
        origin(100.0, 500.0),
        None,
        None,
    );
    let log = run(&mut transfer, &bytes, None, None);
    let asked = requests(&log);
    assert!(asked.iter().any(|(s, _)| *s == Source::Peer(1)) && asked.iter().any(|(s, _)| *s == Source::Peer(2)));
    assert!(!asked.iter().any(|(s, _)| *s == Source::Origin), "origin is not needed on time");
    assert_eq!(delivered(&log), Some(&bytes));
    assert!(transfer.finished());
}

#[test]
fn a_bad_piece_bans_its_holder_and_the_rest_is_reassigned() {
    let bytes = object();
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(
        NOW,
        &[peer(1, Some(50.0), Some(200.0)), peer(2, Some(50.0), Some(200.0))],
        origin(100.0, 500.0),
        None,
        None,
    );
    let log = run(&mut transfer, &bytes, Some(2), None);
    assert!(log.contains(&Command::Ban { peer: 2 }));
    assert!(!log.contains(&Command::Ban { peer: 1 }));
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn a_failed_peer_hands_its_pieces_to_the_others() {
    let bytes = object();
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(
        NOW,
        &[peer(1, Some(50.0), Some(200.0)), peer(2, Some(50.0), Some(200.0))],
        origin(100.0, 500.0),
        None,
        None,
    );
    let first = transfer.drain_commands();
    let (_, range) = requests(&first).into_iter().find(|(s, _)| *s == Source::Peer(2)).unwrap();
    transfer.failed(NOW + 5, Source::Peer(2));
    let mut log = first.clone();
    // Peer 1's own first range, then everything reassigned.
    let (_, own) = requests(&first).into_iter().find(|(s, _)| *s == Source::Peer(1)).unwrap();
    transfer.delivered(NOW + 10, Source::Peer(1), own, slice(&bytes, own));
    log.extend(run(&mut transfer, &bytes, None, None));
    let later: Vec<_> = requests(&log[first.len()..]);
    assert!(later
        .iter()
        .any(|(s, r)| *s == Source::Peer(1) && r.start <= range.start && range.start < r.end));
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn a_wrong_length_answer_fails_the_peer_and_its_pieces_move() {
    let bytes = object();
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(
        NOW,
        &[peer(1, Some(50.0), Some(200.0)), peer(2, Some(50.0), Some(200.0))],
        origin(100.0, 500.0),
        None,
        None,
    );
    let first = transfer.drain_commands();
    let (_, range) = requests(&first).into_iter().find(|(s, _)| *s == Source::Peer(2)).unwrap();
    transfer.delivered(NOW + 5, Source::Peer(2), range, &slice(&bytes, range)[1..]);
    let mut log = first.clone();
    let (_, own) = requests(&first).into_iter().find(|(s, _)| *s == Source::Peer(1)).unwrap();
    transfer.delivered(NOW + 10, Source::Peer(1), own, slice(&bytes, own));
    log.extend(run(&mut transfer, &bytes, None, None));
    assert!(!requests(&log[first.len()..]).iter().any(|(s, _)| *s == Source::Peer(2)));
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn the_origin_floor_takes_over_outstanding_pieces() {
    let bytes = object();
    let deadline = NOW + 4_000;
    let mut transfer = transfer(&bytes, deadline);
    transfer.start(
        NOW,
        &[peer(1, Some(50.0), Some(200.0)), peer(2, Some(50.0), Some(200.0))],
        origin(100.0, 500.0),
        None,
        None,
    );
    let mut log = run(&mut transfer, &bytes, None, Some(2));
    assert!(delivered(&log).is_none());
    let floor = deadline - 2_000;
    assert_eq!(transfer.next_deadline(), Some(floor));
    transfer.tick(floor);
    let commands = transfer.drain_commands();
    assert!(commands.contains(&Command::Cancel { peer: 2 }));
    let origin_ranges: Vec<PieceRange> = requests(&commands)
        .into_iter()
        .filter(|(s, _)| *s == Source::Origin)
        .map(|(_, r)| r)
        .collect();
    assert!(!origin_ranges.is_empty());
    for range in origin_ranges {
        transfer.delivered(floor + 100, Source::Origin, range, slice(&bytes, range));
    }
    log.extend(transfer.drain_commands());
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn the_endgame_duplicates_a_lagging_last_piece_and_the_first_copy_wins() {
    let bytes = object();
    // Peers 1 and 3 hold four and two pieces; peer 3 goes quiet with the
    // tail. Peer 2 is never chosen. Peer 1, once done, is the fastest idle.
    let peers = [
        peer(1, Some(10.0), Some(300.0)),
        peer(2, Some(10.0), Some(100.0)),
        peer(3, Some(10.0), Some(120.0)),
    ];
    let config = TransferConfig {
        max_holders: 2,
        ..TransferConfig::default()
    };
    let hashes: Vec<String> = bytes.chunks(65_536).map(hex).collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    let mut transfer = Transfer::new(config, bytes.len() as u64, &hex(&bytes), &refs, NOW + 60_000).unwrap();
    transfer.start(NOW, &peers, origin(100.0, 50.0), None, None);
    let log = run(&mut transfer, &bytes, None, Some(3));
    assert!(delivered(&log).is_none());
    assert!(!requests(&log).iter().any(|(s, _)| *s == Source::Peer(2)));
    let lag = transfer.next_deadline().expect("a lagging tail is watched");
    assert!(lag < NOW + 58_000);
    transfer.tick(lag);
    let commands = transfer.drain_commands();
    let duplicate = requests(&commands);
    assert_eq!(duplicate.len(), 1, "{commands:?}");
    let (source, range) = duplicate[0];
    assert_eq!(source, Source::Peer(1), "the fastest idle peer");
    transfer.delivered(lag + 5, source, range, slice(&bytes, range));
    let done = transfer.drain_commands();
    assert_eq!(done.iter().filter(|c| **c == Command::Cancel { peer: 3 }).count(), 1);
    assert_eq!(delivered(&done), Some(&bytes));
    // Nothing left to wake for.
    assert_eq!(transfer.next_deadline(), None);
}

#[test]
fn bad_origin_bytes_fail_the_transfer() {
    let bytes = object();
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(NOW, &[], origin(100.0, 500.0), None, None);
    let commands = transfer.drain_commands();
    let (_, range) = requests(&commands)[0];
    let mut answer = slice(&bytes, range).to_vec();
    answer[1] ^= 1;
    transfer.delivered(NOW + 50, Source::Origin, range, &answer);
    assert_eq!(transfer.drain_commands(), vec![Command::Fail]);
}

#[test]
fn ticking_at_each_deadline_never_repeats_it() {
    let bytes = object();
    let mut transfer = transfer(&bytes, NOW + 5_000);
    transfer.start(
        NOW,
        &[peer(1, Some(50.0), Some(5.0)), peer(2, Some(50.0), Some(5.0))],
        origin(100.0, 500.0),
        None,
        None,
    );
    transfer.drain_commands();
    let mut last = 0;
    for _ in 0..16 {
        let Some(at) = transfer.next_deadline() else { break };
        assert!(at > last, "deadline {at} after {last}");
        last = at;
        transfer.tick(at);
        transfer.drain_commands();
    }
}
