//! Multi-holder planning and transfer (CORE-SPEC section 6). Rust-only, as
//! the JavaScript loader has no counterpart.

use relayswarm_proto::commitment::commitment_piece_size;
use relayswarm_proto::pieces::{piece_count, range_bytes, PieceRange};
use relayswarm_proto::scheduler::{
    plan, Command, Estimate, Plan, PlanInput, Source, Transfer, TransferConfig, MAX_PEER_REQUEST_BYTES, MAX_PEER_REQUEST_PIECES, MIN_RATE,
};
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
    let hashes: Vec<String> = (0..piece_count(size).unwrap()).map(|i| hex(&[i as u8])).collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    let mut late = Transfer::new(TransferConfig::default(), size, &hex(b"x"), &refs, NOW + 2_000 + 1_860).unwrap();
    late.start(NOW, &peers, origin(150.0, 1.0), None, None);
    assert!(late.late(), "a slow origin cannot rescue it either");
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
    object_sized(SIZE)
}

fn object_sized(size: usize) -> Vec<u8> {
    (0..size).map(|i| ((i * 131 + 17) % 251) as u8).collect()
}

fn hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn transfer(bytes: &[u8], deadline: u64) -> Transfer {
    let hashes: Vec<String> = bytes.chunks(commitment_piece_size(bytes.len() as i64) as usize).map(hex).collect();
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

#[test]
fn a_refresh_is_one_piece_even_when_another_route_has_a_fast_shared_rate() {
    let bytes = object_sized(6 * 1024 * 1024);
    let mut probe = transfer(&bytes, NOW + 2_800);
    probe.start_with_probe_peers(
        NOW,
        &[peer(1, Some(100.0), None)],
        origin(0.0, 20_000.0),
        Some(100.0),
        Some(20_000.0),
        &[1],
    );
    let asked = requests(&probe.drain_commands());
    assert_eq!(
        asked,
        vec![
            (Source::Peer(1), PieceRange { start: 0, end: 1 }),
            (Source::Origin, PieceRange { start: 1, end: 64 }),
        ]
    );
    // The same ordinary start still uses the existing planner, without a
    // one-piece limit silently becoming a new default.
    let mut ordinary = transfer(&bytes, NOW + 2_800);
    ordinary.start(
        NOW,
        &[peer(1, Some(100.0), None)],
        origin(0.0, 20_000.0),
        Some(100.0),
        Some(20_000.0),
    );
    assert_eq!(
        requests(&ordinary.drain_commands()),
        vec![(Source::Peer(1), PieceRange { start: 0, end: 4 })]
    );
}

#[test]
fn only_a_fresh_verified_probe_unlocks_ordinary_peer_work() {
    let bytes = object_sized(6 * 1024 * 1024);
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start_with_probe_peers(
        NOW,
        &[peer(1, Some(100.0), None), peer(2, Some(100.0), None)],
        origin(0.0, 20_000.0),
        None,
        Some(20_000.0),
        &[1, 2],
    );
    transfer.drain_commands();
    // Neither progress, an unsolicited range nor reassigning failed origin
    // work replenishes the one-piece allowance.
    transfer.progress(NOW + 100, Source::Peer(1), 1);
    let unsolicited = PieceRange { start: 1, end: 2 };
    transfer.delivered(NOW + 110, Source::Peer(1), unsolicited, slice(&bytes, unsolicited));
    transfer.failed(NOW + 115, Source::Peer(2));
    assert!(requests(&transfer.drain_commands())
        .iter()
        .all(|(source, _)| *source == Source::Origin));
    let first = PieceRange { start: 0, end: 1 };
    transfer.delivered(NOW + 120, Source::Peer(1), first, slice(&bytes, first));
    let next = requests(&transfer.drain_commands());
    assert!(next
        .iter()
        .any(|(source, range)| *source == Source::Peer(1) && range.start >= 1 && range.end - range.start <= MAX_PEER_REQUEST_PIECES));
}

#[test]
fn a_bad_or_late_probe_cannot_unlock_more_peer_work() {
    let bytes = object_sized(6 * 1024 * 1024);
    for corrupt in [false, true] {
        let mut transfer = transfer(&bytes, NOW + 10_000);
        transfer.start_with_probe_peers(
            NOW,
            &[peer(1, Some(100.0), None)],
            origin(0.0, 20_000.0),
            None,
            Some(20_000.0),
            &[1],
        );
        transfer.drain_commands();
        let range = PieceRange { start: 0, end: 1 };
        let mut answer = slice(&bytes, range).to_vec();
        if corrupt {
            answer[0] ^= 1;
        } else {
            transfer.failed(NOW + 100, Source::Peer(1));
        }
        transfer.delivered(NOW + 120, Source::Peer(1), range, &answer);
        let commands = transfer.drain_commands();
        assert!(!requests(&commands).iter().any(|(source, _)| *source == Source::Peer(1)));
        if corrupt {
            assert!(commands.iter().any(|command| matches!(command, Command::Ban { peer: 1 })));
        }
    }
}

/// Answer every request honestly, except from `bad` (one flipped byte) and
/// from `silent` (never answers), until nothing more is asked.
fn run(transfer: &mut Transfer, bytes: &[u8], bad: Option<u64>, silent: Option<u64>) -> Vec<Command> {
    run_at(transfer, bytes, bad, silent, NOW + 10)
}

fn run_at(transfer: &mut Transfer, bytes: &[u8], bad: Option<u64>, silent: Option<u64>, at: u64) -> Vec<Command> {
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
            transfer.delivered(at, source, range, &answer);
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
        &[peer(1, Some(50.0), Some(200.0)), peer(2, None, Some(200.0))],
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
    // Peers 1 and 3 hold four and two pieces; peer 3's startup is unknown
    // and it goes quiet with the tail. Peer 2 is never chosen. Peer 1,
    // once done, is the fastest idle.
    let peers = [
        peer(1, Some(10.0), Some(300.0)),
        peer(2, Some(10.0), Some(100.0)),
        peer(3, None, Some(120.0)),
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

#[test]
fn a_fast_origin_takes_only_the_tail_peers_cannot_finish() {
    // A local origin far faster than the peers must not take the head too.
    let size = 6 * 65_536;
    let peers = [peer(1, Some(0.0), Some(100.0)), peer(2, Some(0.0), Some(100.0))];
    let planned = plan(&input(size, &all(size), &peers, Some(origin(5.0, 100_000.0)), 1_400.0));
    // Each peer finishes two pieces (131,072 bytes at 100 bytes/ms) in 1,400 ms.
    assert_eq!(pieces_of(&planned, Source::Peer(1)), vec![0, 1]);
    assert_eq!(pieces_of(&planned, Source::Peer(2)), vec![2, 3]);
    assert_eq!(pieces_of(&planned, Source::Origin), vec![4, 5]);
    assert!(!planned.late);
}

#[test]
fn an_untested_peer_gets_one_trial_piece_even_when_projected_late() {
    let size = 4 * 65_536;
    let peers = [peer(1, None, None)];
    let planned = plan(&input(size, &all(size), &peers, Some(origin(5.0, 100_000.0)), 500.0));
    assert_eq!(pieces_of(&planned, Source::Peer(1)), vec![0]);
    assert_eq!(pieces_of(&planned, Source::Origin), vec![1, 2, 3]);
}

// --- Early abandonment --------------------------------------------------------

fn two_peers(bytes: &[u8], deadline: u64, shared_first_byte_ms: Option<f64>) -> (Transfer, Vec<Command>) {
    let mut transfer = transfer(bytes, deadline);
    transfer.start(
        NOW,
        &[peer(1, None, Some(200.0)), peer(2, None, Some(200.0))],
        origin(100.0, 500.0),
        shared_first_byte_ms,
        None,
    );
    let first = transfer.drain_commands();
    (transfer, first)
}

fn range_of(commands: &[Command], source: Source) -> PieceRange {
    requests(commands).into_iter().find(|(s, _)| *s == source).unwrap().1
}

/// Answer the requests in `commands` (but not from `silent`), then keep
/// answering whatever follows.
fn answer(transfer: &mut Transfer, bytes: &[u8], commands: &[Command], silent: u64, at: u64) -> Vec<Command> {
    for (source, range) in requests(commands) {
        if source != Source::Peer(silent) {
            transfer.delivered(at, source, range, slice(bytes, range));
        }
    }
    run_at(transfer, bytes, None, Some(silent), at)
}

#[test]
fn a_silent_peer_is_abandoned_at_its_silence_limit_before_the_floor() {
    let bytes = object();
    let (mut transfer, first) = two_peers(&bytes, NOW + 10_000, Some(50.0));
    let mut log = first.clone();
    log.extend(answer(&mut transfer, &bytes, &first, 2, NOW + 10));
    assert!(delivered(&log).is_none());
    // max(250 ms, three first-byte times) after the request, far before the floor.
    assert_eq!(transfer.next_deadline(), Some(NOW + 250));
    transfer.tick(NOW + 249);
    assert!(!transfer.drain_commands().contains(&Command::Abandon { peer: 2 }));
    transfer.tick(NOW + 250);
    let abandoned = transfer.drain_commands();
    assert!(abandoned.contains(&Command::Abandon { peer: 2 }), "{abandoned:?}");
    let log = [abandoned.clone(), answer(&mut transfer, &bytes, &abandoned, 2, NOW + 300)].concat();
    assert!(
        !requests(&log).iter().any(|(s, _)| *s == Source::Peer(2)),
        "an abandoned peer gets no more work"
    );
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn without_a_shared_first_byte_time_silence_waits_for_the_floor() {
    let bytes = object();
    let (transfer, _) = two_peers(&bytes, NOW + 10_000, None);
    assert_eq!(transfer.next_deadline(), Some(NOW + 8_000));
}

#[test]
fn a_measured_slow_lane_does_not_borrow_another_lanes_fast_startup() {
    let bytes = object();
    for shared in [Some(20.0), None] {
        let mut transfer = transfer(&bytes, NOW + 10_000);
        transfer.start(NOW, &[peer(1, Some(1_400.0), Some(200.0))], origin(100.0, 500.0), shared, None);
        transfer.drain_commands();
        assert_eq!(transfer.next_deadline(), Some(NOW + 4_200));
        transfer.tick(NOW + 250);
        assert!(!transfer.drain_commands().contains(&Command::Abandon { peer: 1 }));
        transfer.tick(NOW + 4_199);
        assert!(!transfer.drain_commands().contains(&Command::Abandon { peer: 1 }));
        transfer.tick(NOW + 4_200);
        assert!(transfer.drain_commands().contains(&Command::Abandon { peer: 1 }));
    }
}

#[test]
fn a_measured_fast_lane_does_not_borrow_another_lanes_slow_startup() {
    let bytes = object();
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(NOW, &[peer(1, Some(20.0), Some(200.0))], origin(100.0, 500.0), Some(1_400.0), None);
    transfer.drain_commands();
    assert_eq!(transfer.next_deadline(), Some(NOW + 250));
    transfer.tick(NOW + 249);
    assert!(!transfer.drain_commands().contains(&Command::Abandon { peer: 1 }));
    transfer.tick(NOW + 250);
    assert!(transfer.drain_commands().contains(&Command::Abandon { peer: 1 }));
}

#[test]
fn a_flow_too_slow_for_the_floor_is_abandoned_and_its_pieces_move() {
    let bytes = object();
    let (mut transfer, first) = two_peers(&bytes, NOW + 4_000, Some(50.0));
    let slow = range_of(&first, Source::Peer(2));
    let mut log = first.clone();
    for (at, received) in [(50, 1_000), (300, 2_000), (500, 3_000)] {
        transfer.progress(NOW + at, Source::Peer(2), received);
        log.extend(transfer.drain_commands());
    }
    let after = log.iter().position(|c| *c == Command::Abandon { peer: 2 }).expect("abandoned");
    // Peer 1's own range, then whatever the moved pieces were queued on.
    let pending: Vec<Command> = log
        .iter()
        .filter(|c| !matches!(c, Command::Request { peer: 2, .. }))
        .cloned()
        .collect();
    log.extend(answer(&mut transfer, &bytes, &pending, 2, NOW + 600));
    let moved: Vec<u32> = requests(&log[after..]).iter().flat_map(|(_, r)| r.start..r.end).collect();
    assert!(
        (slow.start..slow.end).all(|i| moved.contains(&i)),
        "the slow range is reassigned: {log:?}"
    );
    assert!(!requests(&log[after..]).iter().any(|(s, _)| *s == Source::Peer(2)));
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn a_flow_on_pace_is_never_abandoned() {
    let bytes = object();
    let (mut transfer, first) = two_peers(&bytes, NOW + 10_000, Some(50.0));
    let range = range_of(&first, Source::Peer(2));
    let size = slice(&bytes, range).len() as u64;
    let mut at = 50;
    while 200 * (at - 50) < size {
        transfer.progress(NOW + at, Source::Peer(2), 200 * (at - 50));
        let commands = transfer.drain_commands();
        assert!(!commands.contains(&Command::Abandon { peer: 2 }), "at {at}: {commands:?}");
        at += 50;
    }
    transfer.tick(NOW + at);
    assert!(!transfer.drain_commands().contains(&Command::Abandon { peer: 2 }));
}

#[test]
fn a_flow_that_stalls_is_abandoned_by_a_tick_before_the_floor() {
    let bytes = object();
    let (mut transfer, _) = two_peers(&bytes, NOW + 10_000, Some(50.0));
    transfer.progress(NOW + 50, Source::Peer(2), 10_000);
    transfer.progress(NOW + 100, Source::Peer(2), 20_000);
    assert!(transfer.drain_commands().is_empty());
    let mut last = 0;
    let abandoned_at = loop {
        let at = transfer.next_deadline().expect("the stalled request is watched");
        assert!(at > last && at < NOW + 8_000, "tick {at} after {last}");
        last = at;
        transfer.tick(at);
        if transfer.drain_commands().contains(&Command::Abandon { peer: 2 }) {
            break at;
        }
    };
    assert!(abandoned_at <= NOW + 1_000, "abandoned at {abandoned_at}");
}

#[test]
fn untested_first_bytes_use_the_shared_time_so_a_late_plan_gives_origin_the_tail() {
    // Each peer needs about 820 ms for half the object; the floor is 2 s away.
    let bytes = object();
    let start = |shared: Option<f64>| {
        let mut transfer = transfer(&bytes, NOW + 4_000);
        transfer.start(
            NOW,
            &[peer(1, None, Some(200.0)), peer(2, None, Some(200.0))],
            origin(100.0, 500.0),
            shared,
            None,
        );
        requests(&transfer.drain_commands())
    };
    assert!(!start(Some(10.0)).iter().any(|(s, _)| *s == Source::Origin));
    // A 1.5 s shared first byte makes both peers late, so origin takes a tail.
    assert!(start(Some(1_500.0)).iter().any(|(s, _)| *s == Source::Origin));
}

// --- Known limit ---------------------------------------------------------------

/// Known limit (CORE-SPEC section 7, 23 October 2026): with untested holders
/// the plan is late, so each holder gets one trial piece and origin is sent
/// everything else in one request. When the trials come back fast, the idle
/// holders get nothing more: origin's unreceived pieces are not moved back.
/// Found running the core's link and transfer over RelaySwarmKit's data
/// channels. A fix that rebalances should flip the last two assertions.
/// Two untested holders and a slow origin, with room before the floor. The
/// late plan gives each holder one trial piece and origin the rest.
fn trials_then_origin(bytes: &[u8]) -> (Transfer, Vec<Command>) {
    let mut transfer = transfer(bytes, NOW + 5_000);
    // Origin at 300 bytes/ms needs about 1.4 s for the six pieces it is given.
    transfer.start(NOW, &[peer(1, None, None), peer(2, None, None)], origin(50.0, 300.0), None, None);
    let first = transfer.drain_commands();
    assert_eq!(requests(&first).len(), 3, "{first:?}");
    let origin_range = range_of(&first, Source::Origin);
    assert_eq!(
        (origin_range.start, origin_range.end),
        (2, 8),
        "origin is sent the rest in one request"
    );
    (transfer, first)
}

#[test]
fn fast_trials_take_origin_work_back_and_the_object_arrives_without_origin() {
    let bytes: Vec<u8> = (0..8 * 65_536).map(|i| ((i * 131 + 17) % 251) as u8).collect();
    let (mut transfer, first) = trials_then_origin(&bytes);
    // Both trials verify within 10 ms. The first idle holder leaves the
    // other busy holder its share, taking origin's tail.
    let mut taken = Vec::new();
    for peer in [1, 2] {
        let range = range_of(&first, Source::Peer(peer));
        assert_eq!(range.end - range.start, 1, "one trial piece");
        transfer.delivered(NOW + 10, Source::Peer(peer), range, slice(&bytes, range));
        let next = transfer.drain_commands();
        let range = range_of(&next, Source::Peer(peer));
        taken.push((peer, range));
    }
    assert_eq!(
        taken
            .iter()
            .map(|(peer, range)| (*peer, range.start, range.end))
            .collect::<Vec<_>>(),
        vec![(1, 5, 8), (2, 2, 5)]
    );
    for (peer, range) in taken {
        transfer.delivered(NOW + 30, Source::Peer(peer), range, slice(&bytes, range));
    }
    assert!(transfer.finished(), "the holders covered everything origin owed");
    let done = transfer.drain_commands();
    assert!(
        done.iter()
            .any(|command| matches!(command, Command::Deliver(data) if *data == bytes)),
        "{done:?}"
    );
}

#[test]
fn slow_trials_leave_origin_its_work() {
    let bytes: Vec<u8> = (0..8 * 65_536).map(|i| ((i * 131 + 17) % 251) as u8).collect();
    let (mut transfer, first) = trials_then_origin(&bytes);
    // A second per piece: neither holder could finish one before origin is
    // projected to finish the lot.
    for peer in [1, 2] {
        let range = range_of(&first, Source::Peer(peer));
        transfer.delivered(NOW + 1_000, Source::Peer(peer), range, slice(&bytes, range));
    }
    transfer.tick(NOW + 1_010);
    let after = transfer.drain_commands();
    assert!(requests(&after).is_empty(), "{after:?}");
    let origin_range = range_of(&first, Source::Origin);
    transfer.delivered(NOW + 1_400, Source::Origin, origin_range, slice(&bytes, origin_range));
    assert!(transfer.finished());
}

// --- Bounded peer requests --------------------------------------------------

#[test]
fn peer_batches_preserve_disjoint_queued_work_and_one_in_flight_request() {
    let bytes = object_sized(9 * 65_536 + 17);
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(NOW, &[peer(1, Some(1.0), Some(1_000.0))], origin(10_000.0, 0.01), None, None);
    let first = transfer.drain_commands();
    let asked = requests(&first);
    assert_eq!(asked, vec![(Source::Peer(1), PieceRange { start: 0, end: 4 })]);
    transfer.tick(NOW + 1);
    assert!(
        requests(&transfer.drain_commands()).is_empty(),
        "queued work must wait for the current batch"
    );

    let mut commands = first;
    let mut covered = Vec::new();
    let mut at = NOW + 10;
    let mut ranges = Vec::new();
    loop {
        let asked = requests(&commands);
        assert_eq!(asked.len(), 1, "{commands:?}");
        let (source, range) = asked[0];
        assert_eq!(source, Source::Peer(1));
        assert!(range.end - range.start <= MAX_PEER_REQUEST_PIECES);
        assert!(slice(&bytes, range).len() as u64 <= MAX_PEER_REQUEST_BYTES);
        covered.extend(range.start..range.end);
        ranges.push(range);
        transfer.delivered(at, source, range, slice(&bytes, range));
        commands = transfer.drain_commands();
        if transfer.finished() {
            assert_eq!(delivered(&commands), Some(&bytes));
            break;
        }
        at += 10;
    }
    assert_eq!(
        covered,
        all(bytes.len() as u64),
        "pieces must not overlap or vanish between batches"
    );
    assert_eq!(
        ranges,
        vec![
            PieceRange { start: 0, end: 4 },
            PieceRange { start: 4, end: 8 },
            PieceRange { start: 8, end: 10 }
        ]
    );
    assert_eq!(slice(&bytes, ranges[2]).len(), 65_536 + 17, "the final piece can be shorter");
}

#[test]
fn peer_batches_respect_the_byte_cap_with_maximum_canonical_pieces() {
    let bytes = object_sized(16 * 1024 * 1024);
    assert_eq!(commitment_piece_size(bytes.len() as i64), 256 * 1024);
    let mut transfer = transfer(&bytes, NOW + 100_000);
    transfer.start(NOW, &[peer(1, Some(1.0), Some(1_000.0))], origin(10_000.0, 0.01), None, None);
    let asked = requests(&transfer.drain_commands());
    assert_eq!(asked, vec![(Source::Peer(1), PieceRange { start: 0, end: 2 })]);
    assert_eq!(slice(&bytes, asked[0].1).len() as u64, MAX_PEER_REQUEST_BYTES);
}

#[test]
fn peer_batches_accept_single_and_short_final_pieces_without_empty_requests() {
    for size in [1, 65_536, 65_537, 3 * 65_536 + 17] {
        let bytes = object_sized(size);
        let mut transfer = transfer(&bytes, NOW + 10_000);
        transfer.start(NOW, &[peer(1, Some(1.0), Some(1_000.0))], origin(10_000.0, 0.01), None, None);
        let asked = requests(&transfer.drain_commands());
        assert_eq!(
            asked,
            vec![(
                Source::Peer(1),
                PieceRange {
                    start: 0,
                    end: piece_count(size as u64).unwrap()
                }
            )]
        );
        transfer.delivered(NOW + 10, Source::Peer(1), asked[0].1, &bytes);
        let done = transfer.drain_commands();
        assert_eq!(delivered(&done), Some(&bytes));
        assert!(requests(&done).is_empty());
    }
}

#[test]
fn a_failed_batch_preserves_verified_pieces_and_reassigns_the_unfinished_queue() {
    let bytes = object_sized(13 * 65_536 + 17);
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(NOW, &[peer(1, Some(1.0), Some(1_000.0))], origin(10_000.0, 0.01), None, None);
    let first = requests(&transfer.drain_commands())[0].1;
    transfer.delivered(NOW + 10, Source::Peer(1), first, slice(&bytes, first));
    let second = requests(&transfer.drain_commands())[0].1;
    assert_eq!(second, PieceRange { start: 4, end: 8 });
    transfer.failed(NOW + 20, Source::Peer(1));
    let asked = requests(&transfer.drain_commands());
    assert_eq!(asked, vec![(Source::Origin, PieceRange { start: 4, end: 14 })]);
    assert!(
        slice(&bytes, asked[0].1).len() as u64 > MAX_PEER_REQUEST_BYTES,
        "origin ranges remain uncapped"
    );
    transfer.delivered(NOW + 30, Source::Origin, asked[0].1, slice(&bytes, asked[0].1));
    assert_eq!(delivered(&transfer.drain_commands()), Some(&bytes));
}

#[test]
fn the_origin_floor_reassigns_in_flight_and_queued_batches_but_keeps_verified_progress() {
    let bytes = object_sized(13 * 65_536 + 17);
    let deadline = NOW + 4_000;
    let mut transfer = transfer(&bytes, deadline);
    transfer.start(NOW, &[peer(1, Some(1.0), Some(1_000.0))], origin(10_000.0, 0.01), None, None);
    let first = requests(&transfer.drain_commands())[0].1;
    transfer.delivered(NOW + 10, Source::Peer(1), first, slice(&bytes, first));
    let second = requests(&transfer.drain_commands())[0].1;
    transfer.tick(deadline - 2_000);
    let commands = transfer.drain_commands();
    assert!(commands.contains(&Command::Cancel { peer: 1 }));
    let asked = requests(&commands);
    assert_eq!(asked, vec![(Source::Origin, PieceRange { start: 4, end: 14 })]);
    transfer.delivered(deadline - 1_999, Source::Peer(1), second, slice(&bytes, second));
    assert!(transfer.drain_commands().is_empty(), "a late cancelled batch cannot claim progress");
    transfer.delivered(deadline - 1_900, Source::Origin, asked[0].1, slice(&bytes, asked[0].1));
    assert_eq!(delivered(&transfer.drain_commands()), Some(&bytes));
}

#[test]
fn whole_origin_ranges_are_not_split_into_peer_sized_batches() {
    let bytes = object_sized(13 * 65_536 + 17);
    let mut transfer = transfer(&bytes, NOW + 10_000);
    transfer.start(NOW, &[], origin(1.0, 1_000.0), None, None);
    let asked = requests(&transfer.drain_commands());
    assert_eq!(asked, vec![(Source::Origin, PieceRange { start: 0, end: 14 })]);
    assert!(slice(&bytes, asked[0].1).len() as u64 > MAX_PEER_REQUEST_BYTES);
    transfer.delivered(NOW + 10, Source::Origin, asked[0].1, &bytes);
    assert_eq!(delivered(&transfer.drain_commands()), Some(&bytes));
}

// --- Independent peer-only arm ---------------------------------------------

fn peer_only_transfer(bytes: &[u8], deadline: u64, max_holders: usize) -> Transfer {
    let hashes: Vec<String> = bytes.chunks(commitment_piece_size(bytes.len() as i64) as usize).map(hex).collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    Transfer::new_peer_only(
        TransferConfig {
            max_holders,
            origin_reserve_ms: 0.0,
        },
        bytes.len() as u64,
        &hex(bytes),
        &refs,
        deadline,
    )
    .unwrap()
}

fn peer_only_bounds(commands: &[Command], bytes: &[u8]) {
    for command in commands {
        assert!(
            !matches!(command, Command::FetchOrigin { .. } | Command::Abandon { .. }),
            "{commands:?}"
        );
        if let Command::Request { range, .. } = command {
            assert!(range.start < range.end);
            assert!(range.end - range.start <= MAX_PEER_REQUEST_PIECES);
            assert!(slice(bytes, *range).len() as u64 <= MAX_PEER_REQUEST_BYTES);
        }
    }
}

fn run_peer_only(transfer: &mut Transfer, bytes: &[u8], mut commands: Vec<Command>, mut at: u64) -> Vec<Command> {
    let mut log = Vec::new();
    for _ in 0..128 {
        peer_only_bounds(&commands, bytes);
        let asked = requests(&commands);
        log.extend(commands);
        if transfer.finished() || asked.is_empty() {
            break;
        }
        for (source, range) in asked {
            at += 10;
            transfer.delivered(at, source, range, slice(bytes, range));
        }
        commands = transfer.drain_commands();
    }
    assert!(transfer.finished(), "pending pieces must continue without an origin event");
    assert_eq!(delivered(&log).map(Vec::as_slice), Some(bytes));
    log
}

#[test]
fn peer_only_six_mib_unknown_probe_refills_every_piece_without_origin() {
    let bytes = object_sized(6 * 1024 * 1024);
    let mut transfer = peer_only_transfer(&bytes, NOW + 5_000, 3);
    assert!(transfer.peer_only());
    // Unknown means one probe even if the caller omits probe_peers and has
    // a very optimistic shared rate. No HTTP model is an input to this API.
    transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None)], Some(1.0), Some(1_000_000.0), &[]);
    let initial = transfer.drain_commands();
    assert_eq!(requests(&initial), vec![(Source::Peer(1), PieceRange { start: 0, end: 1 })]);
    let log = run_peer_only(&mut transfer, &bytes, initial, NOW);
    let covered: Vec<u32> = requests(&log).iter().flat_map(|(_, range)| range.start..range.end).collect();
    assert_eq!(covered, all(bytes.len() as u64), "no overlapping or lost pending pieces");
    assert_eq!(transfer.verified_bytes(), bytes.len() as u64);
    assert_eq!(transfer.next_deadline(), None);
}

#[test]
fn peer_only_a_slow_verified_probe_still_unlocks_work_before_the_floor() {
    let bytes = object_sized(1024 * 1024);
    let mut transfer = peer_only_transfer(&bytes, NOW + 1_000, 1);
    transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, Some(1.0), None)], Some(1.0), None, &[1]);
    let initial = transfer.drain_commands();
    let (_, probe) = requests(&initial)[0];
    transfer.progress(NOW + 1, Source::Peer(1), 1);
    transfer.tick(NOW + 600);
    assert!(
        transfer.drain_commands().is_empty(),
        "parallel HTTP owns recovery; no serial flow abandonment"
    );
    transfer.delivered(NOW + 700, Source::Peer(1), probe, slice(&bytes, probe));
    let next = transfer.drain_commands();
    assert!(!requests(&next).is_empty(), "an adverse forecast must not strand pending work");
    let log = run_peer_only(&mut transfer, &bytes, next, NOW + 700);
    peer_only_bounds(&initial, &bytes);
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn peer_only_ignores_an_accidental_origin_estimate_and_origin_callbacks() {
    let bytes = object();
    let mut transfer = peer_only_transfer(&bytes, NOW + 5_000, 1);
    transfer.start(
        NOW,
        &[peer(1, None, None), origin(0.0, 1_000_000.0)],
        origin(0.0, 1_000_000.0),
        None,
        None,
    );
    let first = transfer.drain_commands();
    assert_eq!(requests(&first), vec![(Source::Peer(1), PieceRange { start: 0, end: 1 })]);
    let range = PieceRange { start: 0, end: 1 };
    transfer.delivered(NOW + 1, Source::Origin, range, slice(&bytes, range));
    transfer.progress(NOW + 1, Source::Origin, 1);
    transfer.failed(NOW + 1, Source::Origin);
    assert_eq!(transfer.verified_bytes(), 0);
    assert!(!transfer.finished());
    assert!(transfer.drain_commands().is_empty());
    run_peer_only(&mut transfer, &bytes, first, NOW + 1);
}

#[test]
fn peer_only_silence_and_stalled_progress_wait_for_floor_then_cancel_and_fail() {
    let bytes = object();
    let deadline = NOW + 1_000;
    for flowing in [false, true] {
        let mut transfer = peer_only_transfer(&bytes, deadline, 1);
        transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, Some(1.0), None)], Some(1.0), Some(1_000_000.0), &[1]);
        let initial = transfer.drain_commands();
        let (_, range) = requests(&initial)[0];
        if flowing {
            transfer.progress(NOW + 1, Source::Peer(1), 1);
            transfer.progress(NOW + 600, Source::Peer(1), 2);
        }
        transfer.tick(deadline - 1);
        assert!(!transfer.finished());
        assert_eq!(transfer.next_deadline(), Some(deadline));
        assert!(transfer.drain_commands().is_empty());
        transfer.tick(deadline);
        let stopped = transfer.drain_commands();
        assert_eq!(stopped, vec![Command::Cancel { peer: 1 }, Command::Fail]);
        peer_only_bounds(&stopped, &bytes);
        assert_eq!(transfer.next_deadline(), None);
        transfer.delivered(deadline + 1, Source::Peer(1), range, slice(&bytes, range));
        transfer.tick(deadline + 2);
        assert_eq!(transfer.verified_bytes(), 0);
        assert!(transfer.drain_commands().is_empty(), "late data cannot revive the arm");
    }
}

#[test]
fn peer_only_delivery_at_the_floor_cannot_unlock_or_credit_a_probe() {
    let bytes = object();
    let mut transfer = peer_only_transfer(&bytes, NOW + 1_000, 1);
    transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None)], None, None, &[1]);
    let (_, range) = requests(&transfer.drain_commands())[0];
    transfer.delivered(NOW + 1_000, Source::Peer(1), range, slice(&bytes, range));
    assert_eq!(transfer.verified_bytes(), 0);
    assert_eq!(transfer.drain_commands(), vec![Command::Cancel { peer: 1 }, Command::Fail]);
}

#[test]
fn peer_only_failed_holder_reassigns_queued_and_pending_work_without_losing_verified_pieces() {
    let bytes = object_sized(13 * 65_536 + 17);
    let mut transfer = peer_only_transfer(&bytes, NOW + 10_000, 1);
    transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None), peer(2, None, None)], None, None, &[]);
    let (_, first) = requests(&transfer.drain_commands())[0];
    transfer.delivered(NOW + 10, Source::Peer(1), first, slice(&bytes, first));
    let (_, old_batch) = requests(&transfer.drain_commands())[0];
    transfer.failed(NOW + 20, Source::Peer(1));
    let retry = transfer.drain_commands();
    assert_eq!(requests(&retry), vec![(Source::Peer(2), PieceRange { start: 1, end: 2 })]);
    transfer.delivered(NOW + 30, Source::Peer(1), old_batch, slice(&bytes, old_batch));
    assert_eq!(transfer.verified_bytes(), 65_536);
    assert!(
        transfer.drain_commands().is_empty(),
        "the retired source cannot verify its late batch"
    );
    run_peer_only(&mut transfer, &bytes, retry, NOW + 30);
}

#[test]
fn peer_only_corrupt_batch_preserves_its_good_pieces_and_reassigns_the_rest() {
    let bytes = object_sized(13 * 65_536 + 17);
    let mut transfer = peer_only_transfer(&bytes, NOW + 10_000, 2);
    transfer.start_peer_only_with_probe_peers(
        NOW,
        &[peer(1, Some(1.0), Some(1_000.0)), peer(2, Some(1.0), Some(1_000.0))],
        None,
        None,
        &[],
    );
    let initial = transfer.drain_commands();
    let first = range_of(&initial, Source::Peer(1));
    let second = range_of(&initial, Source::Peer(2));
    let mut bad = slice(&bytes, first).to_vec();
    bad[65_536] ^= 1;
    transfer.delivered(NOW + 10, Source::Peer(1), first, &bad);
    let banned = transfer.drain_commands();
    assert!(banned.contains(&Command::Ban { peer: 1 }));
    assert_eq!(transfer.verified_bytes(), 3 * 65_536);
    peer_only_bounds(&banned, &bytes);
    transfer.delivered(NOW + 20, Source::Peer(2), second, slice(&bytes, second));
    let next = transfer.drain_commands();
    let log = run_peer_only(&mut transfer, &bytes, next, NOW + 20);
    assert!(!requests(&log).iter().any(|(source, _)| *source == Source::Peer(1)));
}

#[test]
fn peer_only_duplicate_and_unsolicited_ranges_never_unlock_or_double_credit() {
    let bytes = object();
    let mut transfer = peer_only_transfer(&bytes, NOW + 5_000, 1);
    transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None)], None, None, &[]);
    let (_, first) = requests(&transfer.drain_commands())[0];
    let unsolicited = PieceRange { start: 1, end: 2 };
    transfer.delivered(NOW + 1, Source::Peer(1), unsolicited, slice(&bytes, unsolicited));
    transfer.start_peer_only_with_probe_peers(NOW + 1, &[peer(2, None, None)], None, None, &[]);
    assert_eq!(transfer.verified_bytes(), 0);
    assert!(transfer.drain_commands().is_empty());
    transfer.delivered(NOW + 2, Source::Peer(1), first, slice(&bytes, first));
    let next = transfer.drain_commands();
    transfer.delivered(NOW + 3, Source::Peer(1), first, slice(&bytes, first));
    assert_eq!(transfer.verified_bytes(), 65_536);
    assert!(transfer.drain_commands().is_empty());
    run_peer_only(&mut transfer, &bytes, next, NOW + 3);
}

#[test]
fn peer_only_max_holders_caps_initial_probes_and_failure_replacement() {
    let bytes = object_sized(13 * 65_536 + 17);
    let mut transfer = peer_only_transfer(&bytes, NOW + 10_000, 2);
    let peers: Vec<Estimate> = (1..=4).map(|id| peer(id, None, None)).collect();
    transfer.start_peer_only_with_probe_peers(NOW, &peers, None, Some(1_000_000.0), &[]);
    let initial = transfer.drain_commands();
    assert_eq!(
        requests(&initial),
        vec![
            (Source::Peer(1), PieceRange { start: 0, end: 1 }),
            (Source::Peer(2), PieceRange { start: 1, end: 2 })
        ]
    );
    transfer.failed(NOW + 10, Source::Peer(1));
    let replacement = transfer.drain_commands();
    assert_eq!(requests(&replacement), vec![(Source::Peer(3), PieceRange { start: 0, end: 1 })]);
    transfer.delivered(
        NOW + 20,
        Source::Peer(2),
        PieceRange { start: 1, end: 2 },
        slice(&bytes, PieceRange { start: 1, end: 2 }),
    );
    let mut seed = transfer.drain_commands();
    seed.extend(replacement);
    let log = run_peer_only(&mut transfer, &bytes, seed, NOW + 20);
    assert!(
        !requests(&log).iter().any(|(source, _)| *source == Source::Peer(4)),
        "a measured holder refills before opening extra probes"
    );
    peer_only_bounds(&initial, &bytes);
}

#[test]
fn peer_only_all_sources_gone_and_empty_roster_fail_without_origin() {
    let bytes = object();
    let mut empty = peer_only_transfer(&bytes, NOW + 5_000, 2);
    empty.start_peer_only_with_probe_peers(NOW, &[], None, None, &[]);
    assert_eq!(empty.drain_commands(), vec![Command::Fail]);
    let mut transfer = peer_only_transfer(&bytes, NOW + 5_000, 2);
    transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None), peer(2, None, None)], None, None, &[]);
    transfer.drain_commands();
    transfer.failed(NOW + 1, Source::Peer(1));
    assert!(transfer.drain_commands().is_empty());
    transfer.failed(NOW + 2, Source::Peer(2));
    assert_eq!(transfer.drain_commands(), vec![Command::Fail]);
    assert!(transfer.finished());
    transfer.failed(NOW + 3, Source::Peer(1));
    assert!(transfer.drain_commands().is_empty());
}

#[test]
fn peer_only_wrong_length_or_wrong_whole_hash_never_delivers() {
    let bytes = object();
    let mut wrong_length = peer_only_transfer(&bytes, NOW + 5_000, 1);
    wrong_length.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None)], None, None, &[]);
    let (_, first) = requests(&wrong_length.drain_commands())[0];
    wrong_length.delivered(NOW + 1, Source::Peer(1), first, &[1]);
    assert_eq!(wrong_length.drain_commands(), vec![Command::Fail]);
    let hashes: Vec<String> = bytes.chunks(65_536).map(hex).collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    let mut wrong_whole = Transfer::new_peer_only(
        TransferConfig {
            max_holders: 1,
            origin_reserve_ms: 0.0,
        },
        bytes.len() as u64,
        &hex(b"different object"),
        &refs,
        NOW + 5_000,
    )
    .unwrap();
    wrong_whole.start_peer_only_with_probe_peers(NOW, &[peer(1, Some(0.0), Some(1_000.0))], None, None, &[]);
    let mut commands = wrong_whole.drain_commands();
    for _ in 0..64 {
        peer_only_bounds(&commands, &bytes);
        let asked = requests(&commands);
        if asked.is_empty() {
            break;
        }
        for (source, range) in asked {
            wrong_whole.delivered(NOW + 10, source, range, slice(&bytes, range));
        }
        commands = wrong_whole.drain_commands();
    }
    assert_eq!(commands, vec![Command::Fail]);
    assert!(wrong_whole.finished());
}

#[test]
fn peer_only_small_and_short_final_objects_keep_existing_integrity() {
    for size in [1, 65_536, 65_537, 3 * 65_536 + 17] {
        let bytes = object_sized(size);
        let mut transfer = peer_only_transfer(&bytes, NOW + 5_000, 1);
        transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None)], None, None, &[]);
        let initial = transfer.drain_commands();
        run_peer_only(&mut transfer, &bytes, initial, NOW);
    }
}

#[test]
fn peer_only_endgame_uses_an_idle_peer_within_cap_and_first_copy_wins() {
    let bytes = object_sized(3 * 65_536);
    let mut transfer = peer_only_transfer(&bytes, NOW + 5_000, 2);
    transfer.start_peer_only_with_probe_peers(
        NOW,
        &[peer(1, Some(0.0), Some(1_000.0)), peer(2, Some(0.0), Some(1_000.0))],
        None,
        None,
        &[],
    );
    let initial = transfer.drain_commands();
    let first = range_of(&initial, Source::Peer(1));
    let slow = range_of(&initial, Source::Peer(2));
    assert_eq!(first.end - first.start, 2);
    assert_eq!(slow.end - slow.start, 1);
    transfer.delivered(NOW + 100, Source::Peer(1), first, slice(&bytes, first));
    assert!(transfer.drain_commands().is_empty());
    transfer.tick(NOW + 101);
    let duplicate = transfer.drain_commands();
    assert_eq!(requests(&duplicate), vec![(Source::Peer(1), slow)]);
    peer_only_bounds(&duplicate, &bytes);
    transfer.tick(NOW + 102);
    assert!(transfer.drain_commands().is_empty(), "endgame work and deadlines must not repeat");
    transfer.delivered(NOW + 110, Source::Peer(1), slow, slice(&bytes, slow));
    let done = transfer.drain_commands();
    assert!(done.contains(&Command::Cancel { peer: 2 }));
    assert_eq!(delivered(&done), Some(&bytes));
    transfer.delivered(NOW + 120, Source::Peer(2), slow, slice(&bytes, slow));
    assert_eq!(transfer.verified_bytes(), bytes.len() as u64);
    assert!(transfer.drain_commands().is_empty());
}

#[test]
fn exclusive_origin_verified_probe_refills_disjoint_tail_before_the_original_floor() {
    let bytes = object_sized(6 * 1024 * 1024);
    let mut transfer = transfer(&bytes, NOW + 4_500).with_exclusive_origin().unwrap();
    transfer.start_with_probe_peers(
        NOW,
        &[peer(1, None, None)],
        origin(0.0, bytes.len() as f64 / 2_000.0),
        None,
        None,
        &[1],
    );
    let mut log = transfer.drain_commands();
    let probe = range_of(&log, Source::Peer(1));
    let prefix = range_of(&log, Source::Origin);
    let count = piece_count(bytes.len() as u64).unwrap();
    assert_eq!(probe.end - probe.start, 1, "unknown calibration is still one piece");
    assert!(prefix.start < prefix.end, "source starts a nonempty prefix immediately");
    assert!(
        prefix.end < count,
        "origin must leave an unissued tail for genuine verified refills"
    );
    let tail = PieceRange {
        start: prefix.end,
        end: count,
    };
    assert!(tail.end - tail.start <= MAX_PEER_REQUEST_PIECES);
    assert!(slice(&bytes, tail).len() as u64 <= MAX_PEER_REQUEST_BYTES);
    transfer.progress(NOW + 100, Source::Peer(1), 16_384);
    transfer.delivered(NOW + 450, Source::Peer(1), probe, slice(&bytes, probe));
    let refilled = transfer.drain_commands();
    let next = range_of(&refilled, Source::Peer(1));
    assert!(
        next.start >= prefix.end && next.end <= count,
        "a refill owns only previously unissued source pieces"
    );
    assert!(
        slice(&bytes, probe).len() + slice(&bytes, next).len() >= bytes.len() / 20,
        "calibration can grow into useful media"
    );
    log.extend(refilled);
    transfer.delivered(NOW + 1_900, Source::Origin, prefix, slice(&bytes, prefix));
    log.extend(transfer.drain_commands());
    transfer.delivered(NOW + 2_000, Source::Peer(1), next, slice(&bytes, next));
    log.extend(transfer.drain_commands());
    assert_eq!(delivered(&log), Some(&bytes));
    let mut issued: Vec<u32> = requests(&log).iter().flat_map(|(_, range)| range.start..range.end).collect();
    issued.sort_unstable();
    assert_eq!(issued, all(bytes.len() as u64), "every physical piece was requested exactly once");
    assert_eq!(transfer.verified_bytes(), bytes.len() as u64);
    assert!(transfer.finished());
}

fn exclusive_probe(bytes: &[u8]) -> (Transfer, Vec<Command>) {
    let mut transfer = transfer(bytes, NOW + 4_500).with_exclusive_origin().unwrap();
    transfer.start_with_probe_peers(
        NOW,
        &[peer(1, None, None)],
        origin(0.0, bytes.len() as f64 / 2_000.0),
        None,
        None,
        &[1],
    );
    let commands = transfer.drain_commands();
    (transfer, commands)
}

#[test]
fn exclusive_origin_small_objects_keep_a_nonempty_source_and_no_missing_piece() {
    for size in [1, 32_768, 65_536, 65_537, 2 * 65_536, 3 * 65_536, 5 * 65_536 + 17] {
        let bytes = object_sized(size);
        let (mut transfer, initial) = exclusive_probe(&bytes);
        let source = range_of(&initial, Source::Origin);
        assert!(source.start < source.end, "source must not wait for a probe: {size}");
        if piece_count(size as u64).unwrap() == 1 {
            assert!(requests(&initial).iter().all(|(source, _)| *source == Source::Origin));
        }
        let mut commands = initial;
        let mut log = Vec::new();
        for _ in 0..16 {
            let next = requests(&commands);
            log.extend(commands);
            for (source, range) in next {
                transfer.delivered(NOW + 10, source, range, slice(&bytes, range));
            }
            commands = transfer.drain_commands();
            if commands.is_empty() {
                break;
            }
            if transfer.finished() {
                log.extend(commands);
                break;
            }
        }
        assert_eq!(delivered(&log), Some(&bytes), "size {size}");
        let mut issued: Vec<u32> = requests(&log).iter().flat_map(|(_, range)| range.start..range.end).collect();
        issued.sort_unstable();
        assert_eq!(issued, all(size as u64), "no starvation or duplicate physical work: {size}");
    }
}

#[test]
fn exclusive_origin_floor_recovers_a_silent_probe_and_all_queued_tail_once() {
    let bytes = object_sized(6 * 1024 * 1024);
    let (mut transfer, mut log) = exclusive_probe(&bytes);
    let probe = range_of(&log, Source::Peer(1));
    let prefix = range_of(&log, Source::Origin);
    assert_eq!(transfer.next_deadline(), Some(NOW + 2_500));
    transfer.tick(NOW + 2_500);
    let floor = transfer.drain_commands();
    assert!(floor.contains(&Command::Cancel { peer: 1 }));
    assert!(requests(&floor).is_empty(), "the running source prefix remains its sole owner");
    log.extend(floor);
    transfer.delivered(NOW + 2_600, Source::Origin, prefix, slice(&bytes, prefix));
    let recovery = transfer.drain_commands();
    let recovered: Vec<u32> = requests(&recovery).iter().flat_map(|(_, range)| range.start..range.end).collect();
    assert_eq!(
        recovered.len(),
        5,
        "one cancelled probe plus the entire four-piece tail refills at once"
    );
    let before_late = transfer.verified_bytes();
    transfer.delivered(NOW + 2_601, Source::Peer(1), probe, slice(&bytes, probe));
    assert_eq!(transfer.verified_bytes(), before_late, "late cancelled bytes earn no credit");
    assert!(transfer.drain_commands().is_empty());
    for (source, range) in requests(&recovery) {
        transfer.delivered(NOW + 2_800, source, range, slice(&bytes, range));
        log.extend(transfer.drain_commands());
    }
    log.extend(recovery);
    assert_eq!(delivered(&log), Some(&bytes));
    assert_eq!(transfer.verified_bytes(), bytes.len() as u64);
}

#[test]
fn exclusive_origin_failed_or_stalled_refill_preserves_verified_probe_and_recovers_tail() {
    let bytes = object_sized(6 * 1024 * 1024);
    for stalled in [false, true] {
        let (mut transfer, mut log) = exclusive_probe(&bytes);
        let probe = range_of(&log, Source::Peer(1));
        let prefix = range_of(&log, Source::Origin);
        transfer.progress(NOW + 100, Source::Peer(1), 16_384);
        transfer.delivered(NOW + 450, Source::Peer(1), probe, slice(&bytes, probe));
        let refill = transfer.drain_commands();
        let tail = range_of(&refill, Source::Peer(1));
        log.extend(refill);
        if stalled {
            transfer.progress(NOW + 550, Source::Peer(1), 16_384);
            transfer.progress(NOW + 1_200, Source::Peer(1), 32_768);
        } else {
            transfer.failed(NOW + 600, Source::Peer(1));
        }
        let retired = transfer.drain_commands();
        if stalled {
            assert!(retired.contains(&Command::Abandon { peer: 1 }));
        }
        assert!(requests(&retired).is_empty(), "recovery does not duplicate the running prefix");
        log.extend(retired);
        let credited = transfer.verified_bytes();
        transfer.delivered(NOW + 1_300, Source::Peer(1), tail, slice(&bytes, tail));
        assert_eq!(transfer.verified_bytes(), credited);
        transfer.delivered(NOW + 1_900, Source::Origin, prefix, slice(&bytes, prefix));
        let recovery = transfer.drain_commands();
        assert_eq!(
            requests(&recovery),
            vec![(Source::Origin, tail)],
            "the entire remaining batch refills without holding another tail"
        );
        transfer.delivered(NOW + 2_100, Source::Origin, tail, slice(&bytes, tail));
        log.extend(recovery);
        log.extend(transfer.drain_commands());
        assert_eq!(delivered(&log), Some(&bytes));
        assert_eq!(transfer.verified_bytes(), bytes.len() as u64);
    }
}

#[test]
fn exclusive_origin_corrupt_probe_cannot_claim_or_credit_the_unissued_tail() {
    let bytes = object_sized(6 * 1024 * 1024);
    let (mut transfer, mut log) = exclusive_probe(&bytes);
    let probe = range_of(&log, Source::Peer(1));
    let prefix = range_of(&log, Source::Origin);
    let mut corrupt = slice(&bytes, probe).to_vec();
    corrupt[0] ^= 1;
    transfer.delivered(NOW + 400, Source::Peer(1), probe, &corrupt);
    let banned = transfer.drain_commands();
    assert!(banned.contains(&Command::Ban { peer: 1 }));
    assert!(requests(&banned).is_empty());
    assert_eq!(transfer.verified_bytes(), 0);
    log.extend(banned);
    transfer.delivered(NOW + 1_900, Source::Origin, prefix, slice(&bytes, prefix));
    let recovery = transfer.drain_commands();
    assert_eq!(requests(&recovery).iter().map(|(_, range)| range.end - range.start).sum::<u32>(), 5);
    for (source, range) in requests(&recovery) {
        assert_eq!(source, Source::Origin);
        transfer.delivered(NOW + 2_100, source, range, slice(&bytes, range));
        log.extend(transfer.drain_commands());
    }
    log.extend(recovery);
    assert_eq!(delivered(&log), Some(&bytes));
}

#[test]
fn exclusive_origin_endgame_does_not_duplicate_a_running_peer_or_source() {
    let bytes = object_sized(3 * 65_536);
    let (mut transfer, initial) = exclusive_probe(&bytes);
    let probe = range_of(&initial, Source::Peer(1));
    let prefix = range_of(&initial, Source::Origin);
    transfer.delivered(NOW + 100, Source::Peer(1), probe, slice(&bytes, probe));
    let tail = range_of(&transfer.drain_commands(), Source::Peer(1));
    transfer.delivered(NOW + 200, Source::Origin, prefix, slice(&bytes, prefix));
    assert!(transfer.drain_commands().is_empty());
    transfer.tick(NOW + 230);
    assert!(
        transfer.drain_commands().is_empty(),
        "a late projection cannot create duplicate physical IO"
    );
    assert!(
        transfer.next_deadline().is_none_or(|at| at > NOW + 230),
        "disabled endgame must not retain an expired polling deadline"
    );
    transfer.delivered(NOW + 300, Source::Peer(1), tail, slice(&bytes, tail));
    assert_eq!(delivered(&transfer.drain_commands()), Some(&bytes));
}

#[test]
fn exclusive_origin_known_initial_plan_is_unchanged_and_source_failure_terminates() {
    let bytes = object_sized(6 * 1024 * 1024);
    let mut legacy = transfer(&bytes, NOW + 4_500);
    let mut exclusive = transfer(&bytes, NOW + 4_500).with_exclusive_origin().unwrap();
    for transfer in [&mut legacy, &mut exclusive] {
        transfer.start(NOW, &[peer(1, Some(100.0), Some(300.0))], origin(0.0, 3_000.0), None, None);
    }
    let old = legacy.drain_commands();
    let initial = exclusive.drain_commands();
    assert_eq!(initial, old, "a known lane needs no calibration tail hold");
    assert!(requests(&initial).iter().any(|(source, _)| *source == Source::Origin));
    assert!(requests(&initial).iter().any(|(source, _)| *source == Source::Peer(1)));
    exclusive.failed(NOW + 200, Source::Origin);
    let failed = exclusive.drain_commands();
    assert!(failed.contains(&Command::Fail));
    assert!(failed.contains(&Command::Cancel { peer: 1 }));
    assert!(exclusive.finished());
    for (source, range) in requests(&initial) {
        exclusive.delivered(NOW + 300, source, range, slice(&bytes, range));
    }
    assert_eq!(exclusive.verified_bytes(), 0);
    assert!(exclusive.drain_commands().is_empty());
}

#[test]
fn exclusive_origin_builder_refuses_peer_only_and_started_transfers() {
    let bytes = object();
    assert!(peer_only_transfer(&bytes, NOW + 4_500, 1).with_exclusive_origin().is_none());
    let mut transfer = transfer(&bytes, NOW + 4_500).with_exclusive_origin().unwrap();
    transfer.start_peer_only_with_probe_peers(NOW, &[peer(1, None, None)], None, None, &[1]);
    assert!(
        transfer.drain_commands().is_empty(),
        "originless start cannot bypass the creation contract"
    );
    transfer.start(NOW, &[], origin(0.0, 3_000.0), None, None);
    assert!(!transfer.drain_commands().is_empty());
    assert!(transfer.with_exclusive_origin().is_none());
}

#[test]
fn exclusive_origin_tail_obeys_both_caps_even_when_one_canonical_piece_is_oversized() {
    for size in [6 * 1024 * 1024, 16 * 1024 * 1024, 33 * 1024 * 1024] {
        let bytes = object_sized(size);
        let (_, initial) = exclusive_probe(&bytes);
        let prefix = range_of(&initial, Source::Origin);
        let count = piece_count(size as u64).unwrap();
        let tail = PieceRange {
            start: prefix.end,
            end: count,
        };
        assert!(tail.end - tail.start <= MAX_PEER_REQUEST_PIECES);
        let held = if tail.start == tail.end {
            0
        } else {
            slice(&bytes, tail).len() as u64
        };
        assert!(held <= MAX_PEER_REQUEST_BYTES, "size {size}: {held} held bytes");
        if commitment_piece_size(size as i64) as u64 > MAX_PEER_REQUEST_BYTES {
            assert_eq!(held, 0, "an indivisible oversized piece is never withheld as a tail");
        }
    }
}
