import Foundation
import CryptoKit
import RelaySwarmSignalling
import RelaySwarmTransport

// Explicit test-only version 3 adapter over the untouched pinned toolkit APIs.
// It is not a released RelaySwarmKit client or an automatic v2 downgrade bridge.
private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
private func unhex(_ string: String) -> Data? {
    guard string.count % 2 == 0 else { return nil }
    var bytes = Data(); var offset = string.startIndex
    while offset < string.endIndex {
        let end = string.index(offset, offsetBy: 2)
        guard let byte = UInt8(string[offset..<end], radix: 16) else { return nil }
        bytes.append(byte); offset = end
    }
    return bytes
}
private func json(_ object: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]), as: UTF8.self) }
private func emit(_ object: [String: Any]) { print(try! json(object)); fflush(stdout) }
private func tag(_ event: NostrEvent, _ name: String) -> String? {
    let found = event.tags.filter { $0.first == name }
    return found.count == 1 && found[0].count == 2 ? found[0][1] : nil
}
private func isHex64(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
private func quote(_ value: String) -> String {
    var result = "\""
    for character in value.unicodeScalars {
        switch character {
        case "\"": result += "\\\""
        case "\\": result += "\\\\"
        case "\n": result += "\\n"
        case "\r": result += "\\r"
        case "\t": result += "\\t"
        case "\u{8}": result += "\\b"
        case "\u{c}": result += "\\f"
        default: result.unicodeScalars.append(character)
        }
    }
    return result + "\""
}
struct Expected: Codable {
    let path: String, playlist: String, mediaType: String
    let level: Int, sequence: Int, discontinuity: Int
}
struct Case: Codable { let name: String; let event: NostrEvent; let expectedValid: Bool }
struct Configuration: Codable {
    let mode: String, relayUrl: String, swarmId: String, nodePubkey: String, commitmentUrl: String
    let streamEvent: NostrEvent, expected: Expected, cases: [Case]
}
struct Commitment: Codable {
    let domain: String, v: Int, streamEventId: String, swarmId: String, key: String, rendition: String
    let sequence: Int, discontinuity: Int, part: Int?, sha256: String, size: Int, expiresAt: Int
    let playlist: String?, mediaType: String?
    // The fixture transfers unencrypted bytes. AES/DRM are not claimed here.
    let encryption: String?
    var canonical: String {
        var pairs = ["\"domain\":\(quote(domain))", "\"v\":\(v)", "\"streamEventId\":\(quote(streamEventId))", "\"swarmId\":\(quote(swarmId))",
                     "\"key\":\(quote(key))", "\"rendition\":\(quote(rendition))", "\"sequence\":\(sequence)", "\"discontinuity\":\(discontinuity)",
                     "\"part\":\(part.map(String.init) ?? "null")", "\"sha256\":\(quote(sha256))", "\"size\":\(size)", "\"expiresAt\":\(expiresAt)"]
        if v == 2 { pairs += ["\"playlist\":\(quote(playlist ?? ""))", "\"mediaType\":\(quote(mediaType ?? ""))", "\"encryption\":null"] }
        return "{" + pairs.joined(separator: ",") + "}"
    }
}
private func verifyCommitment(_ event: NostrEvent, config: Configuration) -> Commitment? {
    let now = Int(Date().timeIntervalSince1970), authorisation = config.streamEvent
    guard authorisation.isValid, authorisation.kind == 30311, tag(authorisation, "d") != nil,
          authorisation.tags.contains(["relayswarm", "redistribute", "1"]), event.isValid, event.kind == 24172,
          event.pubkey == authorisation.pubkey, event.createdAt >= now - 120, event.createdAt <= now + 30,
          event.content.utf8.count <= 16384, tag(event, "x") == config.swarmId, tag(event, "e") == authorisation.id,
          let value = try? JSONDecoder().decode(Commitment.self, from: Data(event.content.utf8)), event.content == value.canonical,
          [1, 2].contains(value.v), value.domain == "relayswarm-segment-v\(value.v)", value.streamEventId == authorisation.id, value.swarmId == config.swarmId,
          value.key == hex(Data(SHA256.hash(data: Data("\(config.swarmId)\n\(config.expected.path)".utf8)))),
          value.sequence == config.expected.sequence, value.discontinuity == config.expected.discontinuity, value.part == nil,
          value.sequence >= 0, value.discontinuity >= 0, isHex64(value.sha256), value.size > 0, value.size <= 1024 * 1024,
          value.expiresAt > now, value.expiresAt <= now + 300 else { return nil }
    if value.v == 1 {
        guard value.rendition == String(config.expected.level) else { return nil }
    } else {
        guard value.rendition == config.expected.playlist, value.playlist == config.expected.playlist,
              value.mediaType == config.expected.mediaType, value.encryption == nil else { return nil }
    }
    return value
}

actor StockCounter { var signals = 0; func received() { signals += 1 } }
private func stock(_ config: Configuration, keys: NostrKeys, pool: RelayPool) async throws {
    let signaller = SwarmSignaller(keys: keys, pool: pool, swarmID: config.swarmId)
    let signals = await signaller.signals(), counter = StockCounter()
    let listener = Task { for await _ in signals { await counter.received() } }
    try await signaller.announcePresence(role: "watcher")
    emit(["type": "stock-ready", "pubkey": keys.publicKey])
    try await signaller.send(type: "offer", sdp: "stock-swift-v2-private-sdp", to: config.nodePubkey)
    try await Task.sleep(for: .milliseconds(1200))
    emit(["type": "stock-receipt", "v3SignalsAccepted": await counter.signals, "kitWireVersion": 2])
    listener.cancel(); await pool.close()
}

actor Adapter {
    let config: Configuration, keys: NostrKeys, pool: RelayPool, commitment: Commitment
    var peer: PeerConnection?, channel: DataChannel?, tasks: [Task<Void, Never>] = []
    var completed: [String: Any]?, sawPresence = false, sentWant = false, headerSeen = false, chunks = 0
    var bytes = Data(), requestID = "", invalidSignalsRejected = 0
    init(config: Configuration, keys: NostrKeys, pool: RelayPool, commitment: Commitment) {
        self.config = config; self.keys = keys; self.pool = pool; self.commitment = commitment
    }
    func run() async throws {
        let presence = await pool.subscribe([NostrFilter(kinds: [24170], tags: ["x": [config.swarmId]])])
        let signals = await pool.subscribe([NostrFilter(kinds: [24171], tags: ["x": [config.swarmId], "p": [keys.publicKey]])])
        tasks.append(Task { for await event in presence { self.receivePresence(event) } })
        tasks.append(Task { for await event in signals { await self.receiveSignal(event) } })
        let content = try json(["v": 3, "role": "watcher", "transports": [["type": "webrtc", "publicKey": keys.publicKey]], "have": []])
        try await pool.publish(NostrEvent.signed(kind: 24170, tags: [["x", config.swarmId]], content: content, keys: keys))
        emit(["type": "adapter-ready", "pubkey": keys.publicKey])
        let deadline = Date().addingTimeInterval(30)
        while completed == nil && Date() < deadline { try await Task.sleep(for: .milliseconds(25)) }
        if completed == nil { completed = ["type": "adapter-receipt", "ok": false, "error": "fixture deadline"] }
        emit(completed!)
        for task in tasks { task.cancel() }
        peer?.close(); peer = nil; channel = nil; await pool.close()
    }
    func receivePresence(_ event: NostrEvent) {
        guard event.isValid, event.pubkey == config.nodePubkey, tag(event, "x") == config.swarmId,
              let object = try? JSONSerialization.jsonObject(with: Data(event.content.utf8)) as? [String: Any],
              (object["v"] as? Int) == 3, object["role"] as? String == "seeder",
              let have = object["have"] as? [String], have.count <= 32, have.contains(commitment.key),
              let transports = object["transports"] as? [[String: String]], transports.contains(["type": "webrtc", "publicKey": config.nodePubkey]) else { return }
        sawPresence = true
    }
    func receiveSignal(_ event: NostrEvent) async {
        let now = Int64(Date().timeIntervalSince1970)
        guard event.isValid, event.pubkey == config.nodePubkey, event.createdAt >= now - 120, event.createdAt <= now + 30,
              event.content.utf8.count <= 65536, tag(event, "x") == config.swarmId, tag(event, "p") == keys.publicKey,
              let peerKey = unhex(event.pubkey), let conversation = try? NIP44.conversationKey(secretKey: keys.secretKey, peerXOnly: peerKey),
              let plaintext = try? NIP44.decrypt(event.content, conversationKey: conversation), plaintext.utf8.count <= 8192,
              let envelope = try? JSONSerialization.jsonObject(with: Data(plaintext.utf8)) as? [String: Any],
              envelope["v"] as? Int == 3, envelope["type"] as? String == "offer", envelope["transport"] as? String == "webrtc",
              let request = envelope["requestId"] as? String, request.range(of: "^[a-zA-Z0-9_-]{8,64}$", options: .regularExpression) != nil,
              let payload = envelope["payload"] as? [String: Any], let sdp = payload["sdp"] as? String, !sdp.isEmpty, peer == nil, sawPresence else {
            invalidSignalsRejected += 1; return
        }
        requestID = request
        let connection = PeerConnection(stunServers: []); peer = connection
        connection.onGatheredDescription = { sdp, type in
            guard type == .answer else { return }
            Task { await self.sendAnswer(sdp) }
        }
        connection.onDataChannel = { channel in Task { await self.adopt(channel) } }
        connection.setRemote(sdp, type: .offer)
    }
    func sendAnswer(_ sdp: String) async {
        do {
            let key = try NIP44.conversationKey(secretKey: keys.secretKey, peerXOnly: unhex(config.nodePubkey)!)
            let envelope = try json(["v": 3, "type": "answer", "transport": "webrtc", "requestId": requestID, "payload": ["sdp": sdp]])
            let ciphertext = try NIP44.encrypt(envelope, conversationKey: key)
            try await pool.publish(NostrEvent.signed(kind: 24171, tags: [["x", config.swarmId], ["p", config.nodePubkey]], content: ciphertext, keys: keys))
        } catch { completed = ["type": "adapter-receipt", "ok": false, "error": "answer publish failed"] }
    }
    func adopt(_ value: DataChannel) {
        channel = value
        let frames = AsyncStream<DataChannel.Message>(bufferingPolicy: .bufferingOldest(256)) { continuation in
            value.onMessage = { message in continuation.yield(message) }
            value.onClosed = { continuation.finish() }
        }
        tasks.append(Task { for await message in frames { self.receiveMessage(message) } })
    }
    func receiveMessage(_ message: DataChannel.Message) {
        guard completed == nil else { return }
        switch message {
        case .text(let text):
            guard text.utf8.count <= 65536, let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
            if object["t"] as? String == "have", let keys = object["keys"] as? [String], keys.count <= 256, keys.contains(commitment.key), !sentWant {
                sentWant = true
                guard channel?.send(try! json(["t": "want", "id": 1, "k": commitment.key])) == true else { return }
            } else if object["t"] as? String == "meta", object["id"] as? Int == 1, object["size"] as? Int == commitment.size, sentWant, !headerSeen {
                headerSeen = true; bytes.reserveCapacity(commitment.size)
            } else if object["t"] as? String == "eof", object["id"] as? Int == 1, headerSeen {
                let digest = hex(Data(SHA256.hash(data: bytes))), valid = bytes.count == commitment.size && digest == commitment.sha256
                completed = ["type": "adapter-receipt", "ok": valid, "integrityRejected": !valid, "objectBytes": bytes.count, "chunks": chunks,
                             "sha256Verified": valid, "presenceVerified": sawPresence, "commitmentVerified": true, "commitmentSchema": commitment.v,
                             "wireVersion": 3, "transport": "webrtc-libdatachannel", "invalidSignalsRejected": invalidSignalsRejected]
            }
        case .binary(let data):
            guard sentWant, headerSeen, !data.isEmpty, data.count <= 16384, chunks < 256, bytes.count + data.count <= commitment.size else {
                completed = ["type": "adapter-receipt", "ok": false, "error": "invalid frame bounds"]; return
            }
            bytes += data; chunks += 1
        }
    }
}

@main struct InteropHarness {
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { fatalError("One fixture configuration path is required") }
        let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let keys = NostrKeys.generate()
        let pool = RelayPool(connections: [RelayConnection(transport: WebSocketRelayTransport(url: URL(string: config.relayUrl)!))])
        try await pool.connect()
        if config.mode == "stock" { try await stock(config, keys: keys, pool: pool); return }
        for value in config.cases {
            let valid = verifyCommitment(value.event, config: config) != nil
            guard valid == value.expectedValid else { fatalError("Commitment conformance failed: \(value.name)") }
        }
        emit(["type": "commitment-conformance", "cases": config.cases.count, "ok": true])
        let (data, _) = try await URLSession.shared.data(from: URL(string: config.commitmentUrl)!)
        guard data.count <= 16384, let event = try? JSONDecoder().decode(NostrEvent.self, from: data), let commitment = verifyCommitment(event, config: config) else { fatalError("Origin commitment verification failed") }
        try await Adapter(config: config, keys: keys, pool: pool, commitment: commitment).run()
    }
}
