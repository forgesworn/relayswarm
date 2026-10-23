// Calls the core through the generated Swift bindings. Reads the line format
// scripts/ffi-smoke.mjs writes and prints one JSON line per result, which the
// script checks. Main.kt is the same program in Kotlin.
import Foundation

func text(_ field: Substring) -> String? {
    field == "-" ? nil : String(data: Data(base64Encoded: String(field.dropFirst()))!, encoding: .utf8)!
}
func bytes(_ field: Substring) -> Data? {
    field == "-" ? nil : Data(base64Encoded: String(field.dropFirst()))!
}
func strings(_ field: Substring) -> [String] {
    field == "-" ? [] : field.split(separator: ",").map { text($0)! }
}
func number(_ field: Substring) -> UInt64 { UInt64(field)! }
func json(_ value: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), encoding: .utf8)!
}
func orNull(_ value: Any?) -> Any { value ?? NSNull() }

let lines = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)!
    .split(separator: "\n").map { $0.split(separator: " ", omittingEmptySubsequences: false) }

var at: Int64 = 0
var verdicts: [String] = []
var traces: [String] = []

// One origin and one holder that answers pieces in 40 ms; origin in 30 ms.
func transfer(_ field: [Substring]) {
    let size = number(field[1])
    let object = bytes(field[2])!
    let transfer = try! Transfer(settings: TransferSettings(maxHolders: defaultTransferSettings().maxHolders, originReserveMs: 0),
                                 size: size, sha256: String(field[3]),
                                 pieces: field[4].split(separator: ",").map(String.init), deadline: 4_000)
    var queue: [(at: UInt64, source: TransferSource, span: PieceSpan)] = []
    var log: [String] = []
    var delivered: Data? = nil
    func handle(_ now: UInt64, _ state: TransferState) {
        for command in state.commands {
            switch command {
            case let .request(peer, span): log.append("request \(peer) \(span.start)-\(span.end)"); queue.append((now + 40, .peer(peer: peer), span))
            case let .fetchOrigin(span): log.append("origin \(span.start)-\(span.end)"); queue.append((now + 30, .origin, span))
            case let .cancel(peer): log.append("cancel \(peer)")
            case let .abandon(peer): log.append("abandon \(peer)")
            case let .ban(peer): log.append("ban \(peer)")
            case let .deliver(bytes): log.append("deliver"); delivered = bytes
            case .fail: log.append("fail")
            }
        }
    }
    handle(10, transfer.start(now: 10, peers: [PeerTiming(peer: 1, timing: Timing(firstByteMs: nil, rate: nil))],
                              origin: Timing(firstByteMs: 30, rate: 500), shared: Timing(firstByteMs: 20, rate: 1_000)))
    while delivered == nil, !queue.isEmpty {
        queue.sort { $0.at < $1.at }
        let next = queue.removeFirst()
        let range = pieceSpanBytes(size: size, span: next.span)!
        handle(next.at, transfer.delivered(now: next.at, source: next.source, span: next.span,
                                           bytes: object.subdata(in: Int(range.from)..<Int(range.to))))
    }
    print(json(["log": log, "delivered": orNull(delivered?.base64EncodedString())]))
}

func event(_ event: PeerLinkEvent) -> [Any] {
    switch event {
    case let .sendText(text): return ["sendText", text]
    case let .sendBinary(bytes): return ["sendBinary", bytes.base64EncodedString()]
    case let .closed(reason): return ["closed", reason]
    case let .report(report):
        return ["result", String(describing: report.outcome), report.receivedBytes, report.metadataReceived,
                report.draining, orNull(report.closeReason)]
    case let .resolved(_, bytes): return ["resolved", orNull(bytes?.base64EncodedString())]
    case let .haveChanged(keys): return ["haveChanged", keys]
    case .scheduleChanged: return ["scheduleChanged"]
    case let .serveRequest(key): return ["serveRequest", key]
    case let .serveRange(key, span): return ["serveRange", key, span.start, span.end]
    case let .uploadCancelled(bytes): return ["uploadCancelled", bytes]
    case let .progress(received, size): return ["progress", received, size]
    }
}

func snapshot(_ link: PeerLink, _ update: LinkUpdate) -> [Any] {
    let sets = link.sets()
    return [sets.have, sets.fetching.map { [$0.key, $0.at] as [Any] }, sets.renditions.map { [$0.key, $0.at] as [Any] },
            sets.serving, orNull(sets.rendition), update.busy, update.outboundInFlight, update.closed,
            update.bytesIn, update.bytesOut]
}

var link: PeerLink? = nil
var now: UInt64 = 0
var lastRequest: UInt64? = nil
var steps: [Any] = []

for field in lines {
    switch field[0] {
    case "at":
        at = Int64(field[1])!
    case "case":
        let event = text(field[2])!, options = text(field[3])!
        switch field[1] {
        case "stream": verdicts.append(validStreamAuthorisation(eventJson: event) ? "true" : "null")
        case "delegation": verdicts.append(verifyCommitmentDelegation(eventJson: event, optionsJson: options, atMs: at) ?? "null")
        default: verdicts.append(verifySegmentCommitment(eventJson: event, optionsJson: options, atMs: at) ?? "null")
        }
    case "transfer":
        print("{\"vectors\":[\(verdicts.joined(separator: ","))]}")
        transfer(field)
    case "trace":
        now = number(field[1])
        link = PeerLink(settings: LinkSettings(maxSegmentBytes: number(field[2]), maxQueuedRequests: UInt32(field[3])!,
                                               drainTimeoutMs: number(field[4]), reliable: field[5] == "1"), now: now)
        lastRequest = nil
        steps = []
    case "end":
        print(json(["steps": steps]))
    default:
        let link = link!
        var events: [PeerLinkEvent] = []
        var update: LinkUpdate
        switch field[0] {
        case "text": update = link.handleText(now: now, text: text(field[1])!)
        case "binary": update = link.handleBinary(now: now, chunk: bytes(field[1])!)
        case "request":
            update = link.request(now: now, key: text(field[1])!, timeoutMs: number(field[2]),
                                  expectedSize: field[3] == "-" ? nil : number(field[3]))
            lastRequest = update.requestId ?? lastRequest
        case "abort":
            update = lastRequest.map { link.abort(now: now, id: $0, abandoned: field[1] == "1") } ?? link.state()
        case "advance":
            let target = now + number(field[1])
            update = link.state()
            while let deadline = update.nextDeadline, deadline <= target {
                events += update.events
                now = max(now, deadline)
                update = link.tick(now: deadline)
            }
            now = target
        case "serve": update = link.serveResponse(now: now, bytes: bytes(field[1]))
        case "drain": update = link.bufferedAmountLow(now: now, buffered: 0)
        case "close": update = link.close(reason: text(field[1])!)
        case "sendHave": update = link.sendHave(keys: strings(field[1]))
        case "sendHaveChange": update = link.sendHaveChange(add: strings(field[1]), del: strings(field[2]))
        case "sendContribution": update = link.sendContribution(serving: field[1] == "1", rendition: text(field[2]))
        case "sendFetching": update = link.sendFetching(key: text(field[1])!, leaseMs: number(field[2]))
        default: fatalError("unknown input \(field[0])")
        }
        events += update.events
        steps.append([events.map(event), snapshot(link, update)])
    }
}
