//! Bounded advisory neighbour-discovery state, ported from
//! `src/browser/neighbour-discovery.mjs`. The swarm owns admission, slots
//! and connections; this records demand, hints and per-context holder
//! misses, and runs at most one replacement window at a time.
//!
//! Contexts, windows and attempts are addressed by IDs where the JavaScript
//! compares object identity.

use indexmap::IndexMap;

use crate::js::is_hex64;

const STALE_HOLDER_MISSES: u32 = 4;
const STALE_HOLDER_MS: u64 = 10_000;
const MAX_HOLDERS: usize = 8;
const MAX_CANDIDATES: usize = 64;
const MAX_CANDIDATE_KEYS: usize = 8;
const CONTEXT_IDLE_MS: u64 = 30_000;
const CANDIDATE_FRESH_MS: u64 = 60_000;
const WINDOW_MS: u64 = 15_000;
const MAX_TICKET_BYTES: usize = 2 * 1024;

/// `validTicket` from `relay-session.mjs`.
pub fn valid_ticket(ticket: Option<&str>) -> bool {
    ticket.is_some_and(|ticket| !ticket.is_empty() && ticket.len() <= MAX_TICKET_BYTES)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MediaType {
    Main,
    Audio,
}

impl MediaType {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "main" => Some(MediaType::Main),
            "audio" => Some(MediaType::Audio),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            MediaType::Main => "main",
            MediaType::Audio => "audio",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ContextId(u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AttemptId(u64);

impl ContextId {
    /// The number a host stores in place of the context.
    pub fn value(self) -> u64 {
        self.0
    }
    pub fn from_value(value: u64) -> Self {
        ContextId(value)
    }
}

impl AttemptId {
    pub fn value(self) -> u64 {
        self.0
    }
    pub fn from_value(value: u64) -> Self {
        AttemptId(value)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Holder {
    pub first_miss_at: u64,
    pub misses: u32,
    pub last_key: String,
}

#[derive(Clone, Debug)]
pub struct Context {
    pub id: ContextId,
    pub media_type: MediaType,
    pub rendition: String,
    pub keys: Vec<String>,
    pub last_demand_at: Option<u64>,
    pub activity_at: u64,
    pub spent: bool,
    pub holders: IndexMap<String, Holder>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub pubkey: String,
    pub have: Vec<String>,
    pub ticket: Option<String>,
    pub at: u64,
}

#[derive(Clone, Debug)]
pub struct Attempt {
    pub id: AttemptId,
    window: u64,
    pub pubkey: String,
    pub ticket: Option<String>,
    pub key: String,
    pub dial: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Window {
    pub id: u64,
    /// The context the window serves, which may since have been replaced.
    pub context: ContextId,
    pub media_type: MediaType,
    pub created_at: u64,
    pub expires_at: u64,
    pub attempt: Option<Attempt>,
    pub vacant: bool,
    pub victim: Option<String>,
}

/// A hinted candidate for a demanded key.
#[derive(Clone, Debug)]
pub struct Found {
    pub context: ContextId,
    pub media_type: MediaType,
    pub candidate: Candidate,
    pub key: String,
    last_demand_at: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub checks: u64,
    pub replacements: u64,
    pub expired: u64,
    pub opened: u64,
    pub verified: u64,
    pub stale_holder: u64,
    pub stale_blocked: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub candidates: usize,
    pub contexts: usize,
    pub requested_keys: usize,
    pub replacement_spent: usize,
    pub opportunity_active: bool,
    pub remaining_ms: u64,
    pub vacancy_reserved: bool,
    pub counters: Counters,
}

#[derive(Clone, Debug, Default)]
pub struct NeighbourDiscovery {
    contexts: IndexMap<MediaType, Context>,
    candidates: IndexMap<String, Candidate>,
    window: Option<Window>,
    attempts: IndexMap<AttemptId, Attempt>,
    next_id: u64,
    pub counters: Counters,
}

impl NeighbourDiscovery {
    pub fn new() -> Self {
        Self::default()
    }

    fn fresh_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    pub fn contexts(&self) -> impl Iterator<Item = &Context> {
        self.contexts.values()
    }
    pub fn candidates(&self) -> impl Iterator<Item = &Candidate> {
        self.candidates.values()
    }
    pub fn window(&self) -> Option<&Window> {
        self.window.as_ref()
    }

    /// The live context for this media type and rendition, created or reset
    /// after 30 s without activity or demand.
    pub fn context(&mut self, now: u64, media_type: &str, rendition: &str) -> Option<ContextId> {
        let media_type = MediaType::parse(media_type)?;
        let replace = self.contexts.get(&media_type).is_none_or(|context| context.rendition != rendition);
        if replace {
            let id = ContextId(self.fresh_id());
            let context = Context {
                id,
                media_type,
                rendition: rendition.to_owned(),
                keys: Vec::new(),
                last_demand_at: None,
                activity_at: now,
                spent: false,
                holders: IndexMap::new(),
            };
            self.contexts.insert(media_type, context);
            return Some(id);
        }
        let context = self.contexts.get_mut(&media_type).unwrap();
        let idle = |since: u64| now < since || now - since >= CONTEXT_IDLE_MS;
        if idle(context.activity_at) || context.last_demand_at.is_some_and(idle) {
            context.keys.clear();
            context.last_demand_at = None;
            context.holders.clear();
        }
        context.activity_at = now;
        Some(context.id)
    }

    fn live_context(&self, id: ContextId) -> Option<&Context> {
        self.contexts.values().find(|context| context.id == id)
    }

    fn live_context_mut(&mut self, id: ContextId) -> Option<&mut Context> {
        self.contexts.values_mut().find(|context| context.id == id)
    }

    /// Record demand for `key`; keeps the two most recent keys, with an
    /// in-flight attempt's key pinned first.
    pub fn demand(&mut self, now: u64, media_type: &str, rendition: &str, key: &str) -> Option<ContextId> {
        let id = self.context(now, media_type, rendition)?;
        if !is_hex64(key) {
            return None;
        }
        let pinned = if self.live(now) && self.window.as_ref().is_some_and(|window| window.context == id) {
            self.window
                .as_ref()
                .and_then(|window| window.attempt.as_ref())
                .map(|attempt| attempt.key.clone())
        } else {
            None
        };
        let context = self.live_context_mut(id).unwrap();
        let mut keys: Vec<String> = Vec::new();
        for value in pinned
            .into_iter()
            .chain(std::iter::once(key.to_owned()))
            .chain(context.keys.drain(..))
        {
            if !keys.contains(&value) {
                keys.push(value);
            }
        }
        keys.truncate(2);
        context.keys = keys;
        context.last_demand_at = Some(now);
        Some(id)
    }

    /// A peer's advertised keys and ticket, newest last, at most 64 peers.
    pub fn hint(&mut self, now: u64, pubkey: &str, have: &[&str], ticket: Option<&str>) {
        if !is_hex64(pubkey) {
            return;
        }
        let mut keys: Vec<String> = Vec::new();
        for key in have.iter().filter(|key| is_hex64(key)) {
            if !keys.iter().any(|existing| existing == key) {
                keys.push((*key).to_owned());
            }
        }
        let start = keys.len().saturating_sub(MAX_CANDIDATE_KEYS);
        self.candidates.shift_remove(pubkey);
        self.candidates.insert(
            pubkey.to_owned(),
            Candidate {
                pubkey: pubkey.to_owned(),
                have: keys[start..].to_vec(),
                ticket: valid_ticket(ticket).then(|| ticket.unwrap().to_owned()),
                at: now,
            },
        );
        if self.candidates.len() > MAX_CANDIDATES {
            self.candidates.shift_remove_index(0);
        }
    }

    /// This holder lacked `key` at the deadline; one miss per distinct key.
    pub fn holder_miss(&mut self, now: u64, context: Option<ContextId>, pubkey: &str, key: &str) {
        if !is_hex64(pubkey) || !is_hex64(key) {
            return;
        }
        let Some(context) = context.and_then(|id| self.live_context_mut(id)) else {
            return;
        };
        if let Some(entry) = context.holders.get_mut(pubkey) {
            if entry.last_key != key {
                entry.misses += 1;
                entry.last_key = key.to_owned();
            }
            return;
        }
        if context.holders.len() >= MAX_HOLDERS {
            context.holders.shift_remove_index(0);
        }
        context.holders.insert(
            pubkey.to_owned(),
            Holder {
                first_miss_at: now,
                misses: 1,
                last_key: key.to_owned(),
            },
        );
    }

    pub fn holder_ahead(&mut self, context: Option<ContextId>, pubkey: &str) {
        if let Some(context) = context.and_then(|id| self.live_context_mut(id)) {
            context.holders.shift_remove(pubkey);
        }
    }

    /// The holder has missed on enough distinct keys for long enough.
    pub fn stale(&self, now: u64, context: Option<ContextId>, pubkey: &str) -> bool {
        context
            .and_then(|id| self.live_context(id))
            .and_then(|context| context.holders.get(pubkey))
            .is_some_and(|entry| {
                entry.misses >= STALE_HOLDER_MISSES && now.wrapping_sub(entry.first_miss_at) as i64 >= STALE_HOLDER_MS as i64
            })
    }

    pub fn forget(&mut self, pubkey: &str) {
        for context in self.contexts.values_mut() {
            context.holders.shift_remove(pubkey);
        }
    }

    fn current_context(context: &Context, now: u64) -> bool {
        now >= context.activity_at
            && now - context.activity_at < CONTEXT_IDLE_MS
            && context.last_demand_at.is_some_and(|at| now >= at && now - at < CONTEXT_IDLE_MS)
    }

    /// The context is live, recently active and recently demanded.
    pub fn current(&self, now: u64, context: ContextId) -> bool {
        self.live_context(context)
            .is_some_and(|context| Self::current_context(context, now))
    }

    /// A hinted candidate for an unmet current context, or `None`.
    pub fn choose(&self, now: u64, eligible: impl Fn(&Candidate) -> bool, unmet: impl Fn(MediaType) -> bool, room: bool) -> Option<Found> {
        if self.window.as_ref().is_some_and(|window| window.attempt.is_some()) {
            return None;
        }
        let contexts: Vec<(ContextId, MediaType)> = match &self.window {
            Some(window) => vec![(window.context, window.media_type)],
            None => self.contexts.values().map(|context| (context.id, context.media_type)).collect(),
        };
        let vacant = self.window.as_ref().is_some_and(|window| window.vacant);
        for (context, media_type) in contexts {
            if !self.current(now, context) || !unmet(media_type) || (!room && self.spent(context) && !vacant) {
                continue;
            }
            if let Some(found) = self.hinted(now, context, &eligible) {
                return Some(found);
            }
        }
        None
    }

    fn spent(&self, context: ContextId) -> bool {
        self.live_context(context).is_some_and(|context| context.spent)
    }

    /// A fresh eligible candidate hinting a key this context demands.
    pub fn hinted(&self, now: u64, context: ContextId, eligible: &impl Fn(&Candidate) -> bool) -> Option<Found> {
        let context = self.live_context(context)?;
        for candidate in self.candidates.values() {
            if now < candidate.at || now - candidate.at >= CANDIDATE_FRESH_MS || !eligible(candidate) {
                continue;
            }
            if let Some(key) = context.keys.iter().find(|key| candidate.have.contains(key)) {
                return Some(Found {
                    context: context.id,
                    media_type: context.media_type,
                    candidate: candidate.clone(),
                    key: key.clone(),
                    last_demand_at: context.last_demand_at,
                });
            }
        }
        None
    }

    /// Open the replacement window if none is open, then start one attempt.
    pub fn begin(&mut self, now: u64, found: &Found) -> Option<AttemptId> {
        if self.window.is_none() {
            let id = self.fresh_id();
            let expires_at = (now + WINDOW_MS)
                .min(found.candidate.at + CANDIDATE_FRESH_MS)
                .min(found.last_demand_at.unwrap_or(0) + CONTEXT_IDLE_MS);
            self.window = Some(Window {
                id,
                context: found.context,
                media_type: found.media_type,
                created_at: now,
                expires_at,
                attempt: None,
                vacant: false,
                victim: None,
            });
        }
        let window = self.window.as_ref().unwrap();
        if window.context != found.context || window.attempt.is_some() || now >= window.expires_at {
            return None;
        }
        let window_id = window.id;
        let attempt = Attempt {
            id: AttemptId(self.fresh_id()),
            window: window_id,
            pubkey: found.candidate.pubkey.clone(),
            ticket: found.candidate.ticket.clone(),
            key: found.key.clone(),
            dial: None,
        };
        let id = attempt.id;
        // Only the open window's attempts can still change visible state.
        self.attempts.retain(|_, stored| stored.window == window_id);
        self.attempts.insert(id, attempt.clone());
        self.window.as_mut().unwrap().attempt = Some(attempt);
        self.counters.checks += 1;
        Some(id)
    }

    fn window_attempt(&self, attempt: AttemptId) -> Option<&Attempt> {
        self.window.as_ref()?.attempt.as_ref().filter(|current| current.id == attempt)
    }

    /// The attempt is still the window's, current and freshly hinted.
    pub fn valid(&self, now: u64, attempt: AttemptId) -> bool {
        let Some(current) = self.window_attempt(attempt) else {
            return false;
        };
        let window = self.window.as_ref().unwrap();
        let Some(candidate) = self.candidates.get(&current.pubkey) else {
            return false;
        };
        self.live(now)
            && self.current(now, window.context)
            && now >= candidate.at
            && now - candidate.at < CANDIDATE_FRESH_MS
            && candidate.ticket == current.ticket
            && candidate.have.contains(&current.key)
    }

    /// Spend this context's one replacement, dropping `victim` for the attempt.
    pub fn replaced(&mut self, now: u64, attempt: AttemptId, victim: Option<&str>) -> bool {
        if !self.valid(now, attempt) {
            return false;
        }
        let context = self.window.as_ref().unwrap().context;
        if self.spent(context) {
            return false;
        }
        self.live_context_mut(context).unwrap().spent = true;
        let window = self.window.as_mut().unwrap();
        window.vacant = true;
        window.victim = victim.map(str::to_owned);
        self.counters.replacements += 1;
        true
    }

    pub fn allocated(&mut self, attempt: AttemptId, dial: u64) {
        let Some(stored) = self.attempts.get_mut(&attempt) else { return };
        stored.dial = Some(dial);
        let window_id = stored.window;
        if let Some(window) = self.window.as_mut().filter(|window| window.id == window_id) {
            window.vacant = false;
            if let Some(current) = window.attempt.as_mut().filter(|current| current.id == attempt) {
                current.dial = Some(dial);
            }
        }
    }

    pub fn abandoned(&mut self, attempt: AttemptId) {
        if self.window_attempt(attempt).is_some() {
            self.window.as_mut().unwrap().attempt = None;
        }
    }

    pub fn failed(&mut self, dial: u64) {
        let Some(window) = self.window.as_mut() else { return };
        if window.attempt.as_ref().is_none_or(|attempt| attempt.dial != Some(dial)) {
            return;
        }
        window.attempt = None;
        window.vacant = window.victim.is_some();
    }

    /// Close the current window.
    pub fn end(&mut self) -> bool {
        self.attempts.clear();
        self.window.take().is_some()
    }

    /// A verified peer segment re-arms the context's replacement.
    pub fn verified(&mut self, context: Option<ContextId>) -> bool {
        let Some(context) = context.and_then(|id| self.live_context_mut(id)) else {
            return false;
        };
        context.spent = false;
        self.counters.verified += 1;
        true
    }

    pub fn live(&self, now: u64) -> bool {
        self.window
            .as_ref()
            .is_some_and(|window| now >= window.created_at && now < window.expires_at)
    }

    pub fn reserved(&self, now: u64) -> bool {
        self.live(now)
            && self
                .window
                .as_ref()
                .is_some_and(|window| window.vacant && self.current(now, window.context))
    }

    pub fn suppresses(&self, now: u64, pubkey: &str) -> bool {
        self.live(now) && self.window.as_ref().is_some_and(|window| window.victim.as_deref() == Some(pubkey))
    }

    pub fn snapshot(&self, now: u64) -> Snapshot {
        let live = self.live(now);
        Snapshot {
            candidates: self.candidates.len(),
            contexts: self.contexts.len(),
            requested_keys: self.contexts.values().map(|context| context.keys.len()).sum(),
            replacement_spent: self.contexts.values().filter(|context| context.spent).count(),
            opportunity_active: live,
            remaining_ms: if live {
                WINDOW_MS.min(self.window.as_ref().unwrap().expires_at - now)
            } else {
                0
            },
            vacancy_reserved: self.reserved(now),
            counters: self.counters.clone(),
        }
    }

    pub fn clear(&mut self) {
        self.window = None;
        self.contexts.clear();
        self.candidates.clear();
        self.attempts.clear();
    }
}
