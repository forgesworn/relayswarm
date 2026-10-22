//! Signed media commitments, scoped delegation and revocation (kinds 24172 to
//! 24174 against a kind 30311 stream authorisation), ported from
//! `src/browser/segment-commitment.mjs`. Every function returns the same
//! accept/reject outcome and the same returned content as the JavaScript.

use serde_json::{Map, Value};

use crate::event::{bounded, field_eq, single_tag, verify_event};
use crate::js;

pub const KIND_STREAM_AUTHORISATION: i64 = 30311;
pub const KIND_SEGMENT_COMMITMENT: i64 = 24172;
pub const KIND_COMMITMENT_DELEGATION: i64 = 24173;
pub const KIND_COMMITMENT_REVOCATION: i64 = 24174;
pub const MAX_SEGMENT_BYTES: i64 = 16 * 1024 * 1024;

const DOMAIN_V1: &str = "relayswarm-segment-v1";
const DOMAIN_V2: &str = "relayswarm-segment-v2";
const DOMAIN_DELEGATION: &str = "relayswarm-commitment-delegation-v1";
const DOMAIN_REVOCATION: &str = "relayswarm-commitment-revocation-v1";

/// The fragment context the shell supplies, already reduced from the player's
/// own structures. `media` is the shell's exact playlist identity
/// (`segmentMediaContext` in JavaScript) or `None` when it has none.
#[derive(Clone, Debug)]
pub struct FragmentContext {
    /// `frag.sn` as the player reports it.
    pub sequence: Value,
    /// `frag.cc ?? 0`.
    pub discontinuity: Value,
    /// `part?.index ?? null`.
    pub part: Value,
    /// `String(frag.level)`.
    pub level: String,
    /// `frag.type`, or null when absent.
    pub frag_type: Value,
    /// `frag.decryptdata?.method`, or null when absent.
    pub decrypt_method: Value,
    /// `{ playlist, mediaType, encryption }` for schema 2, or `None`.
    pub media: Option<Value>,
}

/// Host-supplied trust inputs for one verification.
#[derive(Clone, Debug)]
pub struct Trust<'a> {
    pub stream_event: &'a Value,
    pub swarm_id: &'a str,
    pub revoked_delegation_ids: &'a [Value],
    pub delegation_revocations: &'a [Value],
}

fn kind_is(event: &Value, kind: i64) -> bool {
    event.get("kind").and_then(Value::as_f64) == Some(kind as f64)
}

fn get<'a>(object: &'a Map<String, Value>, name: &str) -> &'a Value {
    object.get(name).unwrap_or(&Value::Null)
}

fn absent_or<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    object.get(name)
}

/// `/^\/media\/[a-z0-9_./-]+$/iu` with no `..` segment. Under `iu`, U+212A
/// (Kelvin sign) and U+017F (long s) case-fold into `[a-z]`, so they match.
pub fn safe_path(value: &Value) -> bool {
    let Some(path) = value.as_str() else { return false };
    let Some(rest) = path.strip_prefix("/media/") else { return false };
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-' | '\u{212A}' | '\u{017F}'))
        && !path.split('/').any(|segment| segment == "..")
}

/// `/^(?:0|[1-9][0-9]{0,3})$/u.test(String(entry))`.
fn numeric_rendition(value: &Value) -> bool {
    let text = js::to_string(value);
    text == "0" || (matches!(text.len(), 1..=4) && !text.starts_with('0') && text.bytes().all(|b| b.is_ascii_digit()))
}

/// Parse content that must be a JSON object; anything else reads as a
/// rejection, as a throw inside the JavaScript `try` does.
fn parse_object(content: &Value) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(content.as_str()?).ok()? {
        Value::Object(map) => Some(map),
        // A parsed primitive or array makes the JavaScript property reads
        // return undefined and the canonical comparison fail.
        _ => None,
    }
}

fn canonical(fields: &[(&str, Option<&Value>)]) -> String {
    // JSON.stringify omits properties whose value is undefined.
    let present: Vec<(&str, &Value)> = fields.iter().filter_map(|(name, value)| value.map(|v| (*name, v))).collect();
    js::stringify_fields(&present)
}

/// `commitmentContent(value)`.
pub fn commitment_content(value: &Map<String, Value>) -> String {
    let wide = js::strict_eq(get(value, "v"), &Value::from(2));
    let domain = Value::from(if wide { DOMAIN_V2 } else { DOMAIN_V1 });
    let version = Value::from(if wide { 2 } else { 1 });
    let mut fields: Vec<(&str, Option<&Value>)> = vec![("domain", Some(&domain)), ("v", Some(&version))];
    for name in [
        "streamEventId",
        "swarmId",
        "key",
        "rendition",
        "sequence",
        "discontinuity",
        "part",
        "sha256",
        "size",
        "expiresAt",
    ] {
        fields.push((name, absent_or(value, name)));
    }
    if wide {
        for name in ["playlist", "mediaType", "encryption"] {
            fields.push((name, absent_or(value, name)));
        }
    }
    canonical(&fields)
}

/// `delegationContent(value)`.
pub fn delegation_content(value: &Map<String, Value>) -> String {
    let domain = Value::from(DOMAIN_DELEGATION);
    let version = Value::from(1);
    let mut fields: Vec<(&str, Option<&Value>)> = vec![("domain", Some(&domain)), ("v", Some(&version))];
    for name in [
        "streamEventId",
        "swarmId",
        "delegatePubkey",
        "notBefore",
        "expiresAt",
        "renditions",
        "mediaTypes",
        "allowParts",
        "maxSegmentBytes",
    ] {
        fields.push((name, absent_or(value, name)));
    }
    canonical(&fields)
}

/// `revocationContent(value)`.
pub fn revocation_content(value: &Map<String, Value>) -> String {
    let domain = Value::from(DOMAIN_REVOCATION);
    let version = Value::from(1);
    let mut fields: Vec<(&str, Option<&Value>)> = vec![("domain", Some(&domain)), ("v", Some(&version))];
    for name in ["streamEventId", "swarmId", "delegationId"] {
        fields.push((name, absent_or(value, name)));
    }
    canonical(&fields)
}

/// `validStreamAuthorisation(event)`.
pub fn valid_stream_authorisation(event: &Value) -> bool {
    kind_is(event, KIND_STREAM_AUTHORISATION)
        && bounded(event)
        && verify_event(event)
        && single_tag(event, "d").is_some()
        && event["tags"].as_array().is_some_and(|tags| {
            tags.iter().any(|tag| {
                tag.as_array()
                    .is_some_and(|items| items.len() == 3 && items[0] == "relayswarm" && items[1] == "redistribute" && items[2] == "1")
            })
        })
}

fn seconds(at_ms: i64) -> i64 {
    at_ms.div_euclid(1000)
}

fn unique(values: &[Value]) -> bool {
    values
        .iter()
        .enumerate()
        .all(|(index, value)| !js::includes(&values[..index], value))
}

/// `verifyCommitmentDelegation(event, trust, at)`: the delegation's scope, or
/// `None`. A missing revocation is not proof of its absence.
pub fn verify_commitment_delegation(event: Option<&Value>, trust: &Trust, at_ms: i64) -> Option<Map<String, Value>> {
    let now = seconds(at_ms);
    let stream = trust.stream_event;
    let event = event.filter(|event| js::truthy(event))?;
    if !valid_stream_authorisation(stream)
        || !bounded(event)
        || !kind_is(event, KIND_COMMITMENT_DELEGATION)
        || !field_eq(event, "pubkey", &stream["pubkey"])
        || !verify_event(event)
        || single_tag(event, "x") != Some(trust.swarm_id)
        || single_tag(event, "e") != stream["id"].as_str()
    {
        return None;
    }
    let created_at = js::safe_integer(&event["created_at"])?;
    if created_at > now + 30
        || trust.revoked_delegation_ids.len() > 256
        || js::includes(trust.revoked_delegation_ids, &event["id"])
        || trust.delegation_revocations.len() > 256
    {
        return None;
    }
    let value = parse_object(&event["content"])?;
    let renditions = get(&value, "renditions").as_array();
    let media_types = get(&value, "mediaTypes").as_array();
    let not_before = js::safe_integer(get(&value, "notBefore"));
    let expires_at = js::safe_integer(get(&value, "expiresAt"));
    let max_bytes = js::safe_integer(get(&value, "maxSegmentBytes"));
    let accepted = event["content"].as_str() == Some(delegation_content(&value).as_str())
        && get(&value, "domain") == DOMAIN_DELEGATION
        && js::strict_eq(get(&value, "v"), &Value::from(1))
        && js::strict_eq(get(&value, "streamEventId"), &stream["id"])
        && get(&value, "swarmId").as_str() == Some(trust.swarm_id)
        && is_hex64(&js::to_string(get(&value, "delegatePubkey")))
        && not_before.is_some_and(|nb| nb >= created_at && nb <= now)
        && expires_at.is_some_and(|ex| ex > now && Some(ex) > not_before && ex <= created_at + 3600)
        && renditions.is_some_and(|items| {
            !items.is_empty()
                && items.len() <= 40
                && unique(items)
                && items.iter().all(|entry| safe_path(entry) || numeric_rendition(entry))
        })
        && media_types.is_some_and(|items| {
            !items.is_empty() && items.len() <= 2 && unique(items) && items.iter().all(|entry| entry == "main" || entry == "audio")
        })
        && get(&value, "allowParts").is_boolean()
        && max_bytes.is_some_and(|max| (1..=MAX_SEGMENT_BYTES).contains(&max));
    if !accepted {
        return None;
    }
    for revocation in trust.delegation_revocations {
        // Untrusted or forged revocations cannot revoke an authorisation.
        let Some(revocation_created) = revocation_created_at(revocation, stream) else {
            continue;
        };
        if revocation_created < created_at
            || revocation_created > now + 30
            || !verify_event(revocation)
            || single_tag(revocation, "e") != event["id"].as_str()
            || single_tag(revocation, "x") != Some(trust.swarm_id)
        {
            continue;
        }
        // Content that is not JSON throws inside the JavaScript `try`,
        // which rejects the delegation outright.
        let revoked = match serde_json::from_str::<Value>(revocation["content"].as_str()?) {
            Ok(Value::Object(map)) => map,
            // Reading a property of null throws in JavaScript.
            Ok(Value::Null) => return None,
            Ok(_) => continue,
            Err(_) => return None,
        };
        if revocation["content"].as_str() == Some(revocation_content(&revoked).as_str())
            && get(&revoked, "domain") == DOMAIN_REVOCATION
            && js::strict_eq(get(&revoked, "v"), &Value::from(1))
            && js::strict_eq(get(&revoked, "streamEventId"), &stream["id"])
            && get(&revoked, "swarmId").as_str() == Some(trust.swarm_id)
            && js::strict_eq(get(&revoked, "delegationId"), &event["id"])
        {
            return None;
        }
    }
    Some(value)
}

/// The revocation's `created_at` when its envelope could revoke anything.
fn revocation_created_at(revocation: &Value, stream: &Value) -> Option<i64> {
    if !js::truthy(revocation)
        || !bounded(revocation)
        || !kind_is(revocation, KIND_COMMITMENT_REVOCATION)
        || !field_eq(revocation, "pubkey", &stream["pubkey"])
    {
        return None;
    }
    js::safe_integer(revocation.get("created_at")?)
}

fn is_hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `verifySegmentCommitment(event, options, at)`: the commitment content, or
/// `None`. The caller still checks received bytes against `sha256` and `size`.
pub fn verify_segment_commitment(
    event: &Value,
    trust: &Trust,
    key: &str,
    context: &FragmentContext,
    max_segment_bytes: &Value,
    delegation: Option<&Value>,
    at_ms: i64,
) -> Option<Map<String, Value>> {
    let now = seconds(at_ms);
    let stream = trust.stream_event;
    let limit = js::safe_integer(max_segment_bytes).filter(|max| (1..=MAX_SEGMENT_BYTES).contains(max))?;
    if !valid_stream_authorisation(stream) || !js::truthy(event) || !kind_is(event, KIND_SEGMENT_COMMITMENT) || !bounded(event) {
        return None;
    }
    let created_at = js::safe_integer(event.get("created_at")?)?;
    if created_at > now + 30
        || created_at < now - 120
        || !verify_event(event)
        || single_tag(event, "x") != Some(trust.swarm_id)
        || single_tag(event, "e") != stream["id"].as_str()
    {
        return None;
    }
    let value = parse_object(&event["content"])?;
    let wide = js::strict_eq(get(&value, "v"), &Value::from(2));
    let sequence = js::safe_integer(get(&value, "sequence"));
    let discontinuity = js::safe_integer(get(&value, "discontinuity"));
    let part = get(&value, "part");
    let size = js::safe_integer(get(&value, "size"));
    let expires_at = js::safe_integer(get(&value, "expiresAt"));
    let accepted = event["content"].as_str() == Some(commitment_content(&value).as_str())
        && get(&value, "domain") == if wide { DOMAIN_V2 } else { DOMAIN_V1 }
        && js::includes(&[Value::from(1), Value::from(2)], get(&value, "v"))
        && js::strict_eq(get(&value, "streamEventId"), &stream["id"])
        && get(&value, "swarmId").as_str() == Some(trust.swarm_id)
        && get(&value, "key").as_str() == Some(key)
        && js::strict_eq(get(&value, "sequence"), &context.sequence)
        && js::strict_eq(get(&value, "discontinuity"), &context.discontinuity)
        && js::strict_eq(part, &context.part)
        && sequence.is_some_and(|n| n >= 0)
        && discontinuity.is_some_and(|n| n >= 0)
        && (part.is_null() || js::safe_integer(part).is_some_and(|n| n >= 0))
        && is_hex64(&js::to_string(get(&value, "sha256")))
        && size.is_some_and(|n| n >= 1 && n <= limit)
        && expires_at.is_some_and(|ex| ex > now && ex <= now + 300);
    if !accepted {
        return None;
    }
    if wide {
        let expected = context.media.as_ref()?;
        let playlist = expected.get("playlist").unwrap_or(&Value::Null);
        let media_type = expected.get("mediaType").unwrap_or(&Value::Null);
        let encryption = expected.get("encryption").unwrap_or(&Value::Null);
        // JSON.stringify(undefined) is undefined, which never equals a string.
        let value_encryption = value.get("encryption").map(js::stringify);
        if !js::strict_eq(get(&value, "rendition"), playlist)
            || !js::strict_eq(get(&value, "playlist"), playlist)
            || !js::strict_eq(get(&value, "mediaType"), media_type)
            || value_encryption != Some(js::stringify(encryption))
        {
            return None;
        }
    } else if !js::strict_eq(get(&value, "rendition"), &Value::from(context.level.clone()))
        || (js::truthy(&context.frag_type) && !js::strict_eq(&context.frag_type, &Value::from("main")))
        || (js::truthy(&context.decrypt_method) && !js::strict_eq(&context.decrypt_method, &Value::from("NONE")))
    {
        return None;
    }
    if !field_eq(event, "pubkey", &stream["pubkey"]) {
        let scope = verify_commitment_delegation(delegation, trust, at_ms)?;
        let delegation = delegation?;
        let media_type = if wide {
            get(&value, "mediaType").clone()
        } else {
            Value::from("main")
        };
        // The scope's fields were validated by verify_commitment_delegation.
        let scope_int = |name: &str| js::safe_integer(get(&scope, name)).unwrap_or(i64::MIN);
        let scope_list = |name: &str| get(&scope, name).as_array().map(Vec::as_slice).unwrap_or(&[]);
        let in_scope = field_eq(event, "pubkey", get(&scope, "delegatePubkey"))
            && single_tag(event, "delegation").is_some_and(|id| js::strict_eq(&Value::from(id), &delegation["id"]))
            && created_at >= scope_int("notBefore")
            && expires_at.is_some_and(|ex| ex <= scope_int("expiresAt"))
            && js::includes(scope_list("renditions"), get(&value, "rendition"))
            && js::includes(scope_list("mediaTypes"), &media_type)
            && (part.is_null() || get(&scope, "allowParts") == &Value::Bool(true))
            && size.is_some_and(|n| n <= scope_int("maxSegmentBytes"));
        if !in_scope {
            return None;
        }
    }
    Some(value)
}
