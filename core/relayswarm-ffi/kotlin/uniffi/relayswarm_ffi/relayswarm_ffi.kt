package uniffi.relayswarm_ffi

import java.nio.ByteBuffer
import java.nio.ByteOrder

private data class JsonNumber(val text: String)

private fun json(value: Any?): String = when (value) {
    null -> "null"
    is String -> buildString {
        append('"')
        for (char in value) when {
            char == '"' -> append("\\\"")
            char == '\\' -> append("\\\\")
            char == '\b' -> append("\\b")
            char == '\u000c' -> append("\\f")
            char == '\n' -> append("\\n")
            char == '\r' -> append("\\r")
            char == '\t' -> append("\\t")
            char.code < 0x20 -> append("\\u%04x".format(char.code))
            else -> append(char)
        }
        append('"')
    }
    is Boolean, is Int, is Long, is UInt, is ULong, is JsonNumber -> value.toString()
    is Double -> if (value.isFinite()) value.toString() else json(value.toString())
    is Float -> json(value.toDouble())
    is ByteArray -> value.joinToString(",", "[", "]") { (it.toInt() and 255).toString() }
    is List<*> -> value.joinToString(",", "[", "]") { json(it) }
    is Array<*> -> value.joinToString(",", "[", "]") { json(it) }
    is Map<*, *> -> value.entries.joinToString(",", "{", "}") { json(it.key as String) + ":" + json(it.value) }
    else -> error("Cannot encode ${value.javaClass.name} as JSON")
}

private class JsonParser(text: String) {
    private val text = text
    private var at = 0

    fun parse(): Any? = value().also {
        space()
        check(at == text.length) { "Trailing JSON input" }
    }

    private fun space() { while (at < text.length && text[at].isWhitespace()) at++ }
    private fun take(char: Char) { space(); check(text.getOrNull(at) == char) { "Invalid JSON at $at" }; at++ }
    private fun word(word: String) { check(text.regionMatches(at, word, 0, word.length)) { "Invalid JSON at $at" }; at += word.length }

    private fun value(): Any? {
        space()
        return when (text.getOrNull(at)) {
            'n' -> word("null").let { null }
            't' -> word("true").let { true }
            'f' -> word("false").let { false }
            '"' -> string()
            '[' -> list()
            '{' -> map()
            else -> number()
        }
    }

    private fun string(): String {
        take('"')
        val out = StringBuilder()
        while (true) {
            val char = text.getOrNull(at++) ?: error("Unterminated JSON string")
            when (char) {
                '"' -> return out.toString()
                '\\' -> when (val escape = text.getOrNull(at++) ?: error("Unterminated JSON escape")) {
                    '"', '\\', '/' -> out.append(escape)
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000c')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        check(at + 4 <= text.length) { "Invalid JSON Unicode escape" }
                        out.append(text.substring(at, at + 4).toInt(16).toChar())
                        at += 4
                    }
                    else -> error("Invalid JSON escape")
                }
                else -> out.append(char)
            }
        }
    }

    private fun number(): JsonNumber {
        val start = at
        while (at < text.length && text[at] in "-+0123456789.eE") at++
        check(at > start) { "Invalid JSON value at $at" }
        return JsonNumber(text.substring(start, at))
    }

    private fun list(): List<Any?> {
        take('[')
        val out = mutableListOf<Any?>()
        space()
        if (text.getOrNull(at) == ']') { at++; return out }
        while (true) {
            out += value()
            space()
            when (text.getOrNull(at++)) {
                ',' -> {}
                ']' -> return out
                else -> error("Invalid JSON array at $at")
            }
        }
    }

    private fun map(): Map<String, Any?> {
        take('{')
        val out = linkedMapOf<String, Any?>()
        space()
        if (text.getOrNull(at) == '}') { at++; return out }
        while (true) {
            val key = string()
            take(':')
            out[key] = value()
            space()
            when (text.getOrNull(at++)) {
                ',' -> {}
                '}' -> return out
                else -> error("Invalid JSON object at $at")
            }
        }
    }
}

private fun decode(bytes: ByteArray): Any? = JsonParser(String(bytes, Charsets.UTF_8)).parse()
@Suppress("UNCHECKED_CAST") private fun objectValue(value: Any?): Map<String, Any?> = value as Map<String, Any?>
@Suppress("UNCHECKED_CAST") private fun arrayValue(value: Any?): List<Any?> = value as List<Any?>
private fun field(value: Any?, name: String): Any? = objectValue(value)[name]
private fun stringValue(value: Any?): String = value as String
private fun boolValue(value: Any?): Boolean = value as Boolean
private fun numberValue(value: Any?): JsonNumber = when (value) {
    is JsonNumber -> value
    is String -> JsonNumber(value)
    else -> error("Expected a number")
}
private fun u32(value: Any?): UInt = numberValue(value).text.toUInt()
private fun u64(value: Any?): ULong = numberValue(value).text.toULong()
private fun i64(value: Any?): Long = numberValue(value).text.toLong()
private fun doubleValue(value: Any?): Double = numberValue(value).text.toDouble()
private fun stringOrNull(value: Any?): String? = value?.let(::stringValue)
private fun u64OrNull(value: Any?): ULong? = value?.let(::u64)
private fun doubleOrNull(value: Any?): Double? = value?.let(::doubleValue)
private fun dataValue(value: Any?): ByteArray = ByteArray(arrayValue(value).size) { u32(arrayValue(value)[it]).toByte() }
private fun dataOrNull(value: Any?): ByteArray? = value?.let(::dataValue)

private class BinaryReader(bytes: ByteArray) {
    private val input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    fun u8(): Int = input.get().toInt() and 255
    fun bool(): Boolean = u8() != 0
    fun u32(): UInt = input.int.toUInt()
    fun u64(): ULong = input.long.toULong()
    fun bytes(): ByteArray {
        val len = u64().toInt()
        check(len <= input.remaining()) { "Invalid native byte length" }
        return ByteArray(len).also { input.get(it) }
    }
    fun string(): String = String(bytes(), Charsets.UTF_8)
    fun optionalU64(): ULong? = if (bool()) u64() else null
    fun optionalBytes(): ByteArray? = if (bool()) bytes() else null
    fun optionalString(): String? = if (bool()) string() else null
    fun span() = PieceSpan(u32(), u32())
    fun done() { check(!input.hasRemaining()) { "Trailing native record bytes" } }
}

private fun transferStateBinary(bytes: ByteArray): TransferState {
    val input = BinaryReader(bytes)
    val commands = List(input.u32().toInt()) {
        when (val tag = input.u8()) {
            0 -> TransferCommand.Request(input.u64(), input.span())
            1 -> TransferCommand.FetchOrigin(input.span())
            2 -> TransferCommand.Cancel(input.u64())
            3 -> TransferCommand.Abandon(input.u64())
            4 -> TransferCommand.Ban(input.u64())
            5 -> TransferCommand.Deliver(input.bytes())
            6 -> TransferCommand.Fail
            else -> error("Unknown TransferCommand tag $tag")
        }
    }
    val state = TransferState(commands, input.optionalU64(), input.bool(), input.bool(), input.u64())
    input.done()
    return state
}

private fun linkUpdateBinary(bytes: ByteArray): LinkUpdate {
    val input = BinaryReader(bytes)
    val events = List(input.u32().toInt()) {
        when (val tag = input.u8()) {
            0 -> PeerLinkEvent.SendText(input.string())
            1 -> PeerLinkEvent.SendBinary(input.bytes())
            2 -> PeerLinkEvent.Closed(input.string())
            3 -> PeerLinkEvent.Report(RequestReport(input.optionalU64(), RequestOutcome.entries[input.u8()], input.u64(), input.bool(), input.bool(), input.optionalString()))
            4 -> PeerLinkEvent.Resolved(input.optionalU64(), input.optionalBytes())
            5 -> PeerLinkEvent.HaveChanged(List(input.u32().toInt()) { input.string() })
            6 -> PeerLinkEvent.ScheduleChanged
            7 -> PeerLinkEvent.ServeRequest(input.string())
            8 -> PeerLinkEvent.ServeRange(input.string(), input.span())
            9 -> PeerLinkEvent.UploadCancelled(input.u64())
            10 -> PeerLinkEvent.Progress(input.u64(), input.u64())
            else -> error("Unknown PeerLinkEvent tag $tag")
        }
    }
    val update = LinkUpdate(events, input.optionalU64(), input.u64(), input.bool(), input.bool(), input.bool(), input.u32(), input.u64(), input.u64(), input.u64(), input.u64(), input.u64(), input.optionalU64(), input.bool())
    input.done()
    return update
}

private object Native {
    init {
        System.loadLibrary("relayswarm_ffi")
        System.loadLibrary("relayswarm_jni")
        check(abiVersion() == 2) { "Unsupported RelaySwarm ABI version: ${abiVersion()}" }
    }
    @JvmStatic external fun abiVersion(): Int
    @JvmStatic external fun call(name: ByteArray, args: ByteArray): ByteArray
    @JvmStatic external fun new(name: ByteArray, args: ByteArray): Long
    @JvmStatic external fun method(handle: Long, name: ByteArray, args: ByteArray): ByteArray
    @JvmStatic external fun transferStart(handle: Long, now: Long, peers: LongArray, timings: DoubleArray, present: BooleanArray, origin: DoubleArray, shared: DoubleArray, originPresent: BooleanArray, sharedPresent: BooleanArray): ByteArray
    @JvmStatic external fun peerLinkHandleText(handle: Long, now: Long, text: ByteArray): ByteArray
    @JvmStatic external fun peerLinkServeResponse(handle: Long, now: Long, bytes: ByteArray?): ByteArray
    @JvmStatic external fun peerLinkSendHave(handle: Long, keys: Array<ByteArray>): ByteArray
    @JvmStatic external fun peerSelectionOrder(handle: Long): Long
    @JvmStatic external fun free(handle: Long)
}

private fun call(name: String, args: Map<String, Any?> = emptyMap()): Any? =
    decode(Native.call(name.toByteArray(Charsets.UTF_8), json(args).toByteArray(Charsets.UTF_8)))

interface Disposable {
    fun destroy()
    companion object {
        fun destroy(vararg args: Any?) {
            for (arg in args) when (arg) {
                is Disposable -> arg.destroy()
                is ArrayList<*> -> for (element in arg) if (element is Disposable) element.destroy()
                is Map<*, *> -> for (element in arg.values) if (element is Disposable) element.destroy()
                is Iterable<*> -> for (element in arg) if (element is Disposable) element.destroy()
            }
        }
    }
}

inline fun <T : Disposable?, R> T.use(block: (T) -> R) = try { block(this) } finally {
    try { this?.destroy() } catch (_: Throwable) {}
}

object NoPointer

sealed class CoreException : Exception() {
    class InvalidTransfer : CoreException() { override val message: String get() = "" }
}

abstract class NativeObject internal constructor(handle: Long) : Disposable, AutoCloseable {
    private var handle = handle
    internal fun invoke(name: String, args: Map<String, Any?> = emptyMap()): Any? = synchronized(this) {
        check(handle != 0L) { "${javaClass.simpleName} object has already been destroyed" }
        decode(Native.method(handle, name.toByteArray(Charsets.UTF_8), json(args).toByteArray(Charsets.UTF_8)))
    }
    internal fun <T> fast(block: (Long) -> T): T = synchronized(this) {
        check(handle != 0L) { "${javaClass.simpleName} object has already been destroyed" }
        block(handle)
    }
    @Synchronized override fun destroy() {
        if (handle != 0L) { Native.free(handle); handle = 0L }
    }
    @Synchronized override fun close() = destroy()
    @JvmName("finalize") protected fun finalizeRelaySwarm() = close()
}

private fun construct(name: String, args: Map<String, Any?> = emptyMap()): Long =
    Native.new(name.toByteArray(Charsets.UTF_8), json(args).toByteArray(Charsets.UTF_8))

data class PieceSpan(val start: UInt, val end: UInt)
data class ByteSpan(val from: ULong, val to: ULong)
data class Timing(val firstByteMs: Double?, val rate: Double?)
data class PeerTiming(val peer: ULong, val timing: Timing)
data class TransferSettings(val maxHolders: UInt, val originReserveMs: Double)
data class TransferState(val commands: List<TransferCommand>, val nextDeadline: ULong?, val late: Boolean, val finished: Boolean, val verifiedBytes: ULong)
data class LinkLimits(val chunkBytes: ULong, val highWaterBytes: ULong, val lowWaterBytes: ULong, val maxHaveKeys: UInt)
data class LinkSettings(val maxSegmentBytes: ULong, val maxQueuedRequests: UInt, val drainTimeoutMs: ULong, val reliable: Boolean)
data class RequestReport(val id: ULong?, val outcome: RequestOutcome, val receivedBytes: ULong, val metadataReceived: Boolean, val draining: Boolean, val closeReason: String?)
data class LinkUpdate(val events: List<PeerLinkEvent>, val requestId: ULong?, val version: ULong, val closed: Boolean, val busy: Boolean, val transferring: Boolean, val outboundInFlight: UInt, val bytesIn: ULong, val bytesOut: ULong, val openedAt: ULong, val lastServedAt: ULong, val lastDeliveredAt: ULong, val nextDeadline: ULong?, val uploadWaiting: Boolean)
data class TimedKey(val key: String, val at: ULong)
data class LinkSets(val have: List<String>, val fetching: List<TimedKey>, val renditions: List<TimedKey>, val serving: Boolean, val rendition: String?, val contributionAt: ULong, val closeReason: String?)
data class SelectableLink(val id: ULong, val pubkey: String, val closed: Boolean, val busy: Boolean, val hasKey: Boolean)
data class LinkObservation(val attempts: UInt, val latencyMs: Double?, val throughputBytesPerSecond: Double?, val failureRate: Double, val consecutiveFailures: UInt, val lastSelected: ULong)
data class DiscoveryHolder(val pubkey: String, val firstMissAt: ULong, val misses: UInt, val lastKey: String)
data class DiscoveryContext(val id: ULong, val mediaType: DiscoveryMedia, val rendition: String, val keys: List<String>, val lastDemandAt: ULong?, val activityAt: ULong, val spent: Boolean, val holders: List<DiscoveryHolder>)
data class DiscoveryCandidate(val pubkey: String, val have: List<String>, val ticket: String?, val at: ULong)
data class DiscoveryAttempt(val id: ULong, val pubkey: String, val ticket: String?, val key: String, val dial: ULong?)
data class DiscoveryWindow(val id: ULong, val context: ULong, val mediaType: DiscoveryMedia, val createdAt: ULong, val expiresAt: ULong, val attempt: DiscoveryAttempt?, val vacant: Boolean, val victim: String?)
data class FoundHolder(val context: ULong, val mediaType: DiscoveryMedia, val candidate: DiscoveryCandidate, val key: String)
data class DiscoveryCounters(val checks: ULong, val replacements: ULong, val expired: ULong, val opened: ULong, val verified: ULong, val staleHolder: ULong, val staleBlocked: ULong, val heldMiss: ULong, val rearmed: ULong, val victimUnhelpful: ULong, val victimServing: ULong, val victimConsumer: ULong, val unmetNoHint: ULong, val unmetIneligible: ULong)
data class DiscoverySnapshot(val candidates: UInt, val contexts: UInt, val requestedKeys: UInt, val replacementSpent: UInt, val replacementRearmMs: ULong, val opportunityActive: Boolean, val remainingMs: ULong, val vacancyReserved: Boolean, val counters: DiscoveryCounters)
data class PlayerSupply(val rendition: String, val size: ULong?, val peers: List<PeerTiming>, val origin: Timing?, val shared: Timing, val availableMs: Double, val maxHolders: UInt)
data class PlayerSupplyHint(val rendition: String, val eligibleHolders: UInt, val projectedMs: Double?)

sealed class TransferSource {
    data class Peer(val peer: ULong) : TransferSource()
    object Origin : TransferSource()
}
sealed class TransferCommand {
    data class Request(val peer: ULong, val span: PieceSpan) : TransferCommand()
    data class FetchOrigin(val span: PieceSpan) : TransferCommand()
    data class Cancel(val peer: ULong) : TransferCommand()
    data class Abandon(val peer: ULong) : TransferCommand()
    data class Ban(val peer: ULong) : TransferCommand()
    data class Deliver(val bytes: ByteArray) : TransferCommand()
    object Fail : TransferCommand()
}
enum class RequestOutcome { PAYLOAD, NONE, TIMEOUT, ABORT, ABANDONED, CLOSED, BUSY, SEND_ERROR }
sealed class PeerLinkEvent {
    data class SendText(val text: String) : PeerLinkEvent()
    data class SendBinary(val bytes: ByteArray) : PeerLinkEvent()
    data class Closed(val reason: String) : PeerLinkEvent()
    data class Report(val report: RequestReport) : PeerLinkEvent()
    data class Resolved(val id: ULong?, val bytes: ByteArray?) : PeerLinkEvent()
    data class HaveChanged(val keys: List<String>) : PeerLinkEvent()
    object ScheduleChanged : PeerLinkEvent()
    data class ServeRequest(val key: String) : PeerLinkEvent()
    data class ServeRange(val key: String, val span: PieceSpan) : PeerLinkEvent()
    data class UploadCancelled(val bytes: ULong) : PeerLinkEvent()
    data class Progress(val received: ULong, val size: ULong) : PeerLinkEvent()
}
enum class DiscoveryMedia { MAIN, AUDIO }
sealed class PlayerCommand { data class PlayerHint(val hint: PlayerSupplyHint) : PlayerCommand() }

private fun span(value: Any?) = objectValue(value).let { PieceSpan(u32(it["start"]), u32(it["end"])) }
private fun spanJson(value: PieceSpan) = mapOf("start" to value.start, "end" to value.end)
private fun timing(value: Any?) = objectValue(value).let { Timing(doubleOrNull(it["first_byte_ms"]), doubleOrNull(it["rate"])) }
private fun timingJson(value: Timing) = mapOf("first_byte_ms" to value.firstByteMs, "rate" to value.rate)
private fun peerTiming(value: Any?) = objectValue(value).let { PeerTiming(u64(it["peer"]), timing(it["timing"])) }
private fun peerTimingJson(value: PeerTiming) = mapOf("peer" to value.peer, "timing" to timingJson(value.timing))
private fun settingsJson(value: TransferSettings) = mapOf("max_holders" to value.maxHolders, "origin_reserve_ms" to value.originReserveMs)
private fun linkSettingsJson(value: LinkSettings) = mapOf("max_segment_bytes" to value.maxSegmentBytes, "max_queued_requests" to value.maxQueuedRequests, "drain_timeout_ms" to value.drainTimeoutMs, "reliable" to value.reliable)
private fun sourceJson(value: TransferSource): Any = when (value) {
    is TransferSource.Peer -> mapOf("Peer" to mapOf("peer" to value.peer))
    TransferSource.Origin -> "Origin"
}
private fun outcome(value: Any?): RequestOutcome = when (stringValue(value)) {
    "Payload" -> RequestOutcome.PAYLOAD
    "None" -> RequestOutcome.NONE
    "Timeout" -> RequestOutcome.TIMEOUT
    "Abort" -> RequestOutcome.ABORT
    "Abandoned" -> RequestOutcome.ABANDONED
    "Closed" -> RequestOutcome.CLOSED
    "Busy" -> RequestOutcome.BUSY
    "SendError" -> RequestOutcome.SEND_ERROR
    else -> error("Unknown RequestOutcome")
}
private fun report(value: Any?) = objectValue(value).let { RequestReport(u64OrNull(it["id"]), outcome(it["outcome"]), u64(it["received_bytes"]), boolValue(it["metadata_received"]), boolValue(it["draining"]), stringOrNull(it["close_reason"])) }
private fun command(value: Any?): TransferCommand = when (value) {
    is String -> if (value == "Fail") TransferCommand.Fail else error("Unknown TransferCommand")
    else -> objectValue(value).entries.single().let { (tag, body) ->
        val item = objectValue(body)
        when (tag) {
            "Request" -> TransferCommand.Request(u64(item["peer"]), span(item["span"]))
            "FetchOrigin" -> TransferCommand.FetchOrigin(span(item["span"]))
            "Cancel" -> TransferCommand.Cancel(u64(item["peer"]))
            "Abandon" -> TransferCommand.Abandon(u64(item["peer"]))
            "Ban" -> TransferCommand.Ban(u64(item["peer"]))
            "Deliver" -> TransferCommand.Deliver(dataValue(item["bytes"]))
            else -> error("Unknown TransferCommand")
        }
    }
}
private fun transferState(value: Any?) = objectValue(value).let { TransferState(arrayValue(it["commands"]).map(::command), u64OrNull(it["next_deadline"]), boolValue(it["late"]), boolValue(it["finished"]), u64(it["verified_bytes"])) }
private fun event(value: Any?): PeerLinkEvent = when (value) {
    is String -> if (value == "ScheduleChanged") PeerLinkEvent.ScheduleChanged else error("Unknown PeerLinkEvent")
    else -> objectValue(value).entries.single().let { (tag, body) ->
        val item = objectValue(body)
        when (tag) {
            "SendText" -> PeerLinkEvent.SendText(stringValue(item["text"]))
            "SendBinary" -> PeerLinkEvent.SendBinary(dataValue(item["bytes"]))
            "Closed" -> PeerLinkEvent.Closed(stringValue(item["reason"]))
            "Report" -> PeerLinkEvent.Report(report(item["report"]))
            "Resolved" -> PeerLinkEvent.Resolved(u64OrNull(item["id"]), dataOrNull(item["bytes"]))
            "HaveChanged" -> PeerLinkEvent.HaveChanged(arrayValue(item["keys"]).map(::stringValue))
            "ServeRequest" -> PeerLinkEvent.ServeRequest(stringValue(item["key"]))
            "ServeRange" -> PeerLinkEvent.ServeRange(stringValue(item["key"]), span(item["span"]))
            "UploadCancelled" -> PeerLinkEvent.UploadCancelled(u64(item["bytes"]))
            "Progress" -> PeerLinkEvent.Progress(u64(item["received"]), u64(item["size"]))
            else -> error("Unknown PeerLinkEvent")
        }
    }
}
private fun linkUpdate(value: Any?) = objectValue(value).let { LinkUpdate(arrayValue(it["events"]).map(::event), u64OrNull(it["request_id"]), u64(it["version"]), boolValue(it["closed"]), boolValue(it["busy"]), boolValue(it["transferring"]), u32(it["outbound_in_flight"]), u64(it["bytes_in"]), u64(it["bytes_out"]), u64(it["opened_at"]), u64(it["last_served_at"]), u64(it["last_delivered_at"]), u64OrNull(it["next_deadline"]), boolValue(it["upload_waiting"])) }
private fun timedKey(value: Any?) = objectValue(value).let { TimedKey(stringValue(it["key"]), u64(it["at"])) }
private fun linkSets(value: Any?) = objectValue(value).let { LinkSets(arrayValue(it["have"]).map(::stringValue), arrayValue(it["fetching"]).map(::timedKey), arrayValue(it["renditions"]).map(::timedKey), boolValue(it["serving"]), stringOrNull(it["rendition"]), u64(it["contribution_at"]), stringOrNull(it["close_reason"])) }
private fun observation(value: Any?) = objectValue(value).let { LinkObservation(u32(it["attempts"]), doubleOrNull(it["latency_ms"]), doubleOrNull(it["throughput_bytes_per_second"]), doubleValue(it["failure_rate"]), u32(it["consecutive_failures"]), u64(it["last_selected"])) }
private fun media(value: Any?): DiscoveryMedia = if (stringValue(value) == "Main") DiscoveryMedia.MAIN else DiscoveryMedia.AUDIO
private fun candidate(value: Any?) = objectValue(value).let { DiscoveryCandidate(stringValue(it["pubkey"]), arrayValue(it["have"]).map(::stringValue), stringOrNull(it["ticket"]), u64(it["at"])) }
private fun holder(value: Any?) = objectValue(value).let { DiscoveryHolder(stringValue(it["pubkey"]), u64(it["first_miss_at"]), u32(it["misses"]), stringValue(it["last_key"])) }
private fun context(value: Any?) = objectValue(value).let { DiscoveryContext(u64(it["id"]), media(it["media_type"]), stringValue(it["rendition"]), arrayValue(it["keys"]).map(::stringValue), u64OrNull(it["last_demand_at"]), u64(it["activity_at"]), boolValue(it["spent"]), arrayValue(it["holders"]).map(::holder)) }
private fun attempt(value: Any?) = objectValue(value).let { DiscoveryAttempt(u64(it["id"]), stringValue(it["pubkey"]), stringOrNull(it["ticket"]), stringValue(it["key"]), u64OrNull(it["dial"])) }
private fun found(value: Any?) = objectValue(value).let { FoundHolder(u64(it["context"]), media(it["media_type"]), candidate(it["candidate"]), stringValue(it["key"])) }
private fun counters(value: Any?) = objectValue(value).let { DiscoveryCounters(u64(it["checks"]), u64(it["replacements"]), u64(it["expired"]), u64(it["opened"]), u64(it["verified"]), u64(it["stale_holder"]), u64(it["stale_blocked"]), u64(it["held_miss"]), u64(it["rearmed"]), u64(it["victim_unhelpful"]), u64(it["victim_serving"]), u64(it["victim_consumer"]), u64(it["unmet_no_hint"]), u64(it["unmet_ineligible"])) }

interface TransferInterface {
    fun start(now: ULong, peers: List<PeerTiming>, origin: Timing, shared: Timing): TransferState
    fun progress(now: ULong, source: TransferSource, received: ULong): TransferState
    fun delivered(now: ULong, source: TransferSource, span: PieceSpan, bytes: ByteArray): TransferState
    fun failed(now: ULong, source: TransferSource): TransferState
    fun tick(now: ULong): TransferState
    companion object
}
open class Transfer : NativeObject, TransferInterface {
    @Throws(CoreException::class)
    constructor(settings: TransferSettings, size: ULong, sha256: String, pieces: List<String>, deadline: ULong) : super(construct("transfer", mapOf("settings" to settingsJson(settings), "size" to size, "sha256" to sha256, "pieces" to pieces, "deadline" to deadline)))
    @Suppress("UNUSED_PARAMETER") constructor(noPointer: NoPointer) : super(0)
    override fun start(now: ULong, peers: List<PeerTiming>, origin: Timing, shared: Timing): TransferState {
        val ids = LongArray(peers.size) { peers[it].peer.toLong() }
        val timings = DoubleArray(peers.size * 2)
        val present = BooleanArray(peers.size * 2)
        for (index in peers.indices) {
            val timing = peers[index].timing
            timings[index * 2] = timing.firstByteMs ?: 0.0
            timings[index * 2 + 1] = timing.rate ?: 0.0
            present[index * 2] = timing.firstByteMs != null
            present[index * 2 + 1] = timing.rate != null
        }
        return fast {
            transferStateBinary(Native.transferStart(it, now.toLong(), ids, timings, present,
                doubleArrayOf(origin.firstByteMs ?: 0.0, origin.rate ?: 0.0),
                doubleArrayOf(shared.firstByteMs ?: 0.0, shared.rate ?: 0.0),
                booleanArrayOf(origin.firstByteMs != null, origin.rate != null),
                booleanArrayOf(shared.firstByteMs != null, shared.rate != null)))
        }
    }
    override fun progress(now: ULong, source: TransferSource, received: ULong) = transferState(invoke("progress", mapOf("now" to now, "source" to sourceJson(source), "received" to received)))
    override fun delivered(now: ULong, source: TransferSource, span: PieceSpan, bytes: ByteArray) = transferState(invoke("delivered", mapOf("now" to now, "source" to sourceJson(source), "span" to spanJson(span), "bytes" to bytes)))
    override fun failed(now: ULong, source: TransferSource) = transferState(invoke("failed", mapOf("now" to now, "source" to sourceJson(source))))
    override fun tick(now: ULong) = transferState(invoke("tick", mapOf("now" to now)))
}

interface PeerLinkInterface {
    fun setChannelOpen(open: Boolean); fun setReliable(reliable: Boolean); fun observeBuffered(buffered: ULong)
    fun sets(): LinkSets; fun state(): LinkUpdate; fun handleText(now: ULong, text: String): LinkUpdate; fun handleBinary(now: ULong, chunk: ByteArray): LinkUpdate
    fun request(now: ULong, key: String, timeoutMs: ULong, expectedSize: ULong?): LinkUpdate
    fun requestRange(now: ULong, key: String, timeoutMs: ULong, span: PieceSpan, objectSize: ULong): LinkUpdate
    fun abort(now: ULong, id: ULong, abandoned: Boolean): LinkUpdate; fun closeLink(reason: String): LinkUpdate; fun tick(now: ULong): LinkUpdate
    fun serveResponse(now: ULong, bytes: ByteArray?): LinkUpdate; fun bufferedAmountLow(now: ULong, buffered: ULong): LinkUpdate
    fun sendHave(keys: List<String>): LinkUpdate; fun sendHaveChange(add: List<String>, del: List<String>): LinkUpdate
    fun sendContribution(serving: Boolean, rendition: String?): LinkUpdate; fun sendFetching(key: String, leaseMs: ULong): LinkUpdate
    companion object
}
open class PeerLink : NativeObject, PeerLinkInterface {
    constructor(settings: LinkSettings, now: ULong) : super(construct("peer_link", mapOf("settings" to linkSettingsJson(settings), "now" to now)))
    @Suppress("UNUSED_PARAMETER") constructor(noPointer: NoPointer) : super(0)
    override fun setChannelOpen(open: Boolean) { invoke("set_channel_open", mapOf("open" to open)) }
    override fun setReliable(reliable: Boolean) { invoke("set_reliable", mapOf("reliable" to reliable)) }
    override fun observeBuffered(buffered: ULong) { invoke("observe_buffered", mapOf("buffered" to buffered)) }
    override fun sets() = linkSets(invoke("sets"))
    override fun state() = linkUpdate(invoke("state"))
    override fun handleText(now: ULong, text: String) = fast { linkUpdateBinary(Native.peerLinkHandleText(it, now.toLong(), text.toByteArray(Charsets.UTF_8))) }
    override fun handleBinary(now: ULong, chunk: ByteArray) = linkUpdate(invoke("handle_binary", mapOf("now" to now, "chunk" to chunk)))
    override fun request(now: ULong, key: String, timeoutMs: ULong, expectedSize: ULong?) = linkUpdate(invoke("request", mapOf("now" to now, "key" to key, "timeout_ms" to timeoutMs, "expected_size" to expectedSize)))
    override fun requestRange(now: ULong, key: String, timeoutMs: ULong, span: PieceSpan, objectSize: ULong) = linkUpdate(invoke("request_range", mapOf("now" to now, "key" to key, "timeout_ms" to timeoutMs, "span" to spanJson(span), "object_size" to objectSize)))
    override fun abort(now: ULong, id: ULong, abandoned: Boolean) = linkUpdate(invoke("abort", mapOf("now" to now, "id" to id, "abandoned" to abandoned)))
    override fun closeLink(reason: String) = linkUpdate(invoke("close_link", mapOf("reason" to reason)))
    override fun tick(now: ULong) = linkUpdate(invoke("tick", mapOf("now" to now)))
    override fun serveResponse(now: ULong, bytes: ByteArray?) = fast { linkUpdateBinary(Native.peerLinkServeResponse(it, now.toLong(), bytes)) }
    override fun bufferedAmountLow(now: ULong, buffered: ULong) = linkUpdate(invoke("buffered_amount_low", mapOf("now" to now, "buffered" to buffered)))
    override fun sendHave(keys: List<String>) = fast { linkUpdateBinary(Native.peerLinkSendHave(it, keys.map { key -> key.toByteArray(Charsets.UTF_8) }.toTypedArray())) }
    override fun sendHaveChange(add: List<String>, del: List<String>) = linkUpdate(invoke("send_have_change", mapOf("add" to add, "del" to del)))
    override fun sendContribution(serving: Boolean, rendition: String?) = linkUpdate(invoke("send_contribution", mapOf("serving" to serving, "rendition" to rendition)))
    override fun sendFetching(key: String, leaseMs: ULong) = linkUpdate(invoke("send_fetching", mapOf("key" to key, "lease_ms" to leaseMs)))
}

interface PeerSelectionInterface {
    fun observe(now: ULong, firstByteMs: Double?, bytes: Double, flowMs: Double, totalFlowMs: Double?)
    fun record(now: ULong, link: ULong, elapsedMs: Double, bytes: Double); fun markSelected(link: ULong); fun forget(link: ULong)
    fun select(links: List<SelectableLink>, tried: List<String>, size: Double, deadlineMs: Double): ULong?
    fun firstByteMs(): Double?; fun rate(): Double?; fun projectMs(size: Double): Double?; fun minimumMs(size: Double): Double
    fun lastObservedAt(): ULong; fun turn(): UInt; fun order(): ULong; fun summary(link: ULong): LinkObservation; fun estimate(link: ULong, size: Double): Double?
    companion object
}
open class PeerSelection : NativeObject, PeerSelectionInterface {
    constructor() : super(construct("peer_selection"))
    @Suppress("UNUSED_PARAMETER") constructor(noPointer: NoPointer) : super(0)
    override fun observe(now: ULong, firstByteMs: Double?, bytes: Double, flowMs: Double, totalFlowMs: Double?) { invoke("observe", mapOf("now" to now, "first_byte_ms" to firstByteMs, "bytes" to bytes, "flow_ms" to flowMs, "total_flow_ms" to totalFlowMs)) }
    override fun record(now: ULong, link: ULong, elapsedMs: Double, bytes: Double) { invoke("record", mapOf("now" to now, "link" to link, "elapsed_ms" to elapsedMs, "bytes" to bytes)) }
    override fun markSelected(link: ULong) { invoke("mark_selected", mapOf("link" to link)) }
    override fun forget(link: ULong) { invoke("forget", mapOf("link" to link)) }
    override fun select(links: List<SelectableLink>, tried: List<String>, size: Double, deadlineMs: Double): ULong? = u64OrNull(invoke("select", mapOf("links" to links.map { mapOf("id" to it.id, "pubkey" to it.pubkey, "closed" to it.closed, "busy" to it.busy, "has_key" to it.hasKey) }, "tried" to tried, "size" to size, "deadline_ms" to deadlineMs)))
    override fun firstByteMs() = doubleOrNull(invoke("first_byte_ms"))
    override fun rate() = doubleOrNull(invoke("rate"))
    override fun projectMs(size: Double) = doubleOrNull(invoke("project_ms", mapOf("size" to size)))
    override fun minimumMs(size: Double) = doubleValue(invoke("minimum_ms", mapOf("size" to size)))
    override fun lastObservedAt() = u64(invoke("last_observed_at"))
    override fun turn() = u32(invoke("turn"))
    override fun order() = fast { Native.peerSelectionOrder(it).toULong() }
    override fun summary(link: ULong) = observation(invoke("summary", mapOf("link" to link)))
    override fun estimate(link: ULong, size: Double) = doubleOrNull(invoke("estimate", mapOf("link" to link, "size" to size)))
}

interface NeighbourDiscoveryInterface {
    fun context(now: ULong, mediaType: String, rendition: String): ULong?; fun demand(now: ULong, mediaType: String, rendition: String, key: String): ULong?
    fun hint(now: ULong, pubkey: String, have: List<String>, ticket: String?); fun holderMiss(now: ULong, context: ULong?, pubkey: String, key: String)
    fun holderAhead(context: ULong?, pubkey: String); fun rearm(now: ULong, context: ULong, allStale: Boolean): Boolean; fun stale(now: ULong, context: ULong?, pubkey: String): Boolean
    fun forget(pubkey: String); fun current(now: ULong, context: ULong): Boolean; fun choose(now: ULong, eligible: List<String>, unmet: List<String>, room: Boolean): FoundHolder?
    fun hinted(now: ULong, context: ULong, eligible: List<String>): FoundHolder?; fun begin(now: ULong): ULong?; fun valid(now: ULong, attempt: ULong): Boolean
    fun replaced(now: ULong, attempt: ULong, victim: String?): Boolean; fun allocated(attempt: ULong, dial: ULong); fun abandoned(attempt: ULong); fun failed(dial: ULong)
    fun end(): Boolean; fun verified(context: ULong?): Boolean; fun live(now: ULong): Boolean; fun reserved(now: ULong): Boolean; fun suppresses(now: ULong, pubkey: String): Boolean
    fun contexts(): List<DiscoveryContext>; fun candidates(): List<DiscoveryCandidate>; fun window(): DiscoveryWindow?; fun snapshot(now: ULong): DiscoverySnapshot; fun clear()
    companion object
}
open class NeighbourDiscovery : NativeObject, NeighbourDiscoveryInterface {
    constructor() : super(construct("neighbour_discovery"))
    @Suppress("UNUSED_PARAMETER") constructor(noPointer: NoPointer) : super(0)
    override fun context(now: ULong, mediaType: String, rendition: String) = u64OrNull(invoke("context", mapOf("now" to now, "media_type" to mediaType, "rendition" to rendition)))
    override fun demand(now: ULong, mediaType: String, rendition: String, key: String) = u64OrNull(invoke("demand", mapOf("now" to now, "media_type" to mediaType, "rendition" to rendition, "key" to key)))
    override fun hint(now: ULong, pubkey: String, have: List<String>, ticket: String?) { invoke("hint", mapOf("now" to now, "pubkey" to pubkey, "have" to have, "ticket" to ticket)) }
    override fun holderMiss(now: ULong, context: ULong?, pubkey: String, key: String) { invoke("holder_miss", mapOf("now" to now, "context" to context, "pubkey" to pubkey, "key" to key)) }
    override fun holderAhead(context: ULong?, pubkey: String) { invoke("holder_ahead", mapOf("context" to context, "pubkey" to pubkey)) }
    override fun rearm(now: ULong, context: ULong, allStale: Boolean) = boolValue(invoke("rearm", mapOf("now" to now, "context" to context, "all_stale" to allStale)))
    override fun stale(now: ULong, context: ULong?, pubkey: String) = boolValue(invoke("stale", mapOf("now" to now, "context" to context, "pubkey" to pubkey)))
    override fun forget(pubkey: String) { invoke("forget", mapOf("pubkey" to pubkey)) }
    override fun current(now: ULong, context: ULong) = boolValue(invoke("current", mapOf("now" to now, "context" to context)))
    override fun choose(now: ULong, eligible: List<String>, unmet: List<String>, room: Boolean) = invoke("choose", mapOf("now" to now, "eligible" to eligible, "unmet" to unmet, "room" to room))?.let(::found)
    override fun hinted(now: ULong, context: ULong, eligible: List<String>) = invoke("hinted", mapOf("now" to now, "context" to context, "eligible" to eligible))?.let(::found)
    override fun begin(now: ULong) = u64OrNull(invoke("begin", mapOf("now" to now)))
    override fun valid(now: ULong, attempt: ULong) = boolValue(invoke("valid", mapOf("now" to now, "attempt" to attempt)))
    override fun replaced(now: ULong, attempt: ULong, victim: String?) = boolValue(invoke("replaced", mapOf("now" to now, "attempt" to attempt, "victim" to victim)))
    override fun allocated(attempt: ULong, dial: ULong) { invoke("allocated", mapOf("attempt" to attempt, "dial" to dial)) }
    override fun abandoned(attempt: ULong) { invoke("abandoned", mapOf("attempt" to attempt)) }
    override fun failed(dial: ULong) { invoke("failed", mapOf("dial" to dial)) }
    override fun end() = boolValue(invoke("end"))
    override fun verified(context: ULong?) = boolValue(invoke("verified", mapOf("context" to context)))
    override fun live(now: ULong) = boolValue(invoke("live", mapOf("now" to now)))
    override fun reserved(now: ULong) = boolValue(invoke("reserved", mapOf("now" to now)))
    override fun suppresses(now: ULong, pubkey: String) = boolValue(invoke("suppresses", mapOf("now" to now, "pubkey" to pubkey)))
    override fun contexts() = arrayValue(invoke("contexts")).map(::context)
    override fun candidates() = arrayValue(invoke("candidates")).map(::candidate)
    override fun window(): DiscoveryWindow? = invoke("window")?.let { value -> objectValue(value).let { DiscoveryWindow(u64(it["id"]), u64(it["context"]), media(it["media_type"]), u64(it["created_at"]), u64(it["expires_at"]), it["attempt"]?.let(::attempt), boolValue(it["vacant"]), stringOrNull(it["victim"])) } }
    override fun snapshot(now: ULong) = objectValue(invoke("snapshot", mapOf("now" to now))).let { DiscoverySnapshot(u32(it["candidates"]), u32(it["contexts"]), u32(it["requested_keys"]), u32(it["replacement_spent"]), u64(it["replacement_rearm_ms"]), boolValue(it["opportunity_active"]), u64(it["remaining_ms"]), boolValue(it["vacancy_reserved"]), counters(it["counters"])) }
    override fun clear() { invoke("clear") }
}

fun validStreamAuthorisation(eventJson: String): Boolean = boolValue(call("valid_stream_authorisation", mapOf("event_json" to eventJson)))
fun verifyCommitmentDelegation(eventJson: String, optionsJson: String, atMs: Long): String? = stringOrNull(call("verify_commitment_delegation", mapOf("event_json" to eventJson, "options_json" to optionsJson, "at_ms" to atMs)))
fun verifySegmentCommitment(eventJson: String, optionsJson: String, atMs: Long): String? = stringOrNull(call("verify_segment_commitment", mapOf("event_json" to eventJson, "options_json" to optionsJson, "at_ms" to atMs)))
fun commitmentPieceSize(size: ULong): ULong = u64(call("commitment_piece_size", mapOf("size" to size)))
fun pieceCount(size: ULong): UInt? = call("piece_count", mapOf("size" to size))?.let(::u32)
fun pieceSpanBytes(size: ULong, span: PieceSpan): ByteSpan? = call("piece_span_bytes", mapOf("size" to size, "span" to spanJson(span)))?.let { objectValue(it).let { value -> ByteSpan(u64(value["from"]), u64(value["to"])) } }
fun defaultTransferSettings(): TransferSettings = objectValue(call("default_transfer_settings")).let { TransferSettings(u32(it["max_holders"]), doubleValue(it["origin_reserve_ms"])) }
fun linkLimits(): LinkLimits = objectValue(call("link_limits")).let { LinkLimits(u64(it["chunk_bytes"]), u64(it["high_water_bytes"]), u64(it["low_water_bytes"]), u32(it["max_have_keys"])) }
fun playerHint(supply: PlayerSupply): PlayerCommand {
    val args = mapOf("rendition" to supply.rendition, "size" to supply.size, "peers" to supply.peers.map(::peerTimingJson), "origin" to supply.origin?.let(::timingJson), "shared" to timingJson(supply.shared), "available_ms" to supply.availableMs, "max_holders" to supply.maxHolders)
    val value = objectValue(objectValue(call("player_hint", mapOf("supply" to args)))["PlayerHint"])
    val hint = objectValue(value["hint"]).let { PlayerSupplyHint(stringValue(it["rendition"]), u32(it["eligible_holders"]), doubleOrNull(it["projected_ms"])) }
    return PlayerCommand.PlayerHint(hint)
}
