import Foundation
import RelaySwarmFFI

private let abiIsCompatible = relayswarm_abi_version() == RELAYSWARM_ABI_VERSION

private enum NativeError: Error { case failed(String) }

private func take(_ buffer: RsBuffer) -> Data {
    guard let ptr = buffer.ptr, buffer.len > 0 else {
        relayswarm_buffer_free(buffer)
        return Data()
    }
    return Data(bytesNoCopy: ptr, count: buffer.len, deallocator: .custom { ptr, len in
        relayswarm_buffer_free(RsBuffer(ptr: ptr.assumingMemoryBound(to: UInt8.self), len: len))
    })
}

private func check(_ status: Int32, _ error: RsBuffer) throws {
    precondition(abiIsCompatible, "RelaySwarm native/library ABI mismatch")
    if status != 0 {
        let code = String(decoding: take(error), as: UTF8.self)
        if code == "invalid_transfer" { throw CoreError.InvalidTransfer }
        throw NativeError.failed(code)
    }
}

private func withData<R>(_ data: Data, _ body: (UnsafePointer<UInt8>?, Int) throws -> R) rethrows -> R {
    try data.withUnsafeBytes { raw in try body(raw.baseAddress?.assumingMemoryBound(to: UInt8.self), raw.count) }
}

private func withDatas<R>(_ values: [Data], _ body: (UnsafePointer<RsBuffer>?, Int) throws -> R) rethrows -> R {
    var buffers = [RsBuffer](repeating: RsBuffer(), count: values.count)
    func walk(_ index: Int) throws -> R {
        if index == values.count { return try buffers.withUnsafeBufferPointer { try body($0.baseAddress, $0.count) } }
        return try withData(values[index]) { ptr, len in
            buffers[index] = RsBuffer(ptr: UnsafeMutablePointer(mutating: ptr), len: len)
            return try walk(index + 1)
        }
    }
    return try walk(0)
}

private func jsonValue(_ value: Any?) -> Any {
    switch value {
    case nil, is NSNull: return NSNull()
    case let data as Data: return data.map { Int($0) }
    case let values as [Any]: return values.map(jsonValue)
    case let values as [String: Any]: return values.mapValues(jsonValue)
    case let number as Double where !number.isFinite: return number.isNaN ? "NaN" : (number > 0 ? "Infinity" : "-Infinity")
    case let number as Float where !number.isFinite: return number.isNaN ? "NaN" : (number > 0 ? "Infinity" : "-Infinity")
    default: return value!
    }
}

private func jsonData(_ value: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: jsonValue(value), options: [.fragmentsAllowed])
}

private func decode(_ data: Data) -> Any {
    try! JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
}

private func buffer(_ body: (UnsafeMutablePointer<RsBuffer>, UnsafeMutablePointer<RsBuffer>) -> Int32) throws -> Data {
    var out = RsBuffer(), error = RsBuffer()
    try check(body(&out, &error), error)
    return take(out)
}

private func nativeCall(_ name: String, _ args: [String: Any] = [:]) throws -> Any {
    try withData(Data(name.utf8)) { name, nameLen in
        try withData(jsonData(args)) { args, argsLen in
            decode(try buffer { out, error in relayswarm_call(name, nameLen, args, argsLen, out, error) })
        }
    }
}

private func nativeNew(_ name: String, _ args: [String: Any] = [:]) throws -> UnsafeMutableRawPointer {
    try withData(Data(name.utf8)) { name, nameLen in
        try withData(jsonData(args)) { args, argsLen in
            var out: UnsafeMutableRawPointer?, error = RsBuffer()
            try check(relayswarm_new(name, nameLen, args, argsLen, &out, &error), error)
            return out!
        }
    }
}

private func nativeMethod(_ raw: UnsafeMutableRawPointer?, _ name: String, _ args: [String: Any] = [:]) throws -> Any {
    guard let raw else { throw NativeError.failed("object has already been destroyed") }
    return try withData(Data(name.utf8)) { name, nameLen in
        try withData(jsonData(args)) { args, argsLen in
            decode(try buffer { out, error in relayswarm_method(raw, name, nameLen, args, argsLen, out, error) })
        }
    }
}

private func dict(_ value: Any) -> [String: Any] { value as! [String: Any] }
private func array(_ value: Any) -> [Any] { value as! [Any] }
private func string(_ value: Any?) -> String { value as! String }
private func boolean(_ value: Any?) -> Bool { (value as! NSNumber).boolValue }
private func uint32(_ value: Any?) -> UInt32 { (value as! NSNumber).uint32Value }
private func uint64(_ value: Any?) -> UInt64 { (value as! NSNumber).uint64Value }
private func int64(_ value: Any?) -> Int64 { (value as! NSNumber).int64Value }
private func double(_ value: Any?) -> Double {
    if let value = value as? String { return Double(value)! }
    return (value as! NSNumber).doubleValue
}
private func optional<T>(_ value: Any?, _ convert: (Any) -> T) -> T? {
    guard let value, !(value is NSNull) else { return nil }
    return convert(value)
}
private func data(_ value: Any?) -> Data { Data(array(value!).map { UInt8(($0 as! NSNumber).uint8Value) }) }

private final class BinaryReader {
    let input: Data
    var at = 0
    init(_ input: Data) { self.input = input }
    func u8() -> UInt8 { defer { at += 1 }; return input[at] }
    func bool() -> Bool { u8() != 0 }
    func u32() -> UInt32 { defer { at += 4 }; return input.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: at, as: UInt32.self) }.littleEndian }
    func u64() -> UInt64 { defer { at += 8 }; return input.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: at, as: UInt64.self) }.littleEndian }
    func bytes() -> Data { let len = Int(u64()); defer { at += len }; return input.subdata(in: at..<at + len) }
    func string() -> String { String(decoding: bytes(), as: UTF8.self) }
    func optionalU64() -> UInt64? { bool() ? u64() : nil }
    func optionalBytes() -> Data? { bool() ? bytes() : nil }
    func optionalString() -> String? { bool() ? string() : nil }
    func span() -> PieceSpan { PieceSpan(start: u32(), end: u32()) }
    func done() { precondition(at == input.count, "Trailing native record bytes") }
}

private func transferStateBinary(_ bytes: Data) -> TransferState {
    let input = BinaryReader(bytes)
    let commands = (0..<Int(input.u32())).map { _ -> TransferCommand in
        switch input.u8() {
        case 0: return .request(peer: input.u64(), span: input.span())
        case 1: return .fetchOrigin(span: input.span())
        case 2: return .cancel(peer: input.u64())
        case 3: return .abandon(peer: input.u64())
        case 4: return .ban(peer: input.u64())
        case 5: return .deliver(bytes: input.bytes())
        case 6: return .fail
        default: fatalError("Unknown TransferCommand")
        }
    }
    let state = TransferState(commands: commands, nextDeadline: input.optionalU64(), late: input.bool(), finished: input.bool(), verifiedBytes: input.u64())
    input.done()
    return state
}

private func linkUpdateBinary(_ bytes: Data) -> LinkUpdate {
    let input = BinaryReader(bytes)
    let events = (0..<Int(input.u32())).map { _ -> PeerLinkEvent in
        switch input.u8() {
        case 0: return .sendText(text: input.string())
        case 1: return .sendBinary(bytes: input.bytes())
        case 2: return .closed(reason: input.string())
        case 3: return .report(report: RequestReport(id: input.optionalU64(), outcome: [RequestOutcome.payload, .none, .timeout, .abort, .abandoned, .closed, .busy, .sendError][Int(input.u8())], receivedBytes: input.u64(), metadataReceived: input.bool(), draining: input.bool(), closeReason: input.optionalString()))
        case 4: return .resolved(id: input.optionalU64(), bytes: input.optionalBytes())
        case 5: return .haveChanged(keys: (0..<Int(input.u32())).map { _ in input.string() })
        case 6: return .scheduleChanged
        case 7: return .serveRequest(key: input.string())
        case 8: return .serveRange(key: input.string(), span: input.span())
        case 9: return .uploadCancelled(bytes: input.u64())
        case 10: return .progress(received: input.u64(), size: input.u64())
        default: fatalError("Unknown PeerLinkEvent")
        }
    }
    let update = LinkUpdate(events: events, requestId: input.optionalU64(), version: input.u64(), closed: input.bool(), busy: input.bool(), transferring: input.bool(), outboundInFlight: input.u32(), bytesIn: input.u64(), bytesOut: input.u64(), openedAt: input.u64(), lastServedAt: input.u64(), lastDeliveredAt: input.u64(), nextDeadline: input.optionalU64(), uploadWaiting: input.bool())
    input.done()
    return update
}

public enum CoreError: Swift.Error { case InvalidTransfer }
extension CoreError: Equatable, Hashable {}
extension CoreError: Foundation.LocalizedError {
    public var errorDescription: String? { String(reflecting: self) }
}

public struct PieceSpan { public var start: UInt32; public var end: UInt32; public init(start: UInt32, end: UInt32) { self.start = start; self.end = end } }
public struct ByteSpan { public var from: UInt64; public var to: UInt64; public init(from: UInt64, to: UInt64) { self.from = from; self.to = to } }
public struct Timing { public var firstByteMs: Double?; public var rate: Double?; public init(firstByteMs: Double?, rate: Double?) { self.firstByteMs = firstByteMs; self.rate = rate } }
public struct PeerTiming { public var peer: UInt64; public var timing: Timing; public init(peer: UInt64, timing: Timing) { self.peer = peer; self.timing = timing } }
public struct TransferSettings { public var maxHolders: UInt32; public var originReserveMs: Double; public init(maxHolders: UInt32, originReserveMs: Double) { self.maxHolders = maxHolders; self.originReserveMs = originReserveMs } }
public struct TransferState { public var commands: [TransferCommand]; public var nextDeadline: UInt64?; public var late: Bool; public var finished: Bool; public var verifiedBytes: UInt64; public init(commands: [TransferCommand], nextDeadline: UInt64?, late: Bool, finished: Bool, verifiedBytes: UInt64) { self.commands = commands; self.nextDeadline = nextDeadline; self.late = late; self.finished = finished; self.verifiedBytes = verifiedBytes } }
public struct LinkLimits { public var chunkBytes: UInt64; public var highWaterBytes: UInt64; public var lowWaterBytes: UInt64; public var maxHaveKeys: UInt32; public init(chunkBytes: UInt64, highWaterBytes: UInt64, lowWaterBytes: UInt64, maxHaveKeys: UInt32) { self.chunkBytes = chunkBytes; self.highWaterBytes = highWaterBytes; self.lowWaterBytes = lowWaterBytes; self.maxHaveKeys = maxHaveKeys } }
public struct LinkSettings { public var maxSegmentBytes: UInt64; public var maxQueuedRequests: UInt32; public var drainTimeoutMs: UInt64; public var reliable: Bool; public init(maxSegmentBytes: UInt64, maxQueuedRequests: UInt32, drainTimeoutMs: UInt64, reliable: Bool) { self.maxSegmentBytes = maxSegmentBytes; self.maxQueuedRequests = maxQueuedRequests; self.drainTimeoutMs = drainTimeoutMs; self.reliable = reliable } }
public struct RequestReport { public var id: UInt64?; public var outcome: RequestOutcome; public var receivedBytes: UInt64; public var metadataReceived: Bool; public var draining: Bool; public var closeReason: String?; public init(id: UInt64?, outcome: RequestOutcome, receivedBytes: UInt64, metadataReceived: Bool, draining: Bool, closeReason: String?) { self.id = id; self.outcome = outcome; self.receivedBytes = receivedBytes; self.metadataReceived = metadataReceived; self.draining = draining; self.closeReason = closeReason } }
public struct LinkUpdate { public var events: [PeerLinkEvent]; public var requestId: UInt64?; public var version: UInt64; public var closed: Bool; public var busy: Bool; public var transferring: Bool; public var outboundInFlight: UInt32; public var bytesIn: UInt64; public var bytesOut: UInt64; public var openedAt: UInt64; public var lastServedAt: UInt64; public var lastDeliveredAt: UInt64; public var nextDeadline: UInt64?; public var uploadWaiting: Bool; public init(events: [PeerLinkEvent], requestId: UInt64?, version: UInt64, closed: Bool, busy: Bool, transferring: Bool, outboundInFlight: UInt32, bytesIn: UInt64, bytesOut: UInt64, openedAt: UInt64, lastServedAt: UInt64, lastDeliveredAt: UInt64, nextDeadline: UInt64?, uploadWaiting: Bool) { self.events = events; self.requestId = requestId; self.version = version; self.closed = closed; self.busy = busy; self.transferring = transferring; self.outboundInFlight = outboundInFlight; self.bytesIn = bytesIn; self.bytesOut = bytesOut; self.openedAt = openedAt; self.lastServedAt = lastServedAt; self.lastDeliveredAt = lastDeliveredAt; self.nextDeadline = nextDeadline; self.uploadWaiting = uploadWaiting } }
public struct TimedKey { public var key: String; public var at: UInt64; public init(key: String, at: UInt64) { self.key = key; self.at = at } }
public struct LinkSets { public var have: [String]; public var fetching: [TimedKey]; public var renditions: [TimedKey]; public var serving: Bool; public var rendition: String?; public var contributionAt: UInt64; public var closeReason: String?; public init(have: [String], fetching: [TimedKey], renditions: [TimedKey], serving: Bool, rendition: String?, contributionAt: UInt64, closeReason: String?) { self.have = have; self.fetching = fetching; self.renditions = renditions; self.serving = serving; self.rendition = rendition; self.contributionAt = contributionAt; self.closeReason = closeReason } }
public struct SelectableLink { public var id: UInt64; public var pubkey: String; public var closed: Bool; public var busy: Bool; public var hasKey: Bool; public init(id: UInt64, pubkey: String, closed: Bool, busy: Bool, hasKey: Bool) { self.id = id; self.pubkey = pubkey; self.closed = closed; self.busy = busy; self.hasKey = hasKey } }
public struct LinkObservation { public var attempts: UInt32; public var latencyMs: Double?; public var throughputBytesPerSecond: Double?; public var failureRate: Double; public var consecutiveFailures: UInt32; public var lastSelected: UInt64; public init(attempts: UInt32, latencyMs: Double?, throughputBytesPerSecond: Double?, failureRate: Double, consecutiveFailures: UInt32, lastSelected: UInt64) { self.attempts = attempts; self.latencyMs = latencyMs; self.throughputBytesPerSecond = throughputBytesPerSecond; self.failureRate = failureRate; self.consecutiveFailures = consecutiveFailures; self.lastSelected = lastSelected } }
public struct DiscoveryHolder { public var pubkey: String; public var firstMissAt: UInt64; public var misses: UInt32; public var lastKey: String; public init(pubkey: String, firstMissAt: UInt64, misses: UInt32, lastKey: String) { self.pubkey = pubkey; self.firstMissAt = firstMissAt; self.misses = misses; self.lastKey = lastKey } }
public struct DiscoveryContext { public var id: UInt64; public var mediaType: DiscoveryMedia; public var rendition: String; public var keys: [String]; public var lastDemandAt: UInt64?; public var activityAt: UInt64; public var spent: Bool; public var holders: [DiscoveryHolder]; public init(id: UInt64, mediaType: DiscoveryMedia, rendition: String, keys: [String], lastDemandAt: UInt64?, activityAt: UInt64, spent: Bool, holders: [DiscoveryHolder]) { self.id = id; self.mediaType = mediaType; self.rendition = rendition; self.keys = keys; self.lastDemandAt = lastDemandAt; self.activityAt = activityAt; self.spent = spent; self.holders = holders } }
public struct DiscoveryCandidate { public var pubkey: String; public var have: [String]; public var ticket: String?; public var at: UInt64; public init(pubkey: String, have: [String], ticket: String?, at: UInt64) { self.pubkey = pubkey; self.have = have; self.ticket = ticket; self.at = at } }
public struct DiscoveryAttempt { public var id: UInt64; public var pubkey: String; public var ticket: String?; public var key: String; public var dial: UInt64?; public init(id: UInt64, pubkey: String, ticket: String?, key: String, dial: UInt64?) { self.id = id; self.pubkey = pubkey; self.ticket = ticket; self.key = key; self.dial = dial } }
public struct DiscoveryWindow { public var id: UInt64; public var context: UInt64; public var mediaType: DiscoveryMedia; public var createdAt: UInt64; public var expiresAt: UInt64; public var attempt: DiscoveryAttempt?; public var vacant: Bool; public var victim: String?; public init(id: UInt64, context: UInt64, mediaType: DiscoveryMedia, createdAt: UInt64, expiresAt: UInt64, attempt: DiscoveryAttempt?, vacant: Bool, victim: String?) { self.id = id; self.context = context; self.mediaType = mediaType; self.createdAt = createdAt; self.expiresAt = expiresAt; self.attempt = attempt; self.vacant = vacant; self.victim = victim } }
public struct FoundHolder { public var context: UInt64; public var mediaType: DiscoveryMedia; public var candidate: DiscoveryCandidate; public var key: String; public init(context: UInt64, mediaType: DiscoveryMedia, candidate: DiscoveryCandidate, key: String) { self.context = context; self.mediaType = mediaType; self.candidate = candidate; self.key = key } }
public struct DiscoveryCounters { public var checks: UInt64; public var replacements: UInt64; public var expired: UInt64; public var opened: UInt64; public var verified: UInt64; public var staleHolder: UInt64; public var staleBlocked: UInt64; public var heldMiss: UInt64; public var rearmed: UInt64; public var victimUnhelpful: UInt64; public var victimServing: UInt64; public var victimConsumer: UInt64; public var unmetNoHint: UInt64; public var unmetIneligible: UInt64; public init(checks: UInt64, replacements: UInt64, expired: UInt64, opened: UInt64, verified: UInt64, staleHolder: UInt64, staleBlocked: UInt64, heldMiss: UInt64, rearmed: UInt64, victimUnhelpful: UInt64, victimServing: UInt64, victimConsumer: UInt64, unmetNoHint: UInt64, unmetIneligible: UInt64) { self.checks = checks; self.replacements = replacements; self.expired = expired; self.opened = opened; self.verified = verified; self.staleHolder = staleHolder; self.staleBlocked = staleBlocked; self.heldMiss = heldMiss; self.rearmed = rearmed; self.victimUnhelpful = victimUnhelpful; self.victimServing = victimServing; self.victimConsumer = victimConsumer; self.unmetNoHint = unmetNoHint; self.unmetIneligible = unmetIneligible } }
public struct DiscoverySnapshot { public var candidates: UInt32; public var contexts: UInt32; public var requestedKeys: UInt32; public var replacementSpent: UInt32; public var replacementRearmMs: UInt64; public var opportunityActive: Bool; public var remainingMs: UInt64; public var vacancyReserved: Bool; public var counters: DiscoveryCounters; public init(candidates: UInt32, contexts: UInt32, requestedKeys: UInt32, replacementSpent: UInt32, replacementRearmMs: UInt64, opportunityActive: Bool, remainingMs: UInt64, vacancyReserved: Bool, counters: DiscoveryCounters) { self.candidates = candidates; self.contexts = contexts; self.requestedKeys = requestedKeys; self.replacementSpent = replacementSpent; self.replacementRearmMs = replacementRearmMs; self.opportunityActive = opportunityActive; self.remainingMs = remainingMs; self.vacancyReserved = vacancyReserved; self.counters = counters } }
public struct PlayerSupply { public var rendition: String; public var size: UInt64?; public var peers: [PeerTiming]; public var origin: Timing?; public var shared: Timing; public var availableMs: Double; public var maxHolders: UInt32; public init(rendition: String, size: UInt64?, peers: [PeerTiming], origin: Timing?, shared: Timing, availableMs: Double, maxHolders: UInt32) { self.rendition = rendition; self.size = size; self.peers = peers; self.origin = origin; self.shared = shared; self.availableMs = availableMs; self.maxHolders = maxHolders } }
public struct PlayerSupplyHint { public var rendition: String; public var eligibleHolders: UInt32; public var projectedMs: Double?; public init(rendition: String, eligibleHolders: UInt32, projectedMs: Double?) { self.rendition = rendition; self.eligibleHolders = eligibleHolders; self.projectedMs = projectedMs } }

public enum TransferSource { case peer(peer: UInt64); case origin }
public enum TransferCommand { case request(peer: UInt64, span: PieceSpan); case fetchOrigin(span: PieceSpan); case cancel(peer: UInt64); case abandon(peer: UInt64); case ban(peer: UInt64); case deliver(bytes: Data); case fail }
public enum RequestOutcome { case payload; case none; case timeout; case abort; case abandoned; case closed; case busy; case sendError }
public enum PeerLinkEvent { case sendText(text: String); case sendBinary(bytes: Data); case closed(reason: String); case report(report: RequestReport); case resolved(id: UInt64?, bytes: Data?); case haveChanged(keys: [String]); case scheduleChanged; case serveRequest(key: String); case serveRange(key: String, span: PieceSpan); case uploadCancelled(bytes: UInt64); case progress(received: UInt64, size: UInt64) }
public enum DiscoveryMedia { case main; case audio }
public enum PlayerCommand { case playerHint(hint: PlayerSupplyHint) }

#if compiler(>=6)
extension PieceSpan: Sendable {}; extension ByteSpan: Sendable {}; extension Timing: Sendable {}; extension PeerTiming: Sendable {}; extension TransferSettings: Sendable {}; extension TransferState: Sendable {}; extension LinkLimits: Sendable {}; extension LinkSettings: Sendable {}; extension RequestReport: Sendable {}; extension LinkUpdate: Sendable {}; extension TimedKey: Sendable {}; extension LinkSets: Sendable {}; extension SelectableLink: Sendable {}; extension LinkObservation: Sendable {}; extension DiscoveryHolder: Sendable {}; extension DiscoveryContext: Sendable {}; extension DiscoveryCandidate: Sendable {}; extension DiscoveryAttempt: Sendable {}; extension DiscoveryWindow: Sendable {}; extension FoundHolder: Sendable {}; extension DiscoveryCounters: Sendable {}; extension DiscoverySnapshot: Sendable {}; extension PlayerSupply: Sendable {}; extension PlayerSupplyHint: Sendable {}
extension TransferSource: Sendable {}; extension TransferCommand: Sendable {}; extension RequestOutcome: Sendable {}; extension PeerLinkEvent: Sendable {}; extension DiscoveryMedia: Sendable {}; extension PlayerCommand: Sendable {}
#endif
extension PieceSpan: Equatable, Hashable {}; extension ByteSpan: Equatable, Hashable {}; extension Timing: Equatable, Hashable {}; extension PeerTiming: Equatable, Hashable {}; extension TransferSettings: Equatable, Hashable {}; extension TransferState: Equatable, Hashable {}; extension LinkLimits: Equatable, Hashable {}; extension LinkSettings: Equatable, Hashable {}; extension RequestReport: Equatable, Hashable {}; extension LinkUpdate: Equatable, Hashable {}; extension TimedKey: Equatable, Hashable {}; extension LinkSets: Equatable, Hashable {}; extension SelectableLink: Equatable, Hashable {}; extension LinkObservation: Equatable, Hashable {}; extension DiscoveryHolder: Equatable, Hashable {}; extension DiscoveryContext: Equatable, Hashable {}; extension DiscoveryCandidate: Equatable, Hashable {}; extension DiscoveryAttempt: Equatable, Hashable {}; extension DiscoveryWindow: Equatable, Hashable {}; extension FoundHolder: Equatable, Hashable {}; extension DiscoveryCounters: Equatable, Hashable {}; extension DiscoverySnapshot: Equatable, Hashable {}; extension PlayerSupplyHint: Equatable, Hashable {}
extension TransferSource: Equatable, Hashable {}; extension TransferCommand: Equatable, Hashable {}; extension RequestOutcome: Equatable, Hashable {}; extension PeerLinkEvent: Equatable, Hashable {}; extension DiscoveryMedia: Equatable, Hashable {}; extension PlayerCommand: Equatable, Hashable {}

private func span(_ value: Any) -> PieceSpan { let v = dict(value); return PieceSpan(start: uint32(v["start"]), end: uint32(v["end"])) }
private func spanJson(_ value: PieceSpan) -> [String: Any] { ["start": value.start, "end": value.end] }
private func timing(_ value: Any) -> Timing { let v = dict(value); return Timing(firstByteMs: optional(v["first_byte_ms"], double), rate: optional(v["rate"], double)) }
private func timingJson(_ value: Timing) -> [String: Any] { ["first_byte_ms": value.firstByteMs as Any, "rate": value.rate as Any] }
private func peerTimingJson(_ value: PeerTiming) -> [String: Any] { ["peer": value.peer, "timing": timingJson(value.timing)] }
private func sourceJson(_ value: TransferSource) -> Any { switch value { case let .peer(peer): return ["Peer": ["peer": peer]]; case .origin: return "Origin" } }
private func outcome(_ value: Any) -> RequestOutcome { switch string(value) { case "Payload": return .payload; case "None": return .none; case "Timeout": return .timeout; case "Abort": return .abort; case "Abandoned": return .abandoned; case "Closed": return .closed; case "Busy": return .busy; case "SendError": return .sendError; default: fatalError("Unknown RequestOutcome") } }
private func report(_ value: Any) -> RequestReport { let v = dict(value); return RequestReport(id: optional(v["id"], uint64), outcome: outcome(v["outcome"]!), receivedBytes: uint64(v["received_bytes"]), metadataReceived: boolean(v["metadata_received"]), draining: boolean(v["draining"]), closeReason: optional(v["close_reason"], string)) }
private func command(_ value: Any) -> TransferCommand {
    if let tag = value as? String { if tag == "Fail" { return .fail }; fatalError("Unknown TransferCommand") }
    let (tag, body) = dict(value).first!; let v = dict(body)
    switch tag { case "Request": return .request(peer: uint64(v["peer"]), span: span(v["span"]!)); case "FetchOrigin": return .fetchOrigin(span: span(v["span"]!)); case "Cancel": return .cancel(peer: uint64(v["peer"])); case "Abandon": return .abandon(peer: uint64(v["peer"])); case "Ban": return .ban(peer: uint64(v["peer"])); case "Deliver": return .deliver(bytes: data(v["bytes"])); default: fatalError("Unknown TransferCommand") }
}
private func transferState(_ value: Any) -> TransferState { let v = dict(value); return TransferState(commands: array(v["commands"]!).map(command), nextDeadline: optional(v["next_deadline"], uint64), late: boolean(v["late"]), finished: boolean(v["finished"]), verifiedBytes: uint64(v["verified_bytes"])) }
private func event(_ value: Any) -> PeerLinkEvent {
    if let tag = value as? String { if tag == "ScheduleChanged" { return .scheduleChanged }; fatalError("Unknown PeerLinkEvent") }
    let (tag, body) = dict(value).first!; let v = dict(body)
    switch tag { case "SendText": return .sendText(text: string(v["text"])); case "SendBinary": return .sendBinary(bytes: data(v["bytes"])); case "Closed": return .closed(reason: string(v["reason"])); case "Report": return .report(report: report(v["report"]!)); case "Resolved": return .resolved(id: optional(v["id"], uint64), bytes: optional(v["bytes"], data)); case "HaveChanged": return .haveChanged(keys: array(v["keys"]!).map(string)); case "ServeRequest": return .serveRequest(key: string(v["key"])); case "ServeRange": return .serveRange(key: string(v["key"]), span: span(v["span"]!)); case "UploadCancelled": return .uploadCancelled(bytes: uint64(v["bytes"])); case "Progress": return .progress(received: uint64(v["received"]), size: uint64(v["size"])); default: fatalError("Unknown PeerLinkEvent") }
}
private func linkUpdate(_ value: Any) -> LinkUpdate { let v = dict(value); return LinkUpdate(events: array(v["events"]!).map(event), requestId: optional(v["request_id"], uint64), version: uint64(v["version"]), closed: boolean(v["closed"]), busy: boolean(v["busy"]), transferring: boolean(v["transferring"]), outboundInFlight: uint32(v["outbound_in_flight"]), bytesIn: uint64(v["bytes_in"]), bytesOut: uint64(v["bytes_out"]), openedAt: uint64(v["opened_at"]), lastServedAt: uint64(v["last_served_at"]), lastDeliveredAt: uint64(v["last_delivered_at"]), nextDeadline: optional(v["next_deadline"], uint64), uploadWaiting: boolean(v["upload_waiting"])) }
private func timedKey(_ value: Any) -> TimedKey { let v = dict(value); return TimedKey(key: string(v["key"]), at: uint64(v["at"])) }
private func linkSets(_ value: Any) -> LinkSets { let v = dict(value); return LinkSets(have: array(v["have"]!).map(string), fetching: array(v["fetching"]!).map(timedKey), renditions: array(v["renditions"]!).map(timedKey), serving: boolean(v["serving"]), rendition: optional(v["rendition"], string), contributionAt: uint64(v["contribution_at"]), closeReason: optional(v["close_reason"], string)) }
private func observation(_ value: Any) -> LinkObservation { let v = dict(value); return LinkObservation(attempts: uint32(v["attempts"]), latencyMs: optional(v["latency_ms"], double), throughputBytesPerSecond: optional(v["throughput_bytes_per_second"], double), failureRate: double(v["failure_rate"]), consecutiveFailures: uint32(v["consecutive_failures"]), lastSelected: uint64(v["last_selected"])) }
private func media(_ value: Any) -> DiscoveryMedia { string(value) == "Main" ? .main : .audio }
private func candidate(_ value: Any) -> DiscoveryCandidate { let v = dict(value); return DiscoveryCandidate(pubkey: string(v["pubkey"]), have: array(v["have"]!).map(string), ticket: optional(v["ticket"], string), at: uint64(v["at"])) }
private func holder(_ value: Any) -> DiscoveryHolder { let v = dict(value); return DiscoveryHolder(pubkey: string(v["pubkey"]), firstMissAt: uint64(v["first_miss_at"]), misses: uint32(v["misses"]), lastKey: string(v["last_key"])) }
private func discoveryContext(_ value: Any) -> DiscoveryContext { let v = dict(value); return DiscoveryContext(id: uint64(v["id"]), mediaType: media(v["media_type"]!), rendition: string(v["rendition"]), keys: array(v["keys"]!).map(string), lastDemandAt: optional(v["last_demand_at"], uint64), activityAt: uint64(v["activity_at"]), spent: boolean(v["spent"]), holders: array(v["holders"]!).map(holder)) }
private func attempt(_ value: Any) -> DiscoveryAttempt { let v = dict(value); return DiscoveryAttempt(id: uint64(v["id"]), pubkey: string(v["pubkey"]), ticket: optional(v["ticket"], string), key: string(v["key"]), dial: optional(v["dial"], uint64)) }
private func found(_ value: Any) -> FoundHolder { let v = dict(value); return FoundHolder(context: uint64(v["context"]), mediaType: media(v["media_type"]!), candidate: candidate(v["candidate"]!), key: string(v["key"])) }
private func counters(_ value: Any) -> DiscoveryCounters { let v = dict(value); return DiscoveryCounters(checks: uint64(v["checks"]), replacements: uint64(v["replacements"]), expired: uint64(v["expired"]), opened: uint64(v["opened"]), verified: uint64(v["verified"]), staleHolder: uint64(v["stale_holder"]), staleBlocked: uint64(v["stale_blocked"]), heldMiss: uint64(v["held_miss"]), rearmed: uint64(v["rearmed"]), victimUnhelpful: uint64(v["victim_unhelpful"]), victimServing: uint64(v["victim_serving"]), victimConsumer: uint64(v["victim_consumer"]), unmetNoHint: uint64(v["unmet_no_hint"]), unmetIneligible: uint64(v["unmet_ineligible"])) }

public protocol TransferProtocol: AnyObject, Sendable { func start(now: UInt64, peers: [PeerTiming], origin: Timing, shared: Timing) -> TransferState; func progress(now: UInt64, source: TransferSource, received: UInt64) -> TransferState; func delivered(now: UInt64, source: TransferSource, span: PieceSpan, bytes: Data) -> TransferState; func failed(now: UInt64, source: TransferSource) -> TransferState; func tick(now: UInt64) -> TransferState }
open class Transfer: TransferProtocol, @unchecked Sendable {
    public struct NoPointer {}
    private let raw: UnsafeMutableRawPointer?
    public init(settings: TransferSettings, size: UInt64, sha256: String, pieces: [String], deadline: UInt64) throws { raw = try nativeNew("transfer", ["settings": ["max_holders": settings.maxHolders, "origin_reserve_ms": settings.originReserveMs], "size": size, "sha256": sha256, "pieces": pieces, "deadline": deadline]) }
    public init(noPointer: NoPointer) { raw = nil }
    deinit { if let raw { relayswarm_object_free(raw) } }
    open func start(now: UInt64, peers: [PeerTiming], origin: Timing, shared: Timing) -> TransferState {
        let inputs = peers.map { RsPeerTiming(peer: $0.peer, timing: RsTiming(first_byte_ms: $0.timing.firstByteMs ?? 0, rate: $0.timing.rate ?? 0, first_byte_present: $0.timing.firstByteMs != nil, rate_present: $0.timing.rate != nil)) }
        let origin = RsTiming(first_byte_ms: origin.firstByteMs ?? 0, rate: origin.rate ?? 0, first_byte_present: origin.firstByteMs != nil, rate_present: origin.rate != nil)
        let shared = RsTiming(first_byte_ms: shared.firstByteMs ?? 0, rate: shared.rate ?? 0, first_byte_present: shared.firstByteMs != nil, rate_present: shared.rate != nil)
        return inputs.withUnsafeBufferPointer { peers in
            transferStateBinary(try! buffer { out, error in relayswarm_transfer_start(raw, now, peers.baseAddress, peers.count, origin, shared, out, error) })
        }
    }
    open func progress(now: UInt64, source: TransferSource, received: UInt64) -> TransferState { transferState(try! nativeMethod(raw, "progress", ["now": now, "source": sourceJson(source), "received": received])) }
    open func delivered(now: UInt64, source: TransferSource, span: PieceSpan, bytes: Data) -> TransferState { transferState(try! nativeMethod(raw, "delivered", ["now": now, "source": sourceJson(source), "span": spanJson(span), "bytes": bytes])) }
    open func failed(now: UInt64, source: TransferSource) -> TransferState { transferState(try! nativeMethod(raw, "failed", ["now": now, "source": sourceJson(source)])) }
    open func tick(now: UInt64) -> TransferState { transferState(try! nativeMethod(raw, "tick", ["now": now])) }
}

public protocol PeerLinkProtocol: AnyObject, Sendable { func setChannelOpen(open: Bool); func setReliable(reliable: Bool); func observeBuffered(buffered: UInt64); func sets() -> LinkSets; func state() -> LinkUpdate; func handleText(now: UInt64, text: String) -> LinkUpdate; func handleBinary(now: UInt64, chunk: Data) -> LinkUpdate; func request(now: UInt64, key: String, timeoutMs: UInt64, expectedSize: UInt64?) -> LinkUpdate; func requestRange(now: UInt64, key: String, timeoutMs: UInt64, span: PieceSpan, objectSize: UInt64) -> LinkUpdate; func abort(now: UInt64, id: UInt64, abandoned: Bool) -> LinkUpdate; func closeLink(reason: String) -> LinkUpdate; func tick(now: UInt64) -> LinkUpdate; func serveResponse(now: UInt64, bytes: Data?) -> LinkUpdate; func bufferedAmountLow(now: UInt64, buffered: UInt64) -> LinkUpdate; func sendHave(keys: [String]) -> LinkUpdate; func sendHaveChange(add: [String], del: [String]) -> LinkUpdate; func sendContribution(serving: Bool, rendition: String?) -> LinkUpdate; func sendFetching(key: String, leaseMs: UInt64) -> LinkUpdate }
open class PeerLink: PeerLinkProtocol, @unchecked Sendable {
    public struct NoPointer {}
    private let raw: UnsafeMutableRawPointer?
    public init(settings: LinkSettings, now: UInt64) { raw = try! nativeNew("peer_link", ["settings": ["max_segment_bytes": settings.maxSegmentBytes, "max_queued_requests": settings.maxQueuedRequests, "drain_timeout_ms": settings.drainTimeoutMs, "reliable": settings.reliable], "now": now]) }
    public init(noPointer: NoPointer) { raw = nil }
    deinit { if let raw { relayswarm_object_free(raw) } }
    open func setChannelOpen(open: Bool) { _ = try! nativeMethod(raw, "set_channel_open", ["open": open]) }
    open func setReliable(reliable: Bool) { _ = try! nativeMethod(raw, "set_reliable", ["reliable": reliable]) }
    open func observeBuffered(buffered: UInt64) { _ = try! nativeMethod(raw, "observe_buffered", ["buffered": buffered]) }
    open func sets() -> LinkSets { linkSets(try! nativeMethod(raw, "sets")) }
    open func state() -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "state")) }
    open func handleText(now: UInt64, text: String) -> LinkUpdate {
        withData(Data(text.utf8)) { text, len in linkUpdateBinary(try! buffer { out, error in relayswarm_peer_link_handle_text(raw, now, text, len, out, error) }) }
    }
    open func handleBinary(now: UInt64, chunk: Data) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "handle_binary", ["now": now, "chunk": chunk])) }
    open func request(now: UInt64, key: String, timeoutMs: UInt64, expectedSize: UInt64?) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "request", ["now": now, "key": key, "timeout_ms": timeoutMs, "expected_size": expectedSize as Any])) }
    open func requestRange(now: UInt64, key: String, timeoutMs: UInt64, span: PieceSpan, objectSize: UInt64) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "request_range", ["now": now, "key": key, "timeout_ms": timeoutMs, "span": spanJson(span), "object_size": objectSize])) }
    open func abort(now: UInt64, id: UInt64, abandoned: Bool) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "abort", ["now": now, "id": id, "abandoned": abandoned])) }
    open func closeLink(reason: String) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "close_link", ["reason": reason])) }
    open func tick(now: UInt64) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "tick", ["now": now])) }
    open func serveResponse(now: UInt64, bytes: Data?) -> LinkUpdate {
        if let bytes {
            return withData(bytes) { bytes, len in linkUpdateBinary(try! buffer { out, error in relayswarm_peer_link_serve_response(raw, now, bytes, len, true, out, error) }) }
        }
        return linkUpdateBinary(try! buffer { out, error in relayswarm_peer_link_serve_response(raw, now, nil, 0, false, out, error) })
    }
    open func bufferedAmountLow(now: UInt64, buffered: UInt64) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "buffered_amount_low", ["now": now, "buffered": buffered])) }
    open func sendHave(keys: [String]) -> LinkUpdate {
        withDatas(keys.map { Data($0.utf8) }) { keys, count in
            linkUpdateBinary(try! buffer { out, error in relayswarm_peer_link_send_have(raw, RsBufferList(ptr: keys, len: count), out, error) })
        }
    }
    open func sendHaveChange(add: [String], del: [String]) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "send_have_change", ["add": add, "del": del])) }
    open func sendContribution(serving: Bool, rendition: String?) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "send_contribution", ["serving": serving, "rendition": rendition as Any])) }
    open func sendFetching(key: String, leaseMs: UInt64) -> LinkUpdate { linkUpdate(try! nativeMethod(raw, "send_fetching", ["key": key, "lease_ms": leaseMs])) }
}

public protocol PeerSelectionProtocol: AnyObject, Sendable { func observe(now: UInt64, firstByteMs: Double?, bytes: Double, flowMs: Double, totalFlowMs: Double?); func record(now: UInt64, link: UInt64, elapsedMs: Double, bytes: Double); func markSelected(link: UInt64); func forget(link: UInt64); func select(links: [SelectableLink], tried: [String], size: Double, deadlineMs: Double) -> UInt64?; func firstByteMs() -> Double?; func rate() -> Double?; func projectMs(size: Double) -> Double?; func minimumMs(size: Double) -> Double; func lastObservedAt() -> UInt64; func turn() -> UInt32; func order() -> UInt64; func summary(link: UInt64) -> LinkObservation; func estimate(link: UInt64, size: Double) -> Double? }
open class PeerSelection: PeerSelectionProtocol, @unchecked Sendable {
    public struct NoPointer {}
    private let raw: UnsafeMutableRawPointer?
    public init() { raw = try! nativeNew("peer_selection") }
    public init(noPointer: NoPointer) { raw = nil }
    deinit { if let raw { relayswarm_object_free(raw) } }
    open func observe(now: UInt64, firstByteMs: Double?, bytes: Double, flowMs: Double, totalFlowMs: Double?) { _ = try! nativeMethod(raw, "observe", ["now": now, "first_byte_ms": firstByteMs as Any, "bytes": bytes, "flow_ms": flowMs, "total_flow_ms": totalFlowMs as Any]) }
    open func record(now: UInt64, link: UInt64, elapsedMs: Double, bytes: Double) { _ = try! nativeMethod(raw, "record", ["now": now, "link": link, "elapsed_ms": elapsedMs, "bytes": bytes]) }
    open func markSelected(link: UInt64) { _ = try! nativeMethod(raw, "mark_selected", ["link": link]) }
    open func forget(link: UInt64) { _ = try! nativeMethod(raw, "forget", ["link": link]) }
    open func select(links: [SelectableLink], tried: [String], size: Double, deadlineMs: Double) -> UInt64? { optional(try! nativeMethod(raw, "select", ["links": links.map { ["id": $0.id, "pubkey": $0.pubkey, "closed": $0.closed, "busy": $0.busy, "has_key": $0.hasKey] }, "tried": tried, "size": size, "deadline_ms": deadlineMs]), uint64) }
    open func firstByteMs() -> Double? { optional(try! nativeMethod(raw, "first_byte_ms"), double) }
    open func rate() -> Double? { optional(try! nativeMethod(raw, "rate"), double) }
    open func projectMs(size: Double) -> Double? { optional(try! nativeMethod(raw, "project_ms", ["size": size]), double) }
    open func minimumMs(size: Double) -> Double { double(try! nativeMethod(raw, "minimum_ms", ["size": size])) }
    open func lastObservedAt() -> UInt64 { uint64(try! nativeMethod(raw, "last_observed_at")) }
    open func turn() -> UInt32 { uint32(try! nativeMethod(raw, "turn")) }
    open func order() -> UInt64 {
        var out: UInt64 = 0, error = RsBuffer()
        try! check(relayswarm_peer_selection_order(raw, &out, &error), error)
        return out
    }
    open func summary(link: UInt64) -> LinkObservation { observation(try! nativeMethod(raw, "summary", ["link": link])) }
    open func estimate(link: UInt64, size: Double) -> Double? { optional(try! nativeMethod(raw, "estimate", ["link": link, "size": size]), double) }
}

public protocol NeighbourDiscoveryProtocol: AnyObject, Sendable { func context(now: UInt64, mediaType: String, rendition: String) -> UInt64?; func demand(now: UInt64, mediaType: String, rendition: String, key: String) -> UInt64?; func hint(now: UInt64, pubkey: String, have: [String], ticket: String?); func holderMiss(now: UInt64, context: UInt64?, pubkey: String, key: String); func holderAhead(context: UInt64?, pubkey: String); func rearm(now: UInt64, context: UInt64, allStale: Bool) -> Bool; func stale(now: UInt64, context: UInt64?, pubkey: String) -> Bool; func forget(pubkey: String); func current(now: UInt64, context: UInt64) -> Bool; func choose(now: UInt64, eligible: [String], unmet: [String], room: Bool) -> FoundHolder?; func hinted(now: UInt64, context: UInt64, eligible: [String]) -> FoundHolder?; func begin(now: UInt64) -> UInt64?; func valid(now: UInt64, attempt: UInt64) -> Bool; func replaced(now: UInt64, attempt: UInt64, victim: String?) -> Bool; func allocated(attempt: UInt64, dial: UInt64); func abandoned(attempt: UInt64); func failed(dial: UInt64); func end() -> Bool; func verified(context: UInt64?) -> Bool; func live(now: UInt64) -> Bool; func reserved(now: UInt64) -> Bool; func suppresses(now: UInt64, pubkey: String) -> Bool; func contexts() -> [DiscoveryContext]; func candidates() -> [DiscoveryCandidate]; func window() -> DiscoveryWindow?; func snapshot(now: UInt64) -> DiscoverySnapshot; func clear() }
open class NeighbourDiscovery: NeighbourDiscoveryProtocol, @unchecked Sendable {
    public struct NoPointer {}
    private let raw: UnsafeMutableRawPointer?
    public init() { raw = try! nativeNew("neighbour_discovery") }
    public init(noPointer: NoPointer) { raw = nil }
    deinit { if let raw { relayswarm_object_free(raw) } }
    open func context(now: UInt64, mediaType: String, rendition: String) -> UInt64? { optional(try! nativeMethod(raw, "context", ["now": now, "media_type": mediaType, "rendition": rendition]), uint64) }
    open func demand(now: UInt64, mediaType: String, rendition: String, key: String) -> UInt64? { optional(try! nativeMethod(raw, "demand", ["now": now, "media_type": mediaType, "rendition": rendition, "key": key]), uint64) }
    open func hint(now: UInt64, pubkey: String, have: [String], ticket: String?) { _ = try! nativeMethod(raw, "hint", ["now": now, "pubkey": pubkey, "have": have, "ticket": ticket as Any]) }
    open func holderMiss(now: UInt64, context: UInt64?, pubkey: String, key: String) { _ = try! nativeMethod(raw, "holder_miss", ["now": now, "context": context as Any, "pubkey": pubkey, "key": key]) }
    open func holderAhead(context: UInt64?, pubkey: String) { _ = try! nativeMethod(raw, "holder_ahead", ["context": context as Any, "pubkey": pubkey]) }
    open func rearm(now: UInt64, context: UInt64, allStale: Bool) -> Bool { boolean(try! nativeMethod(raw, "rearm", ["now": now, "context": context, "all_stale": allStale])) }
    open func stale(now: UInt64, context: UInt64?, pubkey: String) -> Bool { boolean(try! nativeMethod(raw, "stale", ["now": now, "context": context as Any, "pubkey": pubkey])) }
    open func forget(pubkey: String) { _ = try! nativeMethod(raw, "forget", ["pubkey": pubkey]) }
    open func current(now: UInt64, context: UInt64) -> Bool { boolean(try! nativeMethod(raw, "current", ["now": now, "context": context])) }
    open func choose(now: UInt64, eligible: [String], unmet: [String], room: Bool) -> FoundHolder? { optional(try! nativeMethod(raw, "choose", ["now": now, "eligible": eligible, "unmet": unmet, "room": room]), found) }
    open func hinted(now: UInt64, context: UInt64, eligible: [String]) -> FoundHolder? { optional(try! nativeMethod(raw, "hinted", ["now": now, "context": context, "eligible": eligible]), found) }
    open func begin(now: UInt64) -> UInt64? { optional(try! nativeMethod(raw, "begin", ["now": now]), uint64) }
    open func valid(now: UInt64, attempt: UInt64) -> Bool { boolean(try! nativeMethod(raw, "valid", ["now": now, "attempt": attempt])) }
    open func replaced(now: UInt64, attempt: UInt64, victim: String?) -> Bool { boolean(try! nativeMethod(raw, "replaced", ["now": now, "attempt": attempt, "victim": victim as Any])) }
    open func allocated(attempt: UInt64, dial: UInt64) { _ = try! nativeMethod(raw, "allocated", ["attempt": attempt, "dial": dial]) }
    open func abandoned(attempt: UInt64) { _ = try! nativeMethod(raw, "abandoned", ["attempt": attempt]) }
    open func failed(dial: UInt64) { _ = try! nativeMethod(raw, "failed", ["dial": dial]) }
    open func end() -> Bool { boolean(try! nativeMethod(raw, "end")) }
    open func verified(context: UInt64?) -> Bool { boolean(try! nativeMethod(raw, "verified", ["context": context as Any])) }
    open func live(now: UInt64) -> Bool { boolean(try! nativeMethod(raw, "live", ["now": now])) }
    open func reserved(now: UInt64) -> Bool { boolean(try! nativeMethod(raw, "reserved", ["now": now])) }
    open func suppresses(now: UInt64, pubkey: String) -> Bool { boolean(try! nativeMethod(raw, "suppresses", ["now": now, "pubkey": pubkey])) }
    open func contexts() -> [DiscoveryContext] { array(try! nativeMethod(raw, "contexts")).map { discoveryContext($0) } }
    open func candidates() -> [DiscoveryCandidate] { array(try! nativeMethod(raw, "candidates")).map(candidate) }
    open func window() -> DiscoveryWindow? { optional(try! nativeMethod(raw, "window")) { value in let v = dict(value); return DiscoveryWindow(id: uint64(v["id"]), context: uint64(v["context"]), mediaType: media(v["media_type"]!), createdAt: uint64(v["created_at"]), expiresAt: uint64(v["expires_at"]), attempt: optional(v["attempt"], attempt), vacant: boolean(v["vacant"]), victim: optional(v["victim"], string)) } }
    open func snapshot(now: UInt64) -> DiscoverySnapshot { let v = dict(try! nativeMethod(raw, "snapshot", ["now": now])); return DiscoverySnapshot(candidates: uint32(v["candidates"]), contexts: uint32(v["contexts"]), requestedKeys: uint32(v["requested_keys"]), replacementSpent: uint32(v["replacement_spent"]), replacementRearmMs: uint64(v["replacement_rearm_ms"]), opportunityActive: boolean(v["opportunity_active"]), remainingMs: uint64(v["remaining_ms"]), vacancyReserved: boolean(v["vacancy_reserved"]), counters: counters(v["counters"]!)) }
    open func clear() { _ = try! nativeMethod(raw, "clear") }
}

public func validStreamAuthorisation(eventJson: String) -> Bool { boolean(try! nativeCall("valid_stream_authorisation", ["event_json": eventJson])) }
public func verifyCommitmentDelegation(eventJson: String, optionsJson: String, atMs: Int64) -> String? { optional(try! nativeCall("verify_commitment_delegation", ["event_json": eventJson, "options_json": optionsJson, "at_ms": atMs]), string) }
public func verifySegmentCommitment(eventJson: String, optionsJson: String, atMs: Int64) -> String? { optional(try! nativeCall("verify_segment_commitment", ["event_json": eventJson, "options_json": optionsJson, "at_ms": atMs]), string) }
public func commitmentPieceSize(size: UInt64) -> UInt64 { uint64(try! nativeCall("commitment_piece_size", ["size": size])) }
public func pieceCount(size: UInt64) -> UInt32? { optional(try! nativeCall("piece_count", ["size": size]), uint32) }
public func pieceSpanBytes(size: UInt64, span: PieceSpan) -> ByteSpan? { optional(try! nativeCall("piece_span_bytes", ["size": size, "span": spanJson(span)])) { let v = dict($0); return ByteSpan(from: uint64(v["from"]), to: uint64(v["to"])) } }
public func defaultTransferSettings() -> TransferSettings { let v = dict(try! nativeCall("default_transfer_settings")); return TransferSettings(maxHolders: uint32(v["max_holders"]), originReserveMs: double(v["origin_reserve_ms"])) }
public func linkLimits() -> LinkLimits { let v = dict(try! nativeCall("link_limits")); return LinkLimits(chunkBytes: uint64(v["chunk_bytes"]), highWaterBytes: uint64(v["high_water_bytes"]), lowWaterBytes: uint64(v["low_water_bytes"]), maxHaveKeys: uint32(v["max_have_keys"])) }
public func playerHint(supply: PlayerSupply) -> PlayerCommand { let input: [String: Any] = ["rendition": supply.rendition, "size": supply.size as Any, "peers": supply.peers.map(peerTimingJson), "origin": supply.origin.map(timingJson) as Any, "shared": timingJson(supply.shared), "available_ms": supply.availableMs, "max_holders": supply.maxHolders]; let v = dict(dict(try! nativeCall("player_hint", ["supply": input]))["PlayerHint"]!); let hint = dict(v["hint"]!); return .playerHint(hint: PlayerSupplyHint(rendition: string(hint["rendition"]), eligibleHolders: uint32(hint["eligible_holders"]), projectedMs: optional(hint["projected_ms"], double))) }
