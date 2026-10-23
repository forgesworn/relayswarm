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
// JSON without Foundation's serialiser, which on Linux writes some doubles as
// other numbers. Types are matched exactly, because a cast from `Any` can
// bridge an integer to a Bool on Apple platforms.
func json(_ value: Any) -> String {
    func exactly<T>(_ type: T.Type) -> Bool { Swift.type(of: value) == type }
    if let text = value as? JSONText { return text.text }
    if value is NSNull { return "null" }
    if exactly(Bool.self) { return (value as! Bool) ? "true" : "false" }
    if exactly(Double.self) { let double = value as! Double; return double.isFinite ? "\(double)" : "null" }
    if let integer = value as? any BinaryInteger { return "\(integer)" }
    if exactly(String.self) {
        var out = "\""
        // Non-ASCII as UTF-16 escapes, so the output encoding never matters.
        for unit in (value as! String).utf16 {
            switch unit {
            case 0x22: out += "\\\""
            case 0x5c: out += "\\\\"
            case 0x20...0x7e: out.unicodeScalars.append(Unicode.Scalar(unit)!)
            default:
                let hex = String(unit, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            }
        }
        return out + "\""
    }
    if let array = value as? [Any] { return "[" + array.map(json).joined(separator: ",") + "]" }
    if let object = value as? [String: Any] { return "{" + object.map { json($0.key) + ":" + json($0.value) }.joined(separator: ",") + "}" }
    fatalError("cannot write \(Swift.type(of: value))")
}
func orNull(_ value: Any?) -> Any { value ?? NSNull() }
// JSON has no infinity or NaN; JavaScript writes them as null.
// Written out here, because a Double boxed in `Any` beside Foundation values
// came back as another number on Linux.
struct JSONText { let text: String }
func finite(_ value: Double?) -> JSONText {
    guard let value, value.isFinite else { return JSONText(text: "null") }
    return JSONText(text: "\(value)")
}
func double(_ field: Substring) -> Double? { field == "-" ? nil : Double(field)! }
func hexList(_ field: Substring) -> [String] { field == "-" ? [] : field.split(separator: ",").map(String.init) }

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

func frames(_ events: [PeerLinkEvent]) -> [PeerLinkEvent] {
    events.filter {
        switch $0 {
        case .sendText, .sendBinary: return true
        default: return false
        }
    }
}

// A requester asks a holder for a run of pieces; then the channel-state calls.
func range(_ field: [Substring]) {
    let size = number(field[1])
    let object = bytes(field[2])!
    let key = String(field[3])
    let span = PieceSpan(start: UInt32(field[4])!, end: UInt32(field[5])!)
    let settings = LinkSettings(maxSegmentBytes: 8_388_608, maxQueuedRequests: 4, drainTimeoutMs: 1_000, reliable: true)
    let requester = PeerLink(settings: settings, now: 0)
    let holder = PeerLink(settings: settings, now: 0)
    var toHolder = frames(requester.requestRange(now: 0, key: key, timeoutMs: 5_000, span: span, objectSize: size).events)
    var toRequester: [PeerLinkEvent] = []
    var resolved: Data? = nil
    var done = false
    var heldBack: Bool? = nil
    for _ in 0..<64 where !done {
        for case let .sendText(text) in toHolder {
            let update = holder.handleText(now: 0, text: text)
            if update.events.contains(where: { if case .serveRange = $0 { return true }; return false }) {
                // A full send buffer: the holder sends its meta and holds the data for a drain.
                holder.observeBuffered(buffered: 200_000)
                let sent = frames(holder.serveResponse(now: 0, bytes: object).events)
                heldBack = !sent.contains { if case .sendBinary = $0 { return true }; return false }
                toRequester += sent
            }
        }
        toHolder = []
        if toRequester.isEmpty { toRequester += frames(holder.bufferedAmountLow(now: 0, buffered: 0).events) }
        for frame in toRequester {
            let update: LinkUpdate
            switch frame {
            case let .sendText(text): update = requester.handleText(now: 0, text: text)
            case let .sendBinary(bytes): update = requester.handleBinary(now: 0, chunk: bytes)
            default: fatalError("not a frame")
            }
            for case let .resolved(_, bytes) in update.events {
                resolved = bytes
                done = true
            }
        }
        toRequester = []
    }

    let quiet = PeerLink(settings: settings, now: 0)
    quiet.setChannelOpen(open: false)
    let closedSends = quiet.sendHave(keys: ["a"]).events.count
    quiet.setChannelOpen(open: true)
    let openSends = quiet.sendHave(keys: ["a"]).events.count
    func abortCloses(_ reliable: Bool) -> Bool {
        let link = PeerLink(settings: settings, now: 0)
        link.setReliable(reliable: reliable)
        let id = link.request(now: 0, key: "k", timeoutMs: 5_000, expectedSize: nil).requestId!
        return link.abort(now: 0, id: id, abandoned: false).closed
    }
    print(json(["range": orNull(resolved?.base64EncodedString()), "heldBack": orNull(heldBack), "closedSends": closedSends, "openSends": openSends,
                "unreliableAbortCloses": abortCloses(false), "reliableAbortCloses": abortCloses(true)]))
}

// Selection state after each operation, as arrays the script names.
final class SelectionRun {
    let selection = PeerSelection()
    let sizes: [Double], size: Double, count: UInt64
    var steps: [Any] = []

    init(_ field: [Substring]) {
        sizes = field[1].split(separator: ",").map { Double($0)! }
        size = Double(field[2])!
        count = number(field[3])
    }

    func apply(_ field: [Substring]) {
        var result: UInt64? = nil
        switch field[0] {
        case "noop": break
        case "observe":
            selection.observe(now: number(field[1]), firstByteMs: double(field[2]), bytes: double(field[3])!,
                              flowMs: double(field[4])!, totalFlowMs: double(field[5]))
        case "record":
            selection.record(now: number(field[1]), link: number(field[2]), elapsedMs: double(field[3])!, bytes: double(field[4])!)
        case "forget": selection.forget(link: number(field[1]))
        case "select":
            let links = hexList(field[4]).map { entry -> SelectableLink in
                let part = entry.split(separator: "/")
                return SelectableLink(id: number(part[0]), pubkey: String(part[1]), closed: part[2] == "1",
                                      busy: part[3] == "1", hasKey: part[4] == "1")
            }
            result = selection.select(links: links, tried: hexList(field[3]), size: double(field[1])!, deadlineMs: double(field[2])!)
        default: fatalError("unknown selection input \(field[0])")
        }
        let links: [Any] = (0..<count).map { link in
            let value = selection.summary(link: link)
            return [value.attempts, finite(value.latencyMs), finite(value.throughputBytesPerSecond), finite(value.failureRate),
                    value.consecutiveFailures, value.lastSelected, finite(selection.estimate(link: link, size: size))] as [Any]
        }
        steps.append([orNull(result), finite(selection.firstByteMs()), finite(selection.rate()),
                      sizes.map { finite(selection.projectMs(size: $0)) }, finite(selection.minimumMs(size: size)),
                      selection.lastObservedAt(), selection.turn(), selection.order(), links] as [Any])
    }
}

// Discovery state after each operation, as arrays the script names. Tracks
// the context last returned for each media type and the latest attempt.
final class DiscoveryRun {
    let discovery = NeighbourDiscovery()
    let peers: [String], media: [String]
    var held: [String: UInt64] = [:]
    var attempt: UInt64? = nil
    var steps: [Any] = []

    init(_ field: [Substring]) {
        peers = strings(field[1])
        media = strings(field[2])
    }

    func apply(_ field: [Substring]) {
        let now = number(field[1])
        var result: Any = NSNull()
        switch field[0] {
        case "noop": break
        case "context":
            let id = discovery.context(now: now, mediaType: text(field[2])!, rendition: text(field[3])!)
            if let id { held[text(field[2])!] = id }
            result = id != nil
        case "demand":
            if let id = discovery.demand(now: now, mediaType: text(field[2])!, rendition: text(field[3])!, key: text(field[4])!) {
                held[text(field[2])!] = id
                result = discovery.contexts().first { $0.id == id }!.keys
            }
        case "hint": discovery.hint(now: now, pubkey: text(field[2])!, have: strings(field[3]), ticket: text(field[4]))
        case "holderMiss":
            let context = held[text(field[2])!]
            discovery.holderMiss(now: now, context: context, pubkey: text(field[3])!, key: text(field[4])!)
            result = discovery.stale(now: now, context: context, pubkey: text(field[3])!)
        case "holderAhead": discovery.holderAhead(context: held[text(field[2])!], pubkey: text(field[3])!)
        case "forget": discovery.forget(pubkey: text(field[2])!)
        case "choose":
            if let found = discovery.choose(now: now, eligible: strings(field[2]), unmet: strings(field[3]), room: field[4] == "1") {
                var begun: Any = NSNull()
                if field[5] == "1" {
                    let id = discovery.begin(now: now)
                    if let id { attempt = id }
                    begun = id != nil
                }
                result = ["\(found.mediaType)", found.candidate.pubkey, found.key, begun] as [Any]
            }
        case "replaced":
            if let attempt { result = discovery.replaced(now: now, attempt: attempt, victim: text(field[2])) }
        case "allocated":
            if let attempt { discovery.allocated(attempt: attempt, dial: number(field[2])) }
        case "abandoned":
            if let attempt { discovery.abandoned(attempt: attempt) }
        case "failed": discovery.failed(dial: number(field[2]))
        case "end": result = discovery.end()
        case "verified": result = discovery.verified(context: held[text(field[2])!])
        case "clear":
            discovery.clear()
            held = [:]
            attempt = nil
        default: fatalError("unknown discovery input \(field[0])")
        }
        let window: Any = discovery.window().map { window -> Any in
            ["\(window.mediaType)", window.createdAt, window.expiresAt, window.vacant, orNull(window.victim),
             orNull(window.attempt.map { [$0.pubkey, $0.key, orNull($0.ticket), orNull($0.dial)] as [Any] })] as [Any]
        } ?? NSNull()
        let contexts: [Any] = discovery.contexts().map { context in
            ["\(context.mediaType)", context.rendition, context.keys, orNull(context.lastDemandAt), context.activityAt, context.spent,
             context.holders.map { [$0.pubkey, $0.firstMissAt, $0.misses, $0.lastKey] as [Any] }] as [Any]
        }
        let snapshot = discovery.snapshot(now: now), counters = snapshot.counters
        steps.append([
            result, orNull(attempt.map { discovery.valid(now: now, attempt: $0) }), discovery.live(now: now), discovery.reserved(now: now),
            peers.map { discovery.suppresses(now: now, pubkey: $0) },
            media.map { kind in peers.map { discovery.stale(now: now, context: held[kind], pubkey: $0) } },
            media.map { kind in orNull(held[kind].map { discovery.current(now: now, context: $0) }) },
            window, contexts, discovery.candidates().map { [$0.pubkey, $0.have, orNull($0.ticket), $0.at] as [Any] },
            [snapshot.candidates, snapshot.contexts, snapshot.requestedKeys, snapshot.replacementSpent, snapshot.opportunityActive,
             snapshot.remainingMs, snapshot.vacancyReserved,
             [counters.checks, counters.replacements, counters.expired, counters.opened, counters.verified,
              counters.staleHolder, counters.staleBlocked]] as [Any],
        ] as [Any])
    }
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
var selection: SelectionRun? = nil
var discovery: DiscoveryRun? = nil

for field in lines {
    if let run = discovery, field[0] != "discovered" {
        run.apply(field)
        continue
    }
    if let run = selection, field[0] != "selected" {
        run.apply(field)
        continue
    }
    switch field[0] {
    case "selection":
        selection = SelectionRun(field)
    case "discovery":
        discovery = DiscoveryRun(field)
    case "discovered":
        print(json(["discovery": discovery!.steps]))
        discovery = nil
    case "selected":
        print(json(["selection": selection!.steps]))
        selection = nil
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
    case "range":
        range(field)
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
        case "close": update = link.closeLink(reason: text(field[1])!)
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
