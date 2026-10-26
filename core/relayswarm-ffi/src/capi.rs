use crate::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;
use std::sync::Arc;

#[repr(C)]
pub struct RsBuffer {
    pub ptr: *mut u8,
    pub len: usize,
}

#[repr(C)]
pub struct RsBufferList {
    pub ptr: *const RsBuffer,
    pub len: usize,
}

#[repr(C)]
pub struct RsPackedStrings {
    pub ptr: *const u8,
    pub len: usize,
    pub lengths: *const usize,
    pub count: usize,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct RsTransferSource {
    pub peer: u64,
    pub tag: u8,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct RsTiming {
    pub first_byte_ms: f64,
    pub rate: f64,
    pub first_byte_present: bool,
    pub rate_present: bool,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct RsPeerTiming {
    pub peer: u64,
    pub timing: RsTiming,
}

enum Handle {
    Transfer(Arc<Transfer>),
    PeerLink(Arc<PeerLink>),
    PeerSelection(Arc<PeerSelection>),
    NeighbourDiscovery(Arc<NeighbourDiscovery>),
}

#[derive(Debug)]
enum CapiError {
    Argument,
    InvalidTransfer,
    Panic,
}

type CapiResult<T> = Result<T, CapiError>;

impl From<CoreError> for CapiError {
    fn from(_: CoreError) -> Self {
        CapiError::InvalidTransfer
    }
}

fn owned(bytes: Vec<u8>) -> RsBuffer {
    let mut bytes = bytes.into_boxed_slice();
    let out = RsBuffer {
        ptr: bytes.as_mut_ptr(),
        len: bytes.len(),
    };
    std::mem::forget(bytes);
    out
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> CapiResult<&'a [u8]> {
    if ptr.is_null() {
        if len == 0 {
            Ok(&[])
        } else {
            Err(CapiError::Argument)
        }
    } else {
        Ok(slice::from_raw_parts(ptr, len))
    }
}

unsafe fn text(ptr: *const u8, len: usize) -> CapiResult<String> {
    std::str::from_utf8(bytes(ptr, len)?)
        .map(str::to_owned)
        .map_err(|_| CapiError::Argument)
}

fn argument<T>() -> CapiResult<T> {
    Err(CapiError::Argument)
}

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> CapiResult<T> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null)).map_err(|_| CapiError::Argument)
}

fn float_value(value: &Value) -> CapiResult<f64> {
    match value {
        Value::Number(value) => value.as_f64().ok_or(CapiError::Argument),
        Value::String(value) if value == "Infinity" => Ok(f64::INFINITY),
        Value::String(value) if value == "-Infinity" => Ok(f64::NEG_INFINITY),
        Value::String(value) if value == "NaN" => Ok(f64::NAN),
        Value::String(value) => value.parse().map_err(|_| CapiError::Argument),
        _ => argument(),
    }
}

fn float(args: &Value, name: &str) -> CapiResult<f64> {
    float_value(args.get(name).unwrap_or(&Value::Null))
}

fn optional_float(value: &Value) -> CapiResult<Option<f64>> {
    if value.is_null() {
        Ok(None)
    } else {
        float_value(value).map(Some)
    }
}

fn timing(value: &Value) -> CapiResult<Timing> {
    Ok(Timing {
        first_byte_ms: optional_float(value.get("first_byte_ms").unwrap_or(&Value::Null))?,
        rate: optional_float(value.get("rate").unwrap_or(&Value::Null))?,
    })
}

fn transfer_settings(value: &Value) -> CapiResult<TransferSettings> {
    Ok(TransferSettings {
        max_holders: arg(value, "max_holders")?,
        origin_reserve_ms: float(value, "origin_reserve_ms")?,
    })
}

fn peer_timing(value: &Value) -> CapiResult<PeerTiming> {
    Ok(PeerTiming {
        peer: arg(value, "peer")?,
        timing: timing(value.get("timing").unwrap_or(&Value::Null))?,
    })
}

fn player_supply(value: &Value) -> CapiResult<PlayerSupply> {
    Ok(PlayerSupply {
        rendition: arg(value, "rendition")?,
        size: arg(value, "size")?,
        peers: value
            .get("peers")
            .and_then(Value::as_array)
            .ok_or(CapiError::Argument)?
            .iter()
            .map(peer_timing)
            .collect::<CapiResult<_>>()?,
        origin: match value.get("origin") {
            None | Some(Value::Null) => None,
            Some(value) => Some(timing(value)?),
        },
        shared: timing(value.get("shared").unwrap_or(&Value::Null))?,
        available_ms: float(value, "available_ms")?,
        max_holders: arg(value, "max_holders")?,
    })
}

fn float_json(value: f64) -> Value {
    Value::String(if value.is_nan() {
        "NaN".into()
    } else if value == f64::INFINITY {
        "Infinity".into()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        value.to_string()
    })
}

fn stringify_floats(value: &mut Value) {
    match value {
        Value::Number(number) if number.is_f64() => *value = Value::String(number.to_string()),
        Value::Array(values) => values.iter_mut().for_each(stringify_floats),
        Value::Object(values) => values.values_mut().for_each(stringify_floats),
        _ => {}
    }
}

fn output<T: serde::Serialize>(value: T) -> CapiResult<Value> {
    let mut value = serde_json::to_value(value).map_err(|_| CapiError::Argument)?;
    stringify_floats(&mut value);
    Ok(value)
}

fn call(name: &str, args: Value) -> CapiResult<Value> {
    match name {
        "valid_stream_authorisation" => output(valid_stream_authorisation(arg(&args, "event_json")?)),
        "verify_commitment_delegation" => output(verify_commitment_delegation(
            arg(&args, "event_json")?,
            arg(&args, "options_json")?,
            arg(&args, "at_ms")?,
        )),
        "verify_segment_commitment" => output(verify_segment_commitment(
            arg(&args, "event_json")?,
            arg(&args, "options_json")?,
            arg(&args, "at_ms")?,
        )),
        "commitment_piece_size" => output(commitment_piece_size(arg(&args, "size")?)),
        "piece_count" => output(piece_count(arg(&args, "size")?)),
        "piece_span_bytes" => output(piece_span_bytes(arg(&args, "size")?, arg(&args, "span")?)),
        "default_transfer_settings" => output(default_transfer_settings()),
        "link_limits" => output(link_limits()),
        "player_hint" => output(player_hint(player_supply(args.get("supply").unwrap_or(&Value::Null))?)),
        _ => argument(),
    }
}

fn constructor(name: &str, args: Value) -> CapiResult<Handle> {
    match name {
        "transfer" => Ok(Handle::Transfer(Transfer::new(
            transfer_settings(args.get("settings").unwrap_or(&Value::Null))?,
            arg(&args, "size")?,
            arg(&args, "sha256")?,
            arg(&args, "pieces")?,
            arg(&args, "deadline")?,
        )?)),
        "peer_link" => Ok(Handle::PeerLink(PeerLink::new(arg(&args, "settings")?, arg(&args, "now")?))),
        "peer_selection" => Ok(Handle::PeerSelection(PeerSelection::new())),
        "neighbour_discovery" => Ok(Handle::NeighbourDiscovery(NeighbourDiscovery::new())),
        _ => argument(),
    }
}

fn transfer_method(value: &Transfer, name: &str, args: Value) -> CapiResult<Value> {
    match name {
        "start" => output(
            value.start(
                arg(&args, "now")?,
                args.get("peers")
                    .and_then(Value::as_array)
                    .ok_or(CapiError::Argument)?
                    .iter()
                    .map(peer_timing)
                    .collect::<CapiResult<_>>()?,
                timing(args.get("origin").unwrap_or(&Value::Null))?,
                timing(args.get("shared").unwrap_or(&Value::Null))?,
            ),
        ),
        "progress" => output(value.progress(arg(&args, "now")?, arg(&args, "source")?, arg(&args, "received")?)),
        "delivered" => output(value.delivered(arg(&args, "now")?, arg(&args, "source")?, arg(&args, "span")?, arg(&args, "bytes")?)),
        "failed" => output(value.failed(arg(&args, "now")?, arg(&args, "source")?)),
        "tick" => output(value.tick(arg(&args, "now")?)),
        _ => argument(),
    }
}

fn peer_link_method(value: &PeerLink, name: &str, args: Value) -> CapiResult<Value> {
    match name {
        "set_channel_open" => {
            value.set_channel_open(arg(&args, "open")?);
            Ok(Value::Null)
        }
        "set_reliable" => {
            value.set_reliable(arg(&args, "reliable")?);
            Ok(Value::Null)
        }
        "observe_buffered" => {
            value.observe_buffered(arg(&args, "buffered")?);
            Ok(Value::Null)
        }
        "sets" => output(value.sets()),
        "state" => output(value.state()),
        "handle_text" => output(value.handle_text(arg(&args, "now")?, arg(&args, "text")?)),
        "handle_binary" => output(value.handle_binary(arg(&args, "now")?, arg(&args, "chunk")?)),
        "request" => output(value.request(
            arg(&args, "now")?,
            arg(&args, "key")?,
            arg(&args, "timeout_ms")?,
            arg(&args, "expected_size")?,
        )),
        "request_range" => output(value.request_range(
            arg(&args, "now")?,
            arg(&args, "key")?,
            arg(&args, "timeout_ms")?,
            arg(&args, "span")?,
            arg(&args, "object_size")?,
        )),
        "abort" => output(value.abort(arg(&args, "now")?, arg(&args, "id")?, arg(&args, "abandoned")?)),
        "close_link" => output(value.close_link(arg(&args, "reason")?)),
        "tick" => output(value.tick(arg(&args, "now")?)),
        "serve_response" => output(value.serve_response(arg(&args, "now")?, arg(&args, "bytes")?)),
        "buffered_amount_low" => output(value.buffered_amount_low(arg(&args, "now")?, arg(&args, "buffered")?)),
        "send_have" => output(value.send_have(arg(&args, "keys")?)),
        "send_have_change" => output(value.send_have_change(arg(&args, "add")?, arg(&args, "del")?)),
        "send_contribution" => output(value.send_contribution(arg(&args, "serving")?, arg(&args, "rendition")?)),
        "send_fetching" => output(value.send_fetching(arg(&args, "key")?, arg(&args, "lease_ms")?)),
        _ => argument(),
    }
}

fn peer_selection_method(value: &PeerSelection, name: &str, args: Value) -> CapiResult<Value> {
    match name {
        "observe" => {
            value.observe(
                arg(&args, "now")?,
                optional_float(args.get("first_byte_ms").unwrap_or(&Value::Null))?,
                float(&args, "bytes")?,
                float(&args, "flow_ms")?,
                optional_float(args.get("total_flow_ms").unwrap_or(&Value::Null))?,
            );
            Ok(Value::Null)
        }
        "record" => {
            value.record(
                arg(&args, "now")?,
                arg(&args, "link")?,
                float(&args, "elapsed_ms")?,
                float(&args, "bytes")?,
            );
            Ok(Value::Null)
        }
        "mark_selected" => {
            value.mark_selected(arg(&args, "link")?);
            Ok(Value::Null)
        }
        "forget" => {
            value.forget(arg(&args, "link")?);
            Ok(Value::Null)
        }
        "select" => output(value.select(
            arg(&args, "links")?,
            arg(&args, "tried")?,
            float(&args, "size")?,
            float(&args, "deadline_ms")?,
        )),
        "first_byte_ms" => Ok(value.first_byte_ms().map(float_json).unwrap_or(Value::Null)),
        "rate" => Ok(value.rate().map(float_json).unwrap_or(Value::Null)),
        "project_ms" => Ok(value.project_ms(float(&args, "size")?).map(float_json).unwrap_or(Value::Null)),
        "minimum_ms" => Ok(float_json(value.minimum_ms(float(&args, "size")?))),
        "last_observed_at" => output(value.last_observed_at()),
        "turn" => output(value.turn()),
        "order" => output(value.order()),
        "summary" => output(value.summary(arg(&args, "link")?)),
        "estimate" => Ok(value
            .estimate(arg(&args, "link")?, float(&args, "size")?)
            .map(float_json)
            .unwrap_or(Value::Null)),
        _ => argument(),
    }
}

fn discovery_method(value: &NeighbourDiscovery, name: &str, args: Value) -> CapiResult<Value> {
    match name {
        "context" => output(value.context(arg(&args, "now")?, arg(&args, "media_type")?, arg(&args, "rendition")?)),
        "demand" => output(value.demand(
            arg(&args, "now")?,
            arg(&args, "media_type")?,
            arg(&args, "rendition")?,
            arg(&args, "key")?,
        )),
        "hint" => {
            value.hint(
                arg(&args, "now")?,
                arg(&args, "pubkey")?,
                arg(&args, "have")?,
                arg(&args, "ticket")?,
            );
            Ok(Value::Null)
        }
        "holder_miss" => {
            value.holder_miss(
                arg(&args, "now")?,
                arg(&args, "context")?,
                arg(&args, "pubkey")?,
                arg(&args, "key")?,
            );
            Ok(Value::Null)
        }
        "holder_ahead" => {
            value.holder_ahead(arg(&args, "context")?, arg(&args, "pubkey")?);
            Ok(Value::Null)
        }
        "rearm" => output(value.rearm(arg(&args, "now")?, arg(&args, "context")?, arg(&args, "all_stale")?)),
        "stale" => output(value.stale(arg(&args, "now")?, arg(&args, "context")?, arg(&args, "pubkey")?)),
        "forget" => {
            value.forget(arg(&args, "pubkey")?);
            Ok(Value::Null)
        }
        "current" => output(value.current(arg(&args, "now")?, arg(&args, "context")?)),
        "choose" => output(value.choose(
            arg(&args, "now")?,
            arg(&args, "eligible")?,
            arg(&args, "unmet")?,
            arg(&args, "room")?,
        )),
        "hinted" => output(value.hinted(arg(&args, "now")?, arg(&args, "context")?, arg(&args, "eligible")?)),
        "begin" => output(value.begin(arg(&args, "now")?)),
        "valid" => output(value.valid(arg(&args, "now")?, arg(&args, "attempt")?)),
        "replaced" => output(value.replaced(arg(&args, "now")?, arg(&args, "attempt")?, arg(&args, "victim")?)),
        "allocated" => {
            value.allocated(arg(&args, "attempt")?, arg(&args, "dial")?);
            Ok(Value::Null)
        }
        "abandoned" => {
            value.abandoned(arg(&args, "attempt")?);
            Ok(Value::Null)
        }
        "failed" => {
            value.failed(arg(&args, "dial")?);
            Ok(Value::Null)
        }
        "end" => output(value.end()),
        "verified" => output(value.verified(arg(&args, "context")?)),
        "live" => output(value.live(arg(&args, "now")?)),
        "reserved" => output(value.reserved(arg(&args, "now")?)),
        "suppresses" => output(value.suppresses(arg(&args, "now")?, arg(&args, "pubkey")?)),
        "contexts" => output(value.contexts()),
        "candidates" => output(value.candidates()),
        "window" => output(value.window()),
        "snapshot" => output(value.snapshot(arg(&args, "now")?)),
        "clear" => {
            value.clear();
            Ok(Value::Null)
        }
        _ => argument(),
    }
}

fn method(handle: &Handle, name: &str, args: Value) -> CapiResult<Value> {
    match handle {
        Handle::Transfer(value) => transfer_method(value, name, args),
        Handle::PeerLink(value) => peer_link_method(value, name, args),
        Handle::PeerSelection(value) => peer_selection_method(value, name, args),
        Handle::NeighbourDiscovery(value) => discovery_method(value, name, args),
    }
}

fn set_error(out: *mut RsBuffer, error: CapiError) {
    if !out.is_null() {
        let code = match error {
            CapiError::Argument => "invalid_argument",
            CapiError::InvalidTransfer => "invalid_transfer",
            CapiError::Panic => "panic",
        };
        unsafe { out.write(owned(code.as_bytes().to_vec())) };
    }
}

unsafe fn write<T>(out: *mut T, error: *mut RsBuffer, call: impl FnOnce() -> CapiResult<T>) -> i32 {
    if out.is_null() {
        set_error(error, CapiError::Argument);
        return 1;
    }
    match catch_unwind(AssertUnwindSafe(call)) {
        Ok(Ok(value)) => {
            out.write(value);
            0
        }
        Ok(Err(error_value)) => {
            set_error(error, error_value);
            1
        }
        Err(_) => {
            set_error(error, CapiError::Panic);
            1
        }
    }
}

unsafe fn object<'a>(value: *const c_void) -> CapiResult<&'a Handle> {
    value.cast::<Handle>().as_ref().ok_or(CapiError::Argument)
}

#[no_mangle]
pub extern "C" fn relayswarm_abi_version() -> u32 {
    3
}

#[no_mangle]
pub extern "C" fn relayswarm_buffer_free(buffer: RsBuffer) {
    if !buffer.ptr.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(buffer.ptr, buffer.len)));
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_call(
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let name = text(name, name_len)?;
        let args = serde_json::from_slice(bytes(args, args_len)?).map_err(|_| CapiError::Argument)?;
        let value = call(&name, args)?;
        Ok(owned(serde_json::to_vec(&value).map_err(|_| CapiError::Argument)?))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_new(
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    out: *mut *mut c_void,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let name = text(name, name_len)?;
        let args = serde_json::from_slice(bytes(args, args_len)?).map_err(|_| CapiError::Argument)?;
        Ok(Arc::into_raw(Arc::new(constructor(&name, args)?)) as *mut c_void)
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_method(
    handle: *const c_void,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let name = text(name, name_len)?;
        let args = serde_json::from_slice(bytes(args, args_len)?).map_err(|_| CapiError::Argument)?;
        let value = method(object(handle)?, &name, args)?;
        Ok(owned(serde_json::to_vec(&value).map_err(|_| CapiError::Argument)?))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_object_free(handle: *mut c_void) {
    if !handle.is_null() {
        drop(Arc::from_raw(handle.cast::<Handle>()));
    }
}

#[derive(Default)]
struct Binary(Vec<u8>);

impl Binary {
    fn u8(&mut self, value: u8) {
        self.0.push(value);
    }
    fn u32(&mut self, value: u32) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn bytes(&mut self, value: &[u8]) {
        self.u64(value.len() as u64);
        self.0.extend_from_slice(value);
    }
    fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }
    fn optional_u64(&mut self, value: Option<u64>) {
        self.u8(value.is_some() as u8);
        if let Some(value) = value {
            self.u64(value);
        }
    }
    fn optional_bytes(&mut self, value: Option<&[u8]>) {
        self.u8(value.is_some() as u8);
        if let Some(value) = value {
            self.bytes(value);
        }
    }
    fn optional_string(&mut self, value: Option<&str>) {
        self.u8(value.is_some() as u8);
        if let Some(value) = value {
            self.string(value);
        }
    }
    fn span(&mut self, value: PieceSpan) {
        self.u32(value.start);
        self.u32(value.end);
    }
    fn transfer_state(&mut self, value: TransferState) {
        self.u32(value.commands.len() as u32);
        for command in value.commands {
            match command {
                TransferCommand::Request { peer, span } => {
                    self.u8(0);
                    self.u64(peer);
                    self.span(span);
                }
                TransferCommand::FetchOrigin { span } => {
                    self.u8(1);
                    self.span(span);
                }
                TransferCommand::Cancel { peer } => {
                    self.u8(2);
                    self.u64(peer);
                }
                TransferCommand::Abandon { peer } => {
                    self.u8(3);
                    self.u64(peer);
                }
                TransferCommand::Ban { peer } => {
                    self.u8(4);
                    self.u64(peer);
                }
                TransferCommand::Deliver { bytes } => {
                    self.u8(5);
                    self.bytes(&bytes);
                }
                TransferCommand::Fail => self.u8(6),
            }
        }
        self.optional_u64(value.next_deadline);
        self.u8(value.late as u8);
        self.u8(value.finished as u8);
        self.u64(value.verified_bytes);
    }
    fn link_update(&mut self, value: LinkUpdate) {
        self.u32(value.events.len() as u32);
        for event in value.events {
            match event {
                PeerLinkEvent::SendText { text } => {
                    self.u8(0);
                    self.string(&text);
                }
                PeerLinkEvent::SendBinary { bytes } => {
                    self.u8(1);
                    self.bytes(&bytes);
                }
                PeerLinkEvent::Closed { reason } => {
                    self.u8(2);
                    self.string(&reason);
                }
                PeerLinkEvent::Report { report } => {
                    self.u8(3);
                    self.optional_u64(report.id);
                    self.u8(match report.outcome {
                        RequestOutcome::Payload => 0,
                        RequestOutcome::None => 1,
                        RequestOutcome::Timeout => 2,
                        RequestOutcome::Abort => 3,
                        RequestOutcome::Abandoned => 4,
                        RequestOutcome::Closed => 5,
                        RequestOutcome::Busy => 6,
                        RequestOutcome::SendError => 7,
                    });
                    self.u64(report.received_bytes);
                    self.u8(report.metadata_received as u8);
                    self.u8(report.draining as u8);
                    self.optional_string(report.close_reason.as_deref());
                }
                PeerLinkEvent::Resolved { id, bytes } => {
                    self.u8(4);
                    self.optional_u64(id);
                    self.optional_bytes(bytes.as_deref());
                }
                PeerLinkEvent::HaveChanged { keys } => {
                    self.u8(5);
                    self.u32(keys.len() as u32);
                    for key in keys {
                        self.string(&key);
                    }
                }
                PeerLinkEvent::ScheduleChanged => self.u8(6),
                PeerLinkEvent::ServeRequest { key } => {
                    self.u8(7);
                    self.string(&key);
                }
                PeerLinkEvent::ServeRange { key, span } => {
                    self.u8(8);
                    self.string(&key);
                    self.span(span);
                }
                PeerLinkEvent::UploadCancelled { bytes } => {
                    self.u8(9);
                    self.u64(bytes);
                }
                PeerLinkEvent::Progress { received, size } => {
                    self.u8(10);
                    self.u64(received);
                    self.u64(size);
                }
            }
        }
        self.optional_u64(value.request_id);
        self.u64(value.version);
        self.u8(value.closed as u8);
        self.u8(value.busy as u8);
        self.u8(value.transferring as u8);
        self.u32(value.outbound_in_flight);
        self.u64(value.bytes_in);
        self.u64(value.bytes_out);
        self.u64(value.opened_at);
        self.u64(value.last_served_at);
        self.u64(value.last_delivered_at);
        self.optional_u64(value.next_deadline);
        self.u8(value.upload_waiting as u8);
    }
}

fn timing_input(value: RsTiming) -> Timing {
    Timing {
        first_byte_ms: value.first_byte_present.then_some(value.first_byte_ms),
        rate: value.rate_present.then_some(value.rate),
    }
}

fn transfer_handle(value: &Handle) -> CapiResult<&Transfer> {
    if let Handle::Transfer(value) = value {
        Ok(value)
    } else {
        argument()
    }
}

fn link_handle(value: &Handle) -> CapiResult<&PeerLink> {
    if let Handle::PeerLink(value) = value {
        Ok(value)
    } else {
        argument()
    }
}

fn link_binary(value: LinkUpdate) -> RsBuffer {
    let mut binary = Binary::default();
    binary.link_update(value);
    owned(binary.0)
}

fn transfer_binary(value: TransferState) -> RsBuffer {
    let mut binary = Binary::default();
    binary.transfer_state(value);
    owned(binary.0)
}

unsafe fn string_list(keys: RsBufferList) -> CapiResult<Vec<String>> {
    let inputs = if keys.ptr.is_null() {
        if keys.len == 0 {
            &[][..]
        } else {
            return argument();
        }
    } else {
        slice::from_raw_parts(keys.ptr, keys.len)
    };
    inputs.iter().map(|key| text(key.ptr, key.len)).collect()
}

unsafe fn packed_strings(keys: RsPackedStrings) -> CapiResult<Vec<String>> {
    let input = bytes(keys.ptr, keys.len)?;
    let lengths = if keys.lengths.is_null() {
        if keys.count == 0 {
            &[][..]
        } else {
            return argument();
        }
    } else {
        slice::from_raw_parts(keys.lengths, keys.count)
    };
    let mut offset = 0usize;
    let mut output = Vec::with_capacity(keys.count);
    for len in lengths {
        let end = offset
            .checked_add(*len)
            .filter(|end| *end <= input.len())
            .ok_or(CapiError::Argument)?;
        output.push(
            std::str::from_utf8(&input[offset..end])
                .map(str::to_owned)
                .map_err(|_| CapiError::Argument)?,
        );
        offset = end;
    }
    if offset != input.len() {
        return argument();
    }
    Ok(output)
}

fn source_input(value: RsTransferSource) -> CapiResult<TransferSource> {
    match value.tag {
        0 => Ok(TransferSource::Peer { peer: value.peer }),
        1 => Ok(TransferSource::Origin),
        _ => argument(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_transfer_start(
    handle: *const c_void,
    now: u64,
    peers: *const RsPeerTiming,
    peers_len: usize,
    origin: RsTiming,
    shared: RsTiming,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let peers = if peers.is_null() {
            if peers_len == 0 {
                &[][..]
            } else {
                return argument();
            }
        } else {
            slice::from_raw_parts(peers, peers_len)
        };
        let peers = peers
            .iter()
            .map(|peer| PeerTiming {
                peer: peer.peer,
                timing: timing_input(peer.timing),
            })
            .collect();
        let state = transfer_handle(object(handle)?)?.start(now, peers, timing_input(origin), timing_input(shared));
        let mut binary = Binary::default();
        binary.transfer_state(state);
        Ok(owned(binary.0))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_handle_text(
    handle: *const c_void,
    now: u64,
    text_ptr: *const u8,
    text_len: usize,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let update = link_handle(object(handle)?)?.handle_text(now, text(text_ptr, text_len)?);
        let mut binary = Binary::default();
        binary.link_update(update);
        Ok(owned(binary.0))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_serve_response(
    handle: *const c_void,
    now: u64,
    bytes_ptr: *const u8,
    bytes_len: usize,
    present: bool,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let input = if present {
            Some(bytes(bytes_ptr, bytes_len)?.to_vec())
        } else {
            None
        };
        let update = link_handle(object(handle)?)?.serve_response(now, input);
        let mut binary = Binary::default();
        binary.link_update(update);
        Ok(owned(binary.0))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_send_have(
    handle: *const c_void,
    keys: RsBufferList,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let inputs = if keys.ptr.is_null() {
            if keys.len == 0 {
                &[][..]
            } else {
                return argument();
            }
        } else {
            slice::from_raw_parts(keys.ptr, keys.len)
        };
        let keys = inputs.iter().map(|key| text(key.ptr, key.len)).collect::<CapiResult<Vec<_>>>()?;
        let update = link_handle(object(handle)?)?.send_have(keys);
        let mut binary = Binary::default();
        binary.link_update(update);
        Ok(owned(binary.0))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_transfer_delivered(
    handle: *const c_void,
    now: u64,
    source: RsTransferSource,
    start: u32,
    end: u32,
    bytes_ptr: *const u8,
    bytes_len: usize,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let span = PieceSpan { start, end };
        let state = transfer_handle(object(handle)?)?.delivered(now, source_input(source)?, span, bytes(bytes_ptr, bytes_len)?.to_vec());
        Ok(transfer_binary(state))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_transfer_progress(
    handle: *const c_void,
    now: u64,
    source: RsTransferSource,
    received: u64,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(transfer_binary(transfer_handle(object(handle)?)?.progress(
            now,
            source_input(source)?,
            received,
        )))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_transfer_failed(
    handle: *const c_void,
    now: u64,
    source: RsTransferSource,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(transfer_binary(
            transfer_handle(object(handle)?)?.failed(now, source_input(source)?),
        ))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_transfer_tick(handle: *const c_void, now: u64, out: *mut RsBuffer, error: *mut RsBuffer) -> i32 {
    write(out, error, || Ok(transfer_binary(transfer_handle(object(handle)?)?.tick(now))))
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_send_have_packed(
    handle: *const c_void,
    keys: RsPackedStrings,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(link_binary(link_handle(object(handle)?)?.send_have(packed_strings(keys)?)))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_state(handle: *const c_void, out: *mut RsBuffer, error: *mut RsBuffer) -> i32 {
    write(out, error, || Ok(link_binary(link_handle(object(handle)?)?.state())))
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_handle_binary(
    handle: *const c_void,
    now: u64,
    chunk: *const u8,
    chunk_len: usize,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(link_binary(
            link_handle(object(handle)?)?.handle_binary(now, bytes(chunk, chunk_len)?.to_vec()),
        ))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_request(
    handle: *const c_void,
    now: u64,
    key: *const u8,
    key_len: usize,
    timeout_ms: u64,
    expected_size: u64,
    expected_size_present: bool,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let expected = expected_size_present.then_some(expected_size);
        Ok(link_binary(link_handle(object(handle)?)?.request(
            now,
            text(key, key_len)?,
            timeout_ms,
            expected,
        )))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_request_range(
    handle: *const c_void,
    now: u64,
    key: *const u8,
    key_len: usize,
    timeout_ms: u64,
    start: u32,
    end: u32,
    object_size: u64,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let span = PieceSpan { start, end };
        Ok(link_binary(link_handle(object(handle)?)?.request_range(
            now,
            text(key, key_len)?,
            timeout_ms,
            span,
            object_size,
        )))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_tick(handle: *const c_void, now: u64, out: *mut RsBuffer, error: *mut RsBuffer) -> i32 {
    write(out, error, || Ok(link_binary(link_handle(object(handle)?)?.tick(now))))
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_buffered_amount_low(
    handle: *const c_void,
    now: u64,
    buffered: u64,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(link_binary(link_handle(object(handle)?)?.buffered_amount_low(now, buffered)))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_abort(
    handle: *const c_void,
    now: u64,
    id: u64,
    abandoned: bool,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(link_binary(link_handle(object(handle)?)?.abort(now, id, abandoned)))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_close_link(
    handle: *const c_void,
    reason: *const u8,
    reason_len: usize,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(link_binary(link_handle(object(handle)?)?.close_link(text(reason, reason_len)?)))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_send_have_change(
    handle: *const c_void,
    add: RsBufferList,
    del: RsBufferList,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(link_binary(
            link_handle(object(handle)?)?.send_have_change(string_list(add)?, string_list(del)?),
        ))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_send_contribution(
    handle: *const c_void,
    serving: bool,
    rendition: *const u8,
    rendition_len: usize,
    rendition_present: bool,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        let rendition = if rendition_present {
            Some(text(rendition, rendition_len)?)
        } else {
            None
        };
        Ok(link_binary(link_handle(object(handle)?)?.send_contribution(serving, rendition)))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_link_send_fetching(
    handle: *const c_void,
    key: *const u8,
    key_len: usize,
    lease_ms: u64,
    out: *mut RsBuffer,
    error: *mut RsBuffer,
) -> i32 {
    write(out, error, || {
        Ok(link_binary(
            link_handle(object(handle)?)?.send_fetching(text(key, key_len)?, lease_ms),
        ))
    })
}

#[no_mangle]
pub unsafe extern "C" fn relayswarm_peer_selection_order(handle: *const c_void, out: *mut u64, error: *mut RsBuffer) -> i32 {
    write(out, error, || {
        if let Handle::PeerSelection(value) = object(handle)? {
            Ok(value.order())
        } else {
            argument()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_abi_is_versioned() {
        assert_eq!(relayswarm_abi_version(), 3);
    }

    #[test]
    fn invalid_utf8_is_a_per_call_error() {
        let name = [0xff];
        let args = b"{}";
        let mut out = RsBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        };
        let mut error = RsBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        };
        let status = unsafe { relayswarm_call(name.as_ptr(), name.len(), args.as_ptr(), args.len(), &mut out, &mut error) };
        assert_eq!(status, 1);
        assert_eq!(unsafe { slice::from_raw_parts(error.ptr, error.len) }, b"invalid_argument");
        relayswarm_buffer_free(error);
    }

    #[test]
    fn panics_do_not_cross_the_c_boundary() {
        let mut out = RsBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        };
        let mut error = RsBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        };
        let status = unsafe { write(&mut out, &mut error, || -> CapiResult<RsBuffer> { panic!("contained") }) };
        assert_eq!(status, 1);
        assert_eq!(unsafe { slice::from_raw_parts(error.ptr, error.len) }, b"panic");
        relayswarm_buffer_free(error);
    }

    #[test]
    fn empty_and_unicode_buffers_have_defined_ownership() {
        relayswarm_buffer_free(owned(Vec::new()));
        let text = "Relay \u{1f980}";
        let buffer = owned(text.as_bytes().to_vec());
        assert_eq!(
            unsafe { std::str::from_utf8(slice::from_raw_parts(buffer.ptr, buffer.len)) },
            Ok(text)
        );
        relayswarm_buffer_free(buffer);
    }
}
