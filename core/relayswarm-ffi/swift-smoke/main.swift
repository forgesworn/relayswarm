// Calls the core through the generated Swift bindings and prints one JSON
// line per result, which scripts/ffi-swift-smoke.mjs checks.
import Foundation

func text(_ value: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), encoding: .utf8)!
}

let input = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
let at = (input["at"] as! NSNumber).int64Value
var results: [String] = []
for entry in input["cases"] as! [[String: Any]] {
    let event = text(entry["event"] ?? NSNull())
    switch entry["op"] as! String {
    case "stream":
        results.append(validStreamAuthorisation(eventJson: event) ? "true" : "null")
    case "delegation":
        results.append(verifyCommitmentDelegation(eventJson: event, optionsJson: text(entry["options"]!), atMs: at) ?? "null")
    default:
        results.append(verifySegmentCommitment(eventJson: event, optionsJson: text(entry["options"]!), atMs: at) ?? "null")
    }
}
print("{\"vectors\":[\(results.joined(separator: ","))]}")

// One origin and one holder that answers pieces in 40 ms; origin in 30 ms.
let transferInput = input["transfer"] as! [String: Any]
let size = (transferInput["size"] as! NSNumber).uint64Value
let object = Data((transferInput["object"] as! String).utf8)
let bytes = Data(base64Encoded: object)!
let transfer = try! Transfer(settings: TransferSettings(maxHolders: defaultTransferSettings().maxHolders, originReserveMs: 0),
                             size: size, sha256: transferInput["sha256"] as! String,
                             pieces: transferInput["pieces"] as! [String], deadline: 4_000)
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
                                       bytes: bytes.subdata(in: Int(range.from)..<Int(range.to))))
}
print(text(["log": log, "delivered": (delivered?.base64EncodedString() as Any?) ?? NSNull()]))
