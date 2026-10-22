//! JavaScript value semantics the verifiers depend on.
//!
//! The JavaScript verifier compares signed content against `JSON.stringify`
//! output, uses strict equality and `Number.isSafeInteger`, and coerces values
//! to strings in one regex check. These helpers reproduce those rules over
//! `serde_json` values parsed with `preserve_order` and `float_roundtrip`.

use serde_json::{Map, Value};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Number.isSafeInteger`.
pub fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number as i64)
}

/// Strict equality (`===`) for the value kinds that reach a comparison.
/// Objects and arrays compare by reference in JavaScript, so two parsed
/// values are never equal.
pub fn strict_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

/// `Array.prototype.includes` (SameValueZero), which matches `strict_eq` for
/// the values parsed from JSON.
pub fn includes(values: &[Value], needle: &Value) -> bool {
    values.iter().any(|value| strict_eq(value, needle))
}

/// JavaScript truthiness.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` for values parsed from JSON.
pub fn to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { to_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number.prototype.toString()` for a finite double (ECMA-262 Number::toString).
pub fn number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".into();
    }
    if number == 0.0 {
        return "0".into();
    }
    if number.is_infinite() {
        return if number > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if number < 0.0 {
        return format!("-{}", number_to_string(-number));
    }
    // ryu yields the shortest round-tripping digits, as ECMA-262 requires;
    // only the layout differs, so re-lay the digits out by the spec's rules.
    let mut buffer = ryu::Buffer::new();
    let printed = buffer.format_finite(number);
    let (mantissa, exponent) = match printed.split_once('e') {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().unwrap_or(0)),
        None => (printed, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits: String = format!("{whole}{fraction}");
    let mut point = whole.len() as i32;
    let leading = digits.len() - digits.trim_start_matches('0').len();
    digits.drain(..leading);
    point -= leading as i32;
    let trimmed = digits.trim_end_matches('0').len();
    digits.truncate(trimmed);
    let k = digits.len() as i32;
    let n = point + exponent;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

/// `JSON.stringify` for a value parsed from JSON.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// `JSON.stringify` of an object built from the given fields in order, as an
/// object literal `{ a: x, b: y }` would serialise.
pub fn stringify_fields(fields: &[(&str, &Value)]) -> String {
    let mut out = String::from("{");
    for (index, (name, value)) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(&mut out, name);
        out.push(':');
        write_value(&mut out, value);
    }
    out.push('}');
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or(f64::NAN);
            if number.is_finite() {
                out.push_str(&number_to_string(number));
            } else {
                out.push_str("null");
            }
        }
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => write_object(out, map),
    }
}

/// Integer-like keys enumerate first in ascending order, then the rest in
/// insertion order, as JavaScript orders own property keys.
fn write_object(out: &mut String, map: &Map<String, Value>) {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::new();
    for (key, value) in map {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    out.push('{');
    let entries = indexed.into_iter().map(|(_, key, value)| (key, value)).chain(named);
    for (position, (key, value)) in entries.enumerate() {
        if position > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_value(out, value);
    }
    out.push('}');
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_follow_ecma_layout() {
        for (number, text) in [
            (1.0, "1"),
            (1.5, "1.5"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (123.456, "123.456"),
            (-0.0, "0"),
            (9_007_199_254_740_993.0, "9007199254740992"),
            (1.2345e-10, "1.2345e-10"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(number_to_string(number), text, "{number}");
        }
    }

    #[test]
    fn integral_floats_and_large_integers_stringify_as_javascript_does() {
        let parsed: Value = serde_json::from_str(r#"[1.0, 1e3, -0, 9007199254740993, 0.1]"#).unwrap();
        assert_eq!(stringify(&parsed), "[1,1000,0,9007199254740992,0.1]");
    }

    #[test]
    fn object_keys_enumerate_like_javascript() {
        let parsed: Value = serde_json::from_str(r#"{"b":1,"2":2,"a":3,"1":4,"01":5}"#).unwrap();
        assert_eq!(stringify(&parsed), r#"{"1":4,"2":2,"b":1,"a":3,"01":5}"#);
    }

    #[test]
    fn duplicate_keys_keep_first_position_and_last_value() {
        let parsed: Value = serde_json::from_str(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(stringify(&parsed), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn strings_escape_like_json_stringify() {
        let parsed = json!("q\"\\\u{08}\u{0c}\n\r\t\u{01}\u{1f}\u{7f}\u{2028}é");
        assert_eq!(stringify(&parsed), "\"q\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\u{2028}é\"");
    }

    #[test]
    fn safe_integers_accept_integral_floats_only() {
        assert_eq!(safe_integer(&json!(1.0)), Some(1));
        assert_eq!(safe_integer(&json!(1.5)), None);
        assert_eq!(safe_integer(&json!(9_007_199_254_740_992u64)), None);
        assert_eq!(safe_integer(&json!("1")), None);
    }
}
