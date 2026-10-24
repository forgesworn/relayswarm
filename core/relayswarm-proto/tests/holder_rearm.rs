use relayswarm_proto::discovery::NeighbourDiscovery;
use relayswarm_proto::selection::PeerSelection;

#[test]
fn spent_replacements_rearm_only_for_current_demand_after_the_interval() {
    let mut state = NeighbourDiscovery::new();
    let key = "a".repeat(64);
    let peer = "b".repeat(64);
    let context = state.demand(0, "main", "main:0", &key).unwrap();
    state.hint(0, &peer, &[&key], Some("ticket"));
    let found = state.choose(0, |_| true, |_| true, false).unwrap();
    let attempt = state.begin(0, &found).unwrap();
    assert!(state.replaced(0, attempt, Some("victim")));
    state.end();
    assert!(!state.rearm(19_999, context, true));
    assert!(!state.rearm(20_000, context, false));
    assert!(state.rearm(20_000, context, true));
    assert!(!state.rearm(20_001, context, true));
    let found = state.choose(20_001, |_| true, |_| true, false).unwrap();
    let attempt = state.begin(20_001, &found).unwrap();
    assert!(state.replaced(20_001, attempt, None));
    state.end();
    assert!(!state.rearm(40_001, context, true), "old demand is no longer current");
    state.demand(40_001, "main", "main:0", &key);
    assert!(state.rearm(40_001, context, true));
    assert_eq!(state.counters.rearmed, 2);
    assert!(!state.rearm(0, context, true), "time reversal cannot rearm");
}

#[test]
fn a_miss_is_counted_once_and_a_trial_does_not_invent_delivery_evidence() {
    let mut state = NeighbourDiscovery::new();
    let key = "a".repeat(64);
    let peer = "b".repeat(64);
    let context = state.demand(0, "main", "main:0", &key).unwrap();
    assert!(state.holder_miss(0, Some(context), &peer, &key));
    assert!(!state.holder_miss(1, Some(context), &peer, &key));
    assert!(!state.holder_miss(2, None, &peer, &key));
    state.holder_ahead(Some(context), &peer);
    assert!(state.holder_miss(3, Some(context), &peer, &key));
    let mut selection = PeerSelection::new();
    selection.mark_selected(7);
    let observation = selection.summary(7);
    assert_eq!(observation.last_selected, 1);
    assert_eq!(observation.attempts, 0);
    assert_eq!(observation.latency_ms, None);
}
