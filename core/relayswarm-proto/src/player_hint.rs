//! Advisory supply for a rendition's next segment. The shell supplies only
//! already-known eligible HAVE holders; this never starts discovery or I/O.
use crate::pieces::piece_count;
use crate::scheduler::{plan, Estimate, PlanInput};

#[derive(Clone, Debug, PartialEq)]
pub struct PlayerHint {
    pub rendition: String,
    pub eligible_holders: u32,
    /// Duration from the observation, not a wall-clock timestamp. Unknown
    /// sizes or unavailable timing produce None, never a zero-cost segment.
    pub projected_ms: Option<f64>,
}

/// The PlayerHint command is advisory. A player may use it only to break a
/// tie between levels its origin estimate already sustains; never force one.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    PlayerHint(PlayerHint),
}

pub struct Supply<'a> {
    pub rendition: &'a str,
    pub size: Option<u64>,
    pub peers: &'a [Estimate],
    pub origin: Option<Estimate>,
    pub shared_first_byte_ms: Option<f64>,
    pub shared_rate: Option<f64>,
    pub available_ms: f64,
    pub max_holders: usize,
}

pub fn player_hint(supply: &Supply) -> Command {
    let projected_ms = supply.size.and_then(piece_count).and_then(|count| {
        let needed: Vec<u32> = (0..count).collect();
        let projected = plan(&PlanInput {
            size: supply.size?,
            needed: &needed,
            peers: supply.peers,
            origin: supply.origin,
            shared_first_byte_ms: supply.shared_first_byte_ms,
            shared_rate: supply.shared_rate,
            available_ms: supply.available_ms,
            max_holders: supply.max_holders,
        })
        .projected_ms;
        projected.is_finite().then_some(projected)
    });
    Command::PlayerHint(PlayerHint {
        rendition: supply.rendition.to_owned(),
        eligible_holders: supply.peers.len() as u32,
        projected_ms,
    })
}
