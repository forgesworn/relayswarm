use relayswarm_proto::player_hint::{player_hint, Command, Supply};
use relayswarm_proto::scheduler::{Estimate, Source};
use serde_json::Value;

#[test]
fn replay_supply_hints() {
    let trace: Value = serde_json::from_str(include_str!("../../vectors/player-hint-traces.json")).unwrap();
    for row in trace["steps"].as_array().unwrap() {
        let input = &row["input"];
        let timing = |source, entry: &Value, offset: usize| Estimate {
            source,
            first_byte_ms: entry[offset].as_f64(),
            rate: entry[offset + 1].as_f64(),
        };
        let peers: Vec<Estimate> = input["peers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| timing(Source::Peer(p[0].as_u64().unwrap()), p, 1))
            .collect();
        let origin = input["origin"]
            .as_array()
            .unwrap()
            .iter()
            .any(Value::is_number)
            .then(|| timing(Source::Origin, &input["origin"], 0));
        let Command::PlayerHint(hint) = player_hint(&Supply {
            rendition: input["rendition"].as_str().unwrap(),
            size: input["size"].as_u64(),
            peers: &peers,
            origin,
            shared_first_byte_ms: input["sharedFirstByteMs"].as_f64(),
            shared_rate: input["sharedRate"].as_f64(),
            available_ms: input["availableMs"].as_f64().unwrap(),
            max_holders: input["maxHolders"].as_u64().unwrap() as usize,
        });
        let expected = &row["out"];
        assert_eq!(hint.rendition, expected["rendition"].as_str().unwrap());
        assert_eq!(hint.eligible_holders, expected["eligibleHolders"].as_u64().unwrap() as u32);
        assert_eq!(hint.projected_ms, expected["projectedMs"].as_f64(), "{row}");
    }
}
