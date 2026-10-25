//! Nostr event checks with the same outcomes as `nostr-tools` 2.24.1
//! `verifyEvent` (`validateEvent`, NIP-01 hash, BIP-340 signature).

use std::cell::RefCell;

use k256::schnorr::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::js;

/// Signatures already proved, as event hash, public key and signature bytes.
const PROVED_CAPACITY: usize = 512;

thread_local! {
    /// The stream event, a delegation and its revocations are checked again
    /// for every segment. The hash is recomputed on every call, so a changed
    /// field is a different entry. Least recently used entries go first; a
    /// linear scan of at most this many costs microseconds against a check.
    static PROVED: RefCell<Vec<[u8; 128]>> = const { RefCell::new(Vec::new()) };
}

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
    // Only exact lengths can verify, and only those are remembered.
    let (Ok(signature_bytes), Ok(pubkey_bytes)) = (<[u8; 64]>::try_from(signature.as_slice()), <[u8; 32]>::try_from(pubkey.as_slice()))
    else {
        return false;
    };
    let mut proof = [0u8; 128];
    proof[..32].copy_from_slice(&hash);
    proof[32..64].copy_from_slice(&pubkey_bytes);
    proof[64..].copy_from_slice(&signature_bytes);
    let remembered = PROVED.with(|cell| {
        let mut proved = cell.borrow_mut();
        let Some(index) = proved.iter().position(|entry| *entry == proof) else {
            return false;
        };
        let entry = proved.remove(index);
        proved.push(entry);
        true
    });
    if remembered {
        return true;
    }
    let (Ok(signature), Ok(key)) = (Signature::try_from(signature.as_slice()), VerifyingKey::from_bytes(&pubkey)) else {
        return false;
    };
    if key.verify_raw(&hash, &signature).is_err() {
        return false;
    }
    PROVED.with(|cell| {
        let mut proved = cell.borrow_mut();
        if proved.len() >= PROVED_CAPACITY {
            proved.remove(0);
        }
        proved.push(proof);
    });
    true
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

#[cfg(test)]
mod tests {
    use super::*;

    fn stream_event() -> Value {
        let vectors: Value = serde_json::from_str(include_str!("../../vectors/commitments.json")).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        let case = cases
            .iter()
            .find(|case| case["op"] == "stream" && case["expected"] == Value::Bool(true))
            .unwrap();
        case["event"].clone()
    }

    #[test]
    fn a_remembered_verdict_never_accepts_a_changed_event() {
        let event = stream_event();
        assert!(verify_event(&event));
        assert!(verify_event(&event));
        let changed = |name: &str, value: Value| {
            let mut copy = event.clone();
            copy[name] = value;
            verify_event(&copy)
        };
        let sig = event["sig"].as_str().unwrap();
        let flipped = format!("{}{}", &sig[..127], if sig.ends_with('0') { '1' } else { '0' });
        assert!(!changed("sig", Value::from(flipped)));
        assert!(!changed("sig", Value::from(vec![sig])));
        assert!(!changed("content", Value::from(format!("{} ", event["content"].as_str().unwrap()))));
        assert!(!changed("created_at", Value::from(event["created_at"].as_i64().unwrap() + 1)));
        assert!(!changed("id", Value::from(event["id"].as_str().unwrap().to_uppercase())));
        assert!(verify_event(&event));
    }
}
