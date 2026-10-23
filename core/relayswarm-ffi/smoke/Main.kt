// Calls the core through the generated Kotlin bindings. Reads the line format
// scripts/ffi-smoke.mjs writes and prints one JSON line per result, which the
// script checks. main.swift is the same program in Swift.
import java.util.Base64
import uniffi.relayswarm_ffi.*

fun text(field: String): String? = if (field == "-") null else String(Base64.getDecoder().decode(field.substring(1)), Charsets.UTF_8)
fun bytes(field: String): ByteArray? = if (field == "-") null else Base64.getDecoder().decode(field.substring(1))
fun strings(field: String): List<String> = if (field == "-") emptyList() else field.split(",").map { text(it)!! }
fun number(field: String): ULong = field.toULong()
fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

// JSON without a library; non-ASCII is escaped so the output encoding never matters.
fun json(value: Any?): String = when (value) {
    null -> "null"
    is String -> buildString {
        append('"')
        for (char in value) {
            when {
                char == '"' -> append("\\\"")
                char == '\\' -> append("\\\\")
                char.code < 0x20 || char.code > 0x7e -> append("\\u%04x".format(char.code))
                else -> append(char)
            }
        }
        append('"')
    }
    is Boolean, is Int, is Long, is ULong, is UInt -> value.toString()
    is List<*> -> value.joinToString(",", "[", "]") { json(it) }
    is Map<*, *> -> value.entries.joinToString(",", "{", "}") { json(it.key as String) + ":" + json(it.value) }
    else -> error("cannot write $value")
}

// One origin and one holder that answers pieces in 40 ms; origin in 30 ms.
fun transfer(field: List<String>) {
    val size = number(field[1])
    val objectBytes = bytes(field[2])!!
    val transfer = Transfer(TransferSettings(defaultTransferSettings().maxHolders, 0.0), size, field[3], field[4].split(","), 4_000uL)
    data class Due(val at: ULong, val source: TransferSource, val span: PieceSpan)
    val queue = mutableListOf<Due>()
    val log = mutableListOf<String>()
    var delivered: ByteArray? = null
    fun handle(now: ULong, state: TransferState) {
        for (command in state.commands) {
            when (command) {
                is TransferCommand.Request -> { log.add("request ${command.peer} ${command.span.start}-${command.span.end}"); queue.add(Due(now + 40uL, TransferSource.Peer(command.peer), command.span)) }
                is TransferCommand.FetchOrigin -> { log.add("origin ${command.span.start}-${command.span.end}"); queue.add(Due(now + 30uL, TransferSource.Origin, command.span)) }
                is TransferCommand.Cancel -> log.add("cancel ${command.peer}")
                is TransferCommand.Abandon -> log.add("abandon ${command.peer}")
                is TransferCommand.Ban -> log.add("ban ${command.peer}")
                is TransferCommand.Deliver -> { log.add("deliver"); delivered = command.bytes }
                is TransferCommand.Fail -> log.add("fail")
            }
        }
    }
    handle(10uL, transfer.start(10uL, listOf(PeerTiming(1uL, Timing(null, null))), Timing(30.0, 500.0), Timing(20.0, 1_000.0)))
    while (delivered == null && queue.isNotEmpty()) {
        queue.sortBy { it.at }
        val next = queue.removeAt(0)
        val range = pieceSpanBytes(size, next.span)!!
        handle(next.at, transfer.delivered(next.at, next.source, next.span, objectBytes.copyOfRange(range.from.toInt(), range.to.toInt())))
    }
    println(json(mapOf("log" to log, "delivered" to delivered?.let(::base64))))
}

fun event(event: PeerLinkEvent): List<Any?> = when (event) {
    is PeerLinkEvent.SendText -> listOf("sendText", event.text)
    is PeerLinkEvent.SendBinary -> listOf("sendBinary", base64(event.bytes))
    is PeerLinkEvent.Closed -> listOf("closed", event.reason)
    is PeerLinkEvent.Report -> with(event.report) {
        listOf("result", outcome.name, receivedBytes, metadataReceived, draining, closeReason)
    }
    is PeerLinkEvent.Resolved -> listOf("resolved", event.bytes?.let(::base64))
    is PeerLinkEvent.HaveChanged -> listOf("haveChanged", event.keys)
    is PeerLinkEvent.ScheduleChanged -> listOf("scheduleChanged")
    is PeerLinkEvent.ServeRequest -> listOf("serveRequest", event.key)
    is PeerLinkEvent.ServeRange -> listOf("serveRange", event.key, event.span.start, event.span.end)
    is PeerLinkEvent.UploadCancelled -> listOf("uploadCancelled", event.bytes)
    is PeerLinkEvent.Progress -> listOf("progress", event.received, event.size)
}

fun snapshot(link: PeerLink, update: LinkUpdate): List<Any?> {
    val sets = link.sets()
    return listOf(sets.have, sets.fetching.map { listOf(it.key, it.at) }, sets.renditions.map { listOf(it.key, it.at) },
        sets.serving, sets.rendition, update.busy, update.outboundInFlight, update.closed, update.bytesIn, update.bytesOut)
}

fun main() {
    var at = 0L
    val verdicts = mutableListOf<String>()
    var link: PeerLink? = null
    var now = 0uL
    var lastRequest: ULong? = null
    val steps = mutableListOf<Any?>()
    for (line in generateSequence(::readLine)) {
        if (line.isEmpty()) continue
        val field = line.split(" ")
        when (field[0]) {
            "at" -> at = field[1].toLong()
            "case" -> {
                val event = text(field[2])!!
                val options = text(field[3])!!
                verdicts.add(when (field[1]) {
                    "stream" -> if (validStreamAuthorisation(event)) "true" else "null"
                    "delegation" -> verifyCommitmentDelegation(event, options, at) ?: "null"
                    else -> verifySegmentCommitment(event, options, at) ?: "null"
                })
            }
            "transfer" -> {
                println("{\"vectors\":[${verdicts.joinToString(",")}]}")
                transfer(field)
            }
            "trace" -> {
                link?.close()
                now = number(field[1])
                link = PeerLink(LinkSettings(number(field[2]), field[3].toUInt(), number(field[4]), field[5] == "1"), now)
                lastRequest = null
                steps.clear()
            }
            "end" -> println(json(mapOf("steps" to steps)))
            else -> {
                val peer = link!!
                val events = mutableListOf<PeerLinkEvent>()
                var update: LinkUpdate = when (field[0]) {
                    "text" -> peer.handleText(now, text(field[1])!!)
                    "binary" -> peer.handleBinary(now, bytes(field[1])!!)
                    "request" -> peer.request(now, text(field[1])!!, number(field[2]), if (field[3] == "-") null else number(field[3]))
                        .also { lastRequest = it.requestId ?: lastRequest }
                    "abort" -> lastRequest?.let { peer.abort(now, it, field[1] == "1") } ?: peer.state()
                    "advance" -> {
                        val target = now + number(field[1])
                        var current = peer.state()
                        while (true) {
                            val deadline = current.nextDeadline
                            if (deadline == null || deadline > target) break
                            events += current.events
                            now = maxOf(now, deadline)
                            current = peer.tick(deadline)
                        }
                        now = target
                        current
                    }
                    "serve" -> peer.serveResponse(now, bytes(field[1]))
                    "drain" -> peer.bufferedAmountLow(now, 0uL)
                    "close" -> peer.close(text(field[1])!!)
                    "sendHave" -> peer.sendHave(strings(field[1]))
                    "sendHaveChange" -> peer.sendHaveChange(strings(field[1]), strings(field[2]))
                    "sendContribution" -> peer.sendContribution(field[1] == "1", text(field[2]))
                    "sendFetching" -> peer.sendFetching(text(field[1])!!, number(field[2]))
                    else -> error("unknown input ${field[0]}")
                }
                events += update.events
                steps.add(listOf(events.map(::event), snapshot(peer, update)))
            }
        }
    }
}
