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
    // JSON has no infinity or NaN; JavaScript writes them as null.
    is Double -> if (value.isFinite()) value.toString() else "null"

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

fun frames(events: List<PeerLinkEvent>) = events.filter { it is PeerLinkEvent.SendText || it is PeerLinkEvent.SendBinary }

// A requester asks a holder for a run of pieces; then the channel-state calls.
fun range(field: List<String>) {
    val size = number(field[1])
    val objectBytes = bytes(field[2])!!
    val key = field[3]
    val span = PieceSpan(field[4].toUInt(), field[5].toUInt())
    val settings = LinkSettings(8_388_608uL, 4u, 1_000uL, true)
    val requester = PeerLink(settings, 0uL)
    val holder = PeerLink(settings, 0uL)
    var toHolder = frames(requester.requestRange(0uL, key, 5_000uL, span, size).events)
    val toRequester = mutableListOf<PeerLinkEvent>()
    var resolved: ByteArray? = null
    var done = false
    var heldBack: Boolean? = null
    for (round in 0 until 64) {
        if (done) break
        for (frame in toHolder) {
            val update = holder.handleText(0uL, (frame as PeerLinkEvent.SendText).text)
            if (update.events.any { it is PeerLinkEvent.ServeRange }) {
                // A full send buffer: the holder sends its meta and holds the data for a drain.
                holder.observeBuffered(200_000uL)
                val sent = frames(holder.serveResponse(0uL, objectBytes).events)
                heldBack = sent.none { it is PeerLinkEvent.SendBinary }
                toRequester += sent
            }
        }
        toHolder = emptyList()
        if (toRequester.isEmpty()) toRequester += frames(holder.bufferedAmountLow(0uL, 0uL).events)
        for (frame in toRequester) {
            val update = when (frame) {
                is PeerLinkEvent.SendText -> requester.handleText(0uL, frame.text)
                is PeerLinkEvent.SendBinary -> requester.handleBinary(0uL, frame.bytes)
                else -> error("not a frame")
            }
            for (event in update.events) if (event is PeerLinkEvent.Resolved) { resolved = event.bytes; done = true }
        }
        toRequester.clear()
    }
    requester.close()
    holder.close()

    val quiet = PeerLink(settings, 0uL)
    quiet.setChannelOpen(false)
    val closedSends = quiet.sendHave(listOf("a")).events.size
    quiet.setChannelOpen(true)
    val openSends = quiet.sendHave(listOf("a")).events.size
    quiet.close()
    fun abortCloses(reliable: Boolean): Boolean {
        val link = PeerLink(settings, 0uL)
        link.setReliable(reliable)
        val id = link.request(0uL, "k", 5_000uL, null).requestId!!
        return link.abort(0uL, id, false).closed.also { link.close() }
    }
    println(json(mapOf("range" to resolved?.let(::base64), "heldBack" to heldBack, "closedSends" to closedSends, "openSends" to openSends,
        "unreliableAbortCloses" to abortCloses(false), "reliableAbortCloses" to abortCloses(true))))
}

fun double(field: String): Double? = if (field == "-") null else field.toDouble()
fun hexList(field: String): List<String> = if (field == "-") emptyList() else field.split(",")

// Selection state after each operation, as arrays the script names.
class SelectionRun(field: List<String>) {
    val selection = PeerSelection()
    val sizes = field[1].split(",").map { it.toDouble() }
    val size = field[2].toDouble()
    val count = field[3].toULong()
    val steps = mutableListOf<Any?>()

    fun apply(field: List<String>) {
        var result: ULong? = null
        when (field[0]) {
            "noop" -> {}
            "observe" -> selection.observe(number(field[1]), double(field[2]), double(field[3])!!, double(field[4])!!, double(field[5]))
            "record" -> selection.record(number(field[1]), number(field[2]), double(field[3])!!, double(field[4])!!)
            "forget" -> selection.forget(number(field[1]))
            "select" -> {
                val links = hexList(field[4]).map {
                    val part = it.split("/")
                    SelectableLink(number(part[0]), part[1], part[2] == "1", part[3] == "1", part[4] == "1")
                }
                result = selection.select(links, hexList(field[3]), double(field[1])!!, double(field[2])!!)
            }
            else -> error("unknown selection input ${field[0]}")
        }
        val links = (0uL until count).map { link ->
            val value = selection.summary(link)
            listOf(value.attempts, value.latencyMs, value.throughputBytesPerSecond, value.failureRate,
                value.consecutiveFailures, value.lastSelected, selection.estimate(link, size))
        }
        steps.add(listOf(result, selection.firstByteMs(), selection.rate(), sizes.map { selection.projectMs(it) },
            selection.minimumMs(size), selection.lastObservedAt(), selection.turn(), selection.order(), links))
    }
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
    var selection: SelectionRun? = null
    for (line in generateSequence(::readLine)) {
        if (line.isEmpty()) continue
        val field = line.split(" ")
        if (selection != null && field[0] != "selected") {
            selection.apply(field)
            continue
        }
        when (field[0]) {
            "selection" -> selection = SelectionRun(field)
            "selected" -> {
                println(json(mapOf("selection" to selection!!.steps)))
                selection.selection.close()
                selection = null
            }
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
            "range" -> range(field)
            "trace" -> {
                link?.close() // frees the previous trace's link
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
                    "close" -> peer.closeLink(text(field[1])!!)
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
