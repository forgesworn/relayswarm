//! Nostr event checks with the same outcomes as `nostr-tools` 2.24.1
//! `verifyEvent` (`validateEvent`, NIP-01 hash, BIP-340 signature).

use k256::schnorr::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::js;

/// The first 64 characters are lowercase hex (`isHex32`; longer strings pass
/// here and fail at signature verification).
fn is_hex32(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 64 && bytes[..64].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

/// `validateEvent`.
pub fn valid_shape(event: &Value) -> bool {
    let Some(object) = event.as_object() else { return false };
    object.get("kind").is_some_and(Value::is_number)
        && object.get("content").is_some_and(Value::is_string)
        && object.get("created_at").is_some_and(Value::is_number)
        && object.get("pubkey").and_then(Value::as_str).is_some_and(is_hex32)
        && object.get("tags").and_then(Value::as_array).is_some_and(|tags| {
            tags.iter()
                .all(|tag| tag.as_array().is_some_and(|items| items.iter().all(Value::is_string)))
        })
}

/// NIP-01 event ID: SHA-256 of `JSON.stringify([0, pubkey, created_at, kind, tags, content])`.
pub fn event_hash(event: &Value) -> Option<[u8; 32]> {
    if !valid_shape(event) {
        return None;
    }
    let serialised = js::stringify(&json!([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ]));
    Some(Sha256::digest(serialised.as_bytes()).into())
}

/// `verifyEvent`: shape, exact lowercase ID and BIP-340 signature. Never panics.
pub fn verify_event(event: &Value) -> bool {
    let Some(hash) = event_hash(event) else { return false };
    if event.get("id").and_then(Value::as_str) != Some(hex::encode(hash).as_str()) {
        return false;
    }
    let (Some(signature), Some(pubkey)) = (event.get("sig").and_then(Value::as_str), event["pubkey"].as_str()) else {
        return false;
    };
    let (Ok(signature), Ok(pubkey)) = (hex::decode(signature), hex::decode(pubkey)) else {
        return false;
    };
    let (Ok(signature), Ok(key)) = (Signature::try_from(signature.as_slice()), VerifyingKey::from_bytes(&pubkey)) else {
        return false;
    };
    key.verify_raw(&hash, &signature).is_ok()
}

/// The value of exactly one two-element tag with this name, as `tag()` in
/// `segment-commitment.mjs`. Call only on a shape-valid event.
pub fn single_tag<'a>(event: &'a Value, name: &str) -> Option<&'a str> {
    let tags = event.get("tags")?.as_array()?;
    let mut matches = tags.iter().filter(|tag| tag.get(0).and_then(Value::as_str) == Some(name));
    let only = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let items = only.as_array()?;
    (items.len() == 2).then(|| items[1].as_str()).flatten()
}

/// `JSON.stringify(event)` is at most 16 KiB of UTF-8.
pub fn bounded(event: &Value) -> bool {
    js::stringify(event).len() <= 16 * 1024
}

/// Strict equality of a field against a value, absent fields never equal.
pub fn field_eq(event: &Value, name: &str, other: &Value) -> bool {
    event.get(name).is_some_and(|value| js::strict_eq(value, other))
}
