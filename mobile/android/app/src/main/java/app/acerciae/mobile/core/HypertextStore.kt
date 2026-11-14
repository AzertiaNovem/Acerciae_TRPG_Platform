package app.acerciae.mobile.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.util.UUID

// Interactive messages of the open channel: each card's status for this viewer, what is shown before the server has
// it (a draft), and the action pipeline every client follows. A port of the web store (frontend/src/store/hypertext.ts),
// which is the reference; mobile/contracts/INTEGRATION.md (2026-11-14) lists every answer and what it does.
// - A control with no handler and no act changes the state, saved by a debounced PUT (coalesced per card).
// - A button's declarative act gives the new state and its effects: /act, or a PUT when nothing is posted.
// - An `on` handler runs the card's script in the engine page ([HypertextRunner]); its result is checked again here
//   (Hypertext.validateOutput) and shown at once; a line that needs the viewer's confirmation waits for it (cancel
//   reverts and sends nothing); then /act, or a PUT when nothing is posted.
// Each action has its own interaction id, reused by every retry of it: no answer, a 408, a 5xx or 409
// interaction_in_progress is tried again up to 3 times with a growing pause, then the action reverts. 428 asks the
// viewer and sends the same action again with `confirmed`; 409 adopts the server's state (from the error, or by asking
// the status again); 405 and a 404 that is not the API's own answer (an older server) and 403 feature_disabled mark the
// feature unavailable. One action per card is under way at a time on this device, and saves and actions of a card go
// one after the other, so each starts from the version the last one left. Spectators and the demo never come here.

// ---- REST shapes (docs/API.md, Interactive messages) ----

@Serializable data class HypertextStatusItem(
    @SerialName("message_id") val messageId: String,
    @SerialName("closes_at") val closesAt: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
    val closed: Boolean = false,
    /** This viewer's own state; null before their first save. */
    val state: JsonObject? = null,
    val version: Long = 0,
    @SerialName("runs_left") val runsLeft: Int? = null,
)
@Serializable data class HypertextStatus(val enabled: Boolean = true, val items: List<HypertextStatusItem> = emptyList())
@Serializable data class HypertextSaved(@SerialName("message_id") val messageId: String = "", val state: JsonObject? = null, val version: Long = 0)
@Serializable data class HypertextVersioned(val state: JsonObject? = null, val version: Long = 0)
/** One effect of an action: the line it posted as the viewer may read it (null for a GM-only reply), or its error. */
@Serializable data class HypertextLine(val type: String = "", val ok: Boolean = false, val message: JsonObject? = null, val error: JsonObject? = null) {
    /** The posted line; null when it is not readable or does not decode (it then arrives by its push or the next refresh). */
    val row: Message? get() = message?.let { runCatching { lenientRows.decodeFromJsonElement<Message>(it) }.getOrNull() }
}
private val lenientRows = Json { ignoreUnknownKeys = true }
@Serializable data class HypertextActResult(
    @SerialName("interaction_id") val interactionId: String = "",
    val replayed: Boolean = false,
    val partial: Boolean = false,
    val results: List<HypertextLine> = emptyList(),
    val state: HypertextVersioned? = null,
)
@Serializable data class HypertextClosed(
    @SerialName("message_id") val messageId: String = "",
    @SerialName("closes_at") val closesAt: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
    @SerialName("closed_by") val closedBy: String? = null,
    val closed: Boolean = true,
)

/** The card routes, as [BackendClient] serves them for one signed-in session ([BackendClient.hypertext]). Failures are
 *  [BackendException]s (status, code, the API's error body in `details`) or the network's IOExceptions. */
interface HypertextApi {
    suspend fun status(channel: String, ids: List<String>): HypertextStatus
    suspend fun save(channel: String, message: String, state: JsonObject, baseVersion: Long): HypertextSaved
    suspend fun act(channel: String, message: String, body: JsonObject): HypertextActResult
    suspend fun close(channel: String, message: String): HypertextClosed
}

/** The engine page (the WebView host): one request JSON in, the page's result JSON out. A run the host has to end
 *  itself (no answer in time, the page gone) throws [HypertextRunFailure] with the code to report. */
interface HypertextRunner {
    suspend fun run(request: String): String
    /** Drops the page (reset); the next run starts a new one. */
    fun dispose() {}
}
class HypertextRunFailure(val code: String, message: String) : Exception(message)

/** Timings, in milliseconds (tests shorten them). */
data class HxTiming(val statusDebounceMs: Long = 150, val saveDebounceMs: Long = 500, val retryMs: List<Long> = listOf(600, 1800, 4500), val statusRetryMs: Long = 5000)

/** The feature on this server: null when it works, MISSING on an older server, DISABLED when it is turned off. */
enum class HxUnavailable { MISSING, DISABLED }

/** One card's status for this viewer (the web store's CardEntry). */
data class HxCard(
    val channelId: String,
    /** The status arrived; controls stay disabled ("Loading…") until then. */
    val loaded: Boolean = false,
    /** To be asked again. */
    val stale: Boolean = false,
    val fetching: Boolean = false,
    /** Left out of the status: recalled or no longer readable (drawn closed). */
    val gone: Boolean = false,
    val closesAt: String? = null,
    val closedAt: String? = null,
    /** Closed when the status was read (closed_at set, or closes_at passed). */
    val closed: Boolean = false,
    /** The server's copy of this viewer's state (null before their first save). */
    val state: JsonObject? = null,
    val version: Long = 0,
    val runsLeft: Int? = null,
    /** Shown instead of the server's copy until it is saved, adopted or reverted. */
    val draft: JsonObject? = null,
    /** An action of this card is under way on this device. */
    val pending: Boolean = false,
    /** One short sentence for the viewer: a catalog key (translate it), or the server's own words. */
    val error: String? = null,
    /** The last script failure; its details are shown to GMs only. */
    val failure: HxEngineError? = null,
    /** The last run's log() output (GMs only). */
    val logs: List<String> = emptyList(),
    /** The last run's notify() notes, for this viewer only, never sent. */
    val notices: List<String> = emptyList(),
    /** A line waiting for the viewer's confirmation. */
    val confirm: HxConfirm? = null,
)

/** What an interaction needs from the card as it is drawn (see [HxCardView]). The script gets [viewer] only: never a
 *  token or an id. [sayCharacterId]: the character the composer speaks as, when it is not the viewer's character in
 *  the card's window; a line as the viewer is posted as that one. [dice] false: the server's dice are off, so a dot
 *  command posts as plain text and every line from a script is free text. [engine]: the engine can run here. */
data class HxContext(
    val channelId: String,
    val message: Message,
    val doc: HxDoc,
    val lock: HxLockReason?,
    val viewer: HxViewer,
    val engine: Boolean,
    val sayCharacterId: String? = null,
    val dice: Boolean = true,
)

/** What to do about a failed request to a card route. */
enum class HxOutcome { RETRY, MISSING, DISABLED, GONE, CONFIRM, CONFLICT, REFETCH, FAIL }

/** The pure decisions of the pipeline (the web store's exported functions), kept apart so they are tested alone. */
object HypertextPipeline {
    // The sentences shown for an outcome (each one is in the catalog).
    const val FAILED = "This message's action failed."
    const val UNSENT = "This message's action could not be sent. Check your connection."
    const val UNSAVED = "Your change could not be saved."
    const val PARTIAL = "Part of this action could not be posted."
    const val NO_ENGINE = "Interactive actions are unavailable on this device."
    val ERRORS = mapOf(
        "hypertext_closed" to "This message is closed.",
        "runs_exhausted" to "You already used this.",
        "reply_exhausted" to "This answer is no longer available.",
        "rate_limited" to "Too many actions. Try again in a moment.",
        "not_an_actor" to "This message is for other characters.",
        "hypertext_command_not_allowed" to "This message cannot post that command for you.",
        "sender_unavailable" to "This message's sender can no longer answer.",
        "state_conflict" to "This message changed on another device.",
        "interaction_in_progress" to "An action on this message is still being posted. Try again in a moment.",
        "feature_disabled" to "Interactive messages are turned off on this server.",
    )
    /** The status ids one request may carry (the server answers 400 to more). */
    const val STATUS_IDS = 100

    /** The sentence for a refusal: a known code in the catalog's words, else the server's own message. */
    fun errorText(e: Throwable): String {
        val b = e as? BackendException
        return b?.code?.let { ERRORS[it] } ?: b?.details?.text("message")?.takeIf { it.isNotEmpty() } ?: FAILED
    }

    /** No status (the network), a 408 or a 5xx: try again, as for an action still being posted under the same id. A 404
     *  that is not the API's own answer, or a 405: the route is not there (an older server). */
    fun classify(e: Throwable): HxOutcome {
        val b = e as? BackendException ?: return HxOutcome.RETRY
        val status = b.status
        return when {
            status == 0 || status == 408 || status >= 500 -> HxOutcome.RETRY
            status == 405 || (status == 404 && !b.apiResponse) -> HxOutcome.MISSING
            status == 403 && b.code == "feature_disabled" -> HxOutcome.DISABLED
            status == 404 -> HxOutcome.GONE
            status == 428 -> HxOutcome.CONFIRM
            status == 409 -> when (b.code) { "interaction_in_progress" -> HxOutcome.RETRY; "state_conflict" -> HxOutcome.CONFLICT; else -> HxOutcome.REFETCH }
            else -> HxOutcome.FAIL
        }
    }

    /** Whether two states hold the same values (key order aside; sets are kept in schema order on both sides). */
    fun sameState(a: JsonObject?, b: JsonObject?): Boolean {
        if (a == null || b == null) return a == null && b == null
        if (a.size != b.size) return false
        return a.all { (k, x) ->
            val y = b[k] ?: return@all false
            if (x is JsonArray) y is JsonArray && x.size == y.size && x.indices.all { Hypertext.same(x[it], y[it]) } else Hypertext.same(x, y)
        }
    }
    /** The state a card is drawn with: the draft, else the server's copy over the defaults. */
    fun shownState(doc: HxDoc, card: HxCard?): JsonObject = card?.draft ?: Hypertext.overlay(doc, card?.state)
    /** Whether a pushed or returned state replaces the one held: newer, or as new for a status read again. */
    fun newer(version: Long, held: Long, orEqual: Boolean = false) = version > held || (orEqual && version == held)
    /** A known runs_left after a posted action. */
    fun runsAfter(runsLeft: Int?): Int? = runsLeft?.let { maxOf(0, it - 1) }

    /** The /act request for the effects of one action; the say as [characterId] when given (else the server takes the
     *  viewer's character in the card's window). */
    fun actBody(interactionId: String, node: String, effects: List<HxEffect>, state: JsonObject, baseVersion: Long, confirmed: Boolean = false, characterId: String? = null): JsonObject = buildJsonObject {
        put("interaction_id", interactionId); put("node", node); put("base_version", baseVersion); put("state", state)
        for (e in effects) when (e) {
            is HxSay -> putJsonObject("say") { put("text", e.text); put("kind", e.kind); if (!characterId.isNullOrEmpty()) put("character_id", characterId); if (confirmed) put("confirmed", true) }
            is HxReply -> putJsonObject("reply") { put("id", e.id); put("slots", e.slots) }
        }
    }
    /** The same body, confirmed (the resend after a 428). */
    fun confirmed(body: JsonObject): JsonObject {
        val say = body["say"] as? JsonObject ?: return body
        return JsonObject(LinkedHashMap(body).apply { put("say", JsonObject(LinkedHashMap(say).apply { put("confirmed", JsonPrimitive(true)) })) })
    }
    /** The confirmation a 428 asks for: its `text` (else the say's), and a sheet warning unless `sheet` is false. */
    fun confirmOf428(e: Throwable, body: JsonObject): HxConfirm? {
        val say = body["say"] as? JsonObject ?: return null
        val details = (e as? BackendException)?.details
        val text = Hypertext.stringOf(details?.get("text")) ?: say.text("text")
        return HxConfirm(text, say.text("kind").ifEmpty { "ic" }, sheet = Hypertext.boolOf(details?.get("sheet")) != false)
    }
    /** The confirmation a script's effects need before they are sent. With the server's dice off a dot command is plain
     *  text, so any say is confirmed (and changes no sheet). */
    fun confirmOf(run: HxRunOk, dice: Boolean = true): HxConfirm? {
        if (dice) return run.confirm
        val say = run.effects.firstOrNull { it is HxSay } as? HxSay ?: return null
        return HxConfirm(say.text, say.kind)
    }

    /** The engine request: the card as stored, the state after the control's change, the state shown before it. */
    fun engineRequest(raw: JsonObject, state: JsonObject, prev: JsonObject, handler: String, event: HxEvent, viewer: HxViewer): String = buildJsonObject {
        put("doc", raw); put("state", state); put("prev", prev); put("handler", handler); put("event", event.json()); put("viewer", viewer.json())
    }.toString()
    /** A request or a result larger than this is refused, as on the web. */
    const val MESSAGE_BYTES = 65536
    /** One run through [runner], checked here whatever the page answered. */
    suspend fun run(runner: HypertextRunner, doc: HxDoc, raw: JsonObject, state: JsonObject, prev: JsonObject, handler: String, event: HxEvent, viewer: HxViewer): HxRunResult {
        val request = engineRequest(raw, state, prev, handler, event, viewer)
        if (Hypertext.utf8Bytes(request) > MESSAGE_BYTES) return Hypertext.failure("invalid_state", "the action is too large to run")
        val out = try { runner.run(request) }
            catch (e: CancellationException) { throw e }
            catch (e: HypertextRunFailure) { return Hypertext.failure(e.code.takeIf { it in Hypertext.CODES } ?: "engine", e.message.orEmpty()) }
            catch (_: Exception) { return Hypertext.failure("engine", "the engine could not run this action") }
        if (Hypertext.utf8Bytes(out) > MESSAGE_BYTES) return Hypertext.failure("invalid_effect", "the engine sent a reply that is too large or not valid")
        return Hypertext.validateOutput(doc, prev, out)
    }

    /** The two card pushes (fixtures/realtime-events.json). Neither carries a message. */
    data class StatePush(val messageId: String, val state: JsonObject?, val version: Long)
    data class ClosedPush(val messageId: String, val closedAt: String)
    fun statePush(e: RealtimeEvent): StatePush? {
        if (e.type != "hypertext.state") return null
        val id = e.payload.text("message_id").ifEmpty { return null }
        return StatePush(id, e.payload["state"] as? JsonObject, Hypertext.integerOf(e.payload["version"])?.toLong() ?: 0)
    }
    fun closedPush(e: RealtimeEvent): ClosedPush? {
        if (e.type != "hypertext.closed") return null
        val id = e.payload.text("message_id").ifEmpty { return null }
        return ClosedPush(id, e.payload.text("closed_at"))
    }

    /** A UUID for one action. */
    fun newInteractionId(): String = UUID.randomUUID().toString()
}

/**
 * The cards of the open channel and the action pipeline (the web's useHypertext). Everything runs on [scope], which
 * must be single-threaded (the main thread); call every function from that thread too. [posted] gets each line an
 * action posted, for the chat (de-duplicated there with its push by id). [runner] is null where the engine cannot run.
 * [reset] drops everything (cards, timers, confirmations, the engine page): call it on sign-in and sign-out, a channel
 * switch and every change of knowledge scope. Whether the engine works on this device is kept across resets: the first
 * `engine_unavailable` is the answer for the app session.
 */
class HypertextStore(
    private val api: HypertextApi,
    private val runner: HypertextRunner?,
    private val scope: CoroutineScope,
    private val timing: HxTiming = HxTiming(),
    private val posted: (Message) -> Unit = {},
    private val newId: () -> String = HypertextPipeline::newInteractionId,
) {
    data class Snapshot(val cards: Map<String, HxCard> = emptyMap(), val unavailable: HxUnavailable? = null, val engine: Boolean = true)
    private val flow = MutableStateFlow(Snapshot(engine = runner != null))
    val snapshot: StateFlow<Snapshot> = flow.asStateFlow()
    val cards: Map<String, HxCard> get() = flow.value.cards
    val unavailable: HxUnavailable? get() = flow.value.unavailable
    /** Whether a control with `on` can run here (false without a runner, or once the page said it cannot). */
    val engine: Boolean get() = flow.value.engine

    private var gen = 0
    // A card's failure stays on its card: an unexpected error in one job never reaches the app's thread.
    private fun newJobs() = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]) + CoroutineExceptionHandler { _, _ -> })
    private var jobs = newJobs()
    private var engineUsed = false
    private data class Wanted(val channelId: String, val ids: List<String>)
    private var wanted: Wanted? = null
    private var statusTimer: Job? = null
    private val saveTimers = HashMap<String, Job>()
    // The state a PUT of the card is carrying right now, until it is answered.
    private val inflight = HashMap<String, JsonObject>()
    private val lanes = HashMap<String, Mutex>()
    private val confirms = HashMap<String, (Boolean) -> Unit>()

    // Results that come back after a reset are dropped.
    private fun token(): () -> Boolean { val g = gen; return { g == gen } }
    private fun entry(id: String) = flow.value.cards[id]
    private fun patch(id: String, change: HxCard.() -> HxCard) {
        val s = flow.value; val e = s.cards[id] ?: return
        flow.value = s.copy(cards = s.cards + (id to e.change()))
    }
    // Saves and actions of one card, one after the other (a fair mutex keeps their order).
    private suspend fun lane(id: String, job: suspend () -> Unit) { lanes.getOrPut(id) { Mutex() }.withLock { job() } }
    private fun later(ms: Long, job: suspend () -> Unit): Job = jobs.launch(start = CoroutineStart.LAZY) { delay(ms); job() }

    // The server's copy, when it is newer than the one held (or as new, for a status read again); a draft that now
    // equals it has nothing left to save.
    private fun adopt(id: String, state: JsonObject?, version: Long, orEqual: Boolean = false) {
        val e = entry(id) ?: return
        if (!HypertextPipeline.newer(version, e.version, orEqual)) return
        patch(id) { copy(state = state, version = version, draft = if (draft != null && HypertextPipeline.sameState(draft, state)) null else draft) }
    }
    // The state shown from now on: a draft only while it differs from the server's copy. While a save is on its way the
    // draft always stays: a change back to the server's copy must still be saved over the one being sent.
    private fun setDraft(id: String, doc: HxDoc, state: JsonObject) {
        val e = entry(id) ?: return
        patch(id) { copy(draft = if (!inflight.containsKey(id) && HypertextPipeline.sameState(state, Hypertext.overlay(doc, e.state))) null else state) }
    }
    private fun clearTimer(id: String) { saveTimers.remove(id)?.cancel() }
    private fun markUnavailable(o: HxOutcome) {
        val u = if (o == HxOutcome.DISABLED) HxUnavailable.DISABLED else HxUnavailable.MISSING
        flow.value = flow.value.let { it.copy(unavailable = if (it.unavailable == HxUnavailable.MISSING) HxUnavailable.MISSING else u) }
    }

    private fun scheduleSave(id: String, now: Boolean = false) {
        clearTimer(id)
        lateinit var timer: Job
        // Once it fires the save is queued on the card's lane: clearing the timer no longer stops it.
        timer = later(if (now) 0 else timing.saveDebounceMs) { if (saveTimers[id] === timer) saveTimers.remove(id); lane(id) { save(id) } }
        saveTimers[id] = timer
        timer.start()
    }
    // The draft, compare-and-swap on the version held. A newer draft made while this one was on its way is saved by its
    // own (later) timer, and again here when none is due: whatever the viewer left on screen is what gets stored.
    private suspend fun save(id: String) {
        val alive = token()
        var retries = 0
        while (true) {
            val e = entry(id) ?: return
            val sent = e.draft ?: return
            inflight[id] = sent
            try {
                val r = api.save(e.channelId, id, sent, e.version)
                if (!alive()) return
                inflight.remove(id)
                adopt(id, r.state, r.version)
                val after = entry(id)
                if (after?.draft != null && !after.pending && !saveTimers.containsKey(id)) scheduleSave(id, true)
                return
            } catch (c: CancellationException) { throw c } catch (err: Exception) {
                if (!alive()) return
                val o = HypertextPipeline.classify(err)
                // Tried again with the draft as it is then; meanwhile the state sent may have reached the server after all.
                if (o == HxOutcome.RETRY && retries < timing.retryMs.size) { delay(timing.retryMs[retries++]); if (!alive()) return; continue }
                inflight.remove(id)
                when (o) {
                    HxOutcome.MISSING, HxOutcome.DISABLED -> { markUnavailable(o); patch(id) { copy(draft = null) } }
                    HxOutcome.CONFLICT -> {
                        val d = (err as BackendException).details
                        adopt(id, d?.get("state") as? JsonObject, Hypertext.integerOf(d?.get("version"))?.toLong() ?: 0)
                        patch(id) { copy(draft = null, error = HypertextPipeline.ERRORS["state_conflict"]) }
                    }
                    else -> {
                        patch(id) { copy(draft = null, error = if (o == HxOutcome.RETRY) HypertextPipeline.UNSAVED else HypertextPipeline.errorText(err)) }
                        if (o == HxOutcome.REFETCH || o == HxOutcome.GONE) refetch(e.channelId, listOf(id))
                    }
                }
                return
            }
        }
    }

    // The viewer's confirmation of a line; false when they cancel, the card closes or the store is reset.
    private suspend fun ask(id: String, c: HxConfirm): Boolean {
        confirms[id]?.invoke(false)
        patch(id) { copy(confirm = c) }
        val answer = CompletableDeferred<Boolean>()
        confirms[id] = { ok -> confirms.remove(id); patch(id) { copy(confirm = null) }; answer.complete(ok) }
        return answer.await()
    }
    // An action that ends without effect: what was shown before it comes back (and is saved, if it was a draft).
    private fun revert(id: String, prev: JsonObject?, error: String?) {
        patch(id) { copy(pending = false, draft = prev, confirm = null, error = error) }
        if (prev != null) scheduleSave(id)
    }

    // /act with the same interaction id on every attempt.
    private suspend fun send(ctx: HxContext, nodeId: String, effects: List<HxEffect>, state: JsonObject, prev: JsonObject?, confirmed: Boolean) {
        val id = ctx.message.id; val ch = ctx.channelId; val alive = token()
        clearTimer(id)   // the action carries the state: a save waiting for its timer is part of it
        lane(id) {
            if (!alive()) return@lane
            var body = HypertextPipeline.actBody(newId(), nodeId, effects, state, entry(id)?.version ?: 0, confirmed, ctx.sayCharacterId)
            var asked = confirmed
            var retries = 0
            while (true) {
                try {
                    val res = api.act(ch, id, body)
                    if (!alive()) return@lane
                    // The lines it posted, as the viewer may read them (a GM-only reply is null): shown at once.
                    for (r in res.results) r.row?.let(posted)
                    res.state?.let { adopt(id, it.state, it.version) }
                    patch(id) { copy(pending = false, draft = null, runsLeft = HypertextPipeline.runsAfter(runsLeft), error = if (res.partial) HypertextPipeline.PARTIAL else null) }
                    return@lane
                } catch (c: CancellationException) { throw c } catch (err: Exception) {
                    if (!alive()) return@lane
                    val o = HypertextPipeline.classify(err)
                    if (o == HxOutcome.RETRY && retries < timing.retryMs.size) { delay(timing.retryMs[retries++]); if (!alive()) return@lane; continue }
                    val question = if (o == HxOutcome.CONFIRM && !asked) HypertextPipeline.confirmOf428(err, body) else null
                    if (question != null) {
                        asked = true
                        val ok = ask(id, question)
                        if (!alive()) return@lane
                        if (!ok) { revert(id, prev, null); return@lane }
                        body = HypertextPipeline.confirmed(body)
                        continue
                    }
                    when (o) {
                        HxOutcome.MISSING, HxOutcome.DISABLED -> { markUnavailable(o); revert(id, prev, null) }
                        HxOutcome.CONFLICT -> {
                            val d = (err as BackendException).details
                            adopt(id, d?.get("state") as? JsonObject, Hypertext.integerOf(d?.get("version"))?.toLong() ?: 0, true)
                            patch(id) { copy(pending = false, draft = null, confirm = null, error = HypertextPipeline.ERRORS["state_conflict"]) }
                        }
                        // Closed, used up, taken by someone else…: what was shown before the action comes back (a change
                        // made just before it is saved on its own), and the status is read again.
                        HxOutcome.REFETCH, HxOutcome.GONE -> { revert(id, prev, HypertextPipeline.errorText(err)); refetch(ch, listOf(id)) }
                        else -> revert(id, prev, if (o == HxOutcome.RETRY) HypertextPipeline.UNSENT else HypertextPipeline.errorText(err))
                    }
                    return@lane
                }
            }
        }
    }

    // ---- status ----
    private fun scheduleStatus(ms: Long = timing.statusDebounceMs) {
        statusTimer?.cancel()
        lateinit var timer: Job
        timer = later(ms) { if (statusTimer === timer) statusTimer = null; flushStatus() }
        statusTimer = timer
        timer.start()
    }
    private fun flushStatus() {
        val w = wanted ?: return
        val due = w.ids.filter { id -> entry(id)?.let { !it.fetching && (!it.loaded || it.stale) } == true }
        if (due.isNotEmpty()) refetch(w.channelId, due)
    }

    /** The cards loaded in the open window (kind hypertext, not recalled): their status is asked for those not asked
     *  yet; for all of them with [refresh] (a window opened). */
    fun track(channelId: String, ids: List<String>, refresh: Boolean = false) {
        val w = Wanted(channelId, ids.distinct()); wanted = w
        val s = flow.value; val cards = LinkedHashMap(s.cards)
        for (id in w.ids) {
            val e = cards[id]?.takeIf { it.channelId == channelId } ?: HxCard(channelId)
            cards[id] = if (refresh && e.loaded) e.copy(stale = true) else e
        }
        flow.value = s.copy(cards = cards)
        if (w.ids.isNotEmpty()) scheduleStatus()
    }
    /** The chat stream subscribed again: every tracked card's status is asked again. */
    fun resync() { wanted?.let { track(it.channelId, it.ids, true) } }
    /** Asks these cards' status now. They are marked as being asked at once, so no other request asks them again. */
    fun refetch(channelId: String, all: List<String>): Job {
        val ids = all.filter { entry(it) != null }
        if (ids.isEmpty()) return Job().apply { complete() }
        for (id in ids) patch(id) { copy(fetching = true, stale = false) }
        // Known to be unavailable: there is nothing to wait for.
        if (unavailable != null) { for (id in ids) patch(id) { copy(fetching = false, loaded = true) }; return Job().apply { complete() } }
        return jobs.launch { fetchStatus(channelId, ids) }
    }
    private suspend fun fetchStatus(channelId: String, ids: List<String>) {
        val alive = token()
        try {
            val r = api.status(channelId, ids)
            if (!alive()) return
            if (!r.enabled) { markUnavailable(HxOutcome.DISABLED); for (id in ids) patch(id) { copy(fetching = false, loaded = true) }; return }
            val byId = r.items.associateBy { it.messageId }
            for (id in ids) {
                val x = byId[id]
                if (x == null) { patch(id) { copy(fetching = false, loaded = true, gone = true) }; continue }
                patch(id) { copy(fetching = false, loaded = true, gone = false, closesAt = x.closesAt, closedAt = x.closedAt, closed = x.closed, runsLeft = x.runsLeft) }
                adopt(id, x.state, x.version, true)
            }
            // Cards marked stale while this was on its way are asked about again.
            if (wanted?.ids?.any { entry(it)?.stale == true } == true) scheduleStatus()
        } catch (c: CancellationException) { throw c } catch (err: Exception) {
            if (!alive()) return
            val o = HypertextPipeline.classify(err)
            if (o == HxOutcome.MISSING || o == HxOutcome.GONE || o == HxOutcome.DISABLED) {
                markUnavailable(if (o == HxOutcome.DISABLED) o else HxOutcome.MISSING)
                for (id in ids) patch(id) { copy(fetching = false, loaded = true) }
                return
            }
            for (id in ids) patch(id) { copy(fetching = false, stale = true) }
            scheduleStatus(timing.statusRetryMs)   // the controls stay "Loading…" until it arrives
        }
    }

    /** hypertext.state (this viewer's other devices, or the echo of a save): applied when it is newer. */
    fun applyState(id: String, state: JsonObject?, version: Long) = adopt(id, state, version)
    /** hypertext.closed. */
    fun applyClosed(id: String, closedAt: String) { if (entry(id) == null) return; patch(id) { copy(closedAt = closedAt) }; confirms[id]?.invoke(false) }
    /** Applies a card push; true for the two card types (handled, or for a card not loaded here, ignored), so the app
     *  returns before it marks a refresh as due. */
    fun onPush(e: RealtimeEvent): Boolean {
        HypertextPipeline.statePush(e)?.let { applyState(it.messageId, it.state, it.version); return true }
        HypertextPipeline.closedPush(e)?.let { applyClosed(it.messageId, it.closedAt); return true }
        return e.type == "hypertext.state" || e.type == "hypertext.closed"
    }

    /** A UI action on one control of a card; the job ends when the action is over (after any confirmation). */
    fun interact(ctx: HxContext, nodeId: String, action: HxAction): Job = jobs.launch { interactNow(ctx, nodeId, action) }
    private suspend fun interactNow(ctx: HxContext, nodeId: String, action: HxAction) {
        val id = ctx.message.id; val e = entry(id) ?: return
        if (!e.loaded || e.pending || e.confirm != null || unavailable != null) return
        val doc = ctx.doc; val prev = e.draft; val shown = HypertextPipeline.shownState(doc, e)
        val r = Hypertext.applyAction(doc, shown, nodeId, action, ctx.lock) ?: return
        val node = Hypertext.findNode(doc, nodeId) ?: return
        val handler = (node as? HxControl)?.on
        patch(id) { copy(error = null, notices = emptyList(), failure = if (handler != null) null else failure, logs = if (handler != null) emptyList() else logs) }
        // An input's draft on blur, or a control with nothing to run: the state alone, saved shortly.
        if (r.event == null || (handler == null && !(node is HxButton && node.act != null))) { setDraft(id, doc, r.state); scheduleSave(id); return }

        if (handler != null) {
            val raw = ctx.message.hypertext
            if (!ctx.engine || !engine || runner == null || raw == null) { patch(id) { copy(error = HypertextPipeline.NO_ENGINE) }; return }
            val alive = token()
            patch(id) { copy(pending = true, draft = r.state) }   // the control's own change shows while the script runs
            engineUsed = true
            val run = HypertextPipeline.run(runner, doc, raw, r.state, shown, handler, r.event, ctx.viewer)
            if (!alive()) return
            if (run is HxRunFailed) {
                // No WebAssembly here: the answer for the app session, and only `on` controls are lost.
                val none = run.error.code == "engine_unavailable"
                if (none) flow.value = flow.value.copy(engine = false)
                patch(id) { copy(pending = false, draft = prev, error = if (none) HypertextPipeline.NO_ENGINE else HypertextPipeline.FAILED, failure = run.error, logs = run.logs) }
                if (prev != null) scheduleSave(id)
                return
            }
            run as HxRunOk
            // Lines this viewer can no longer post (the card's runs are used up): nothing to confirm or send.
            if (run.effects.isNotEmpty() && entry(id)?.runsLeft == 0) { revert(id, prev, HypertextPipeline.ERRORS["runs_exhausted"]); patch(id) { copy(logs = run.logs) }; return }
            patch(id) { copy(notices = run.notices, logs = run.logs, failure = null) }
            setDraft(id, doc, run.state)
            if (run.effects.isEmpty()) { patch(id) { copy(pending = false) }; if (run.changed) scheduleSave(id, true); return }
            var confirmed = false
            val confirm = HypertextPipeline.confirmOf(run, ctx.dice)
            if (confirm != null) {
                val ok = ask(id, confirm)
                if (!alive()) return
                if (!ok) { revert(id, prev, null); patch(id) { copy(notices = emptyList()) }; return }
                confirmed = true
            }
            send(ctx, nodeId, run.effects, run.state, prev, confirmed)
            return
        }

        // A declarative act: set, then say and reply, checked like a script's effects before anything is sent.
        val a = Hypertext.act(doc, r.state, nodeId) ?: return
        val effects = when (val fx = Hypertext.checkEffects(doc, a.effects)) {
            is Hypertext.Bad -> { patch(id) { copy(error = HypertextPipeline.FAILED, failure = HxEngineError("invalid_effect", fx.error)) }; return }
            is Hypertext.Good -> fx.value
        }
        if (effects.isEmpty()) { setDraft(id, doc, a.state); scheduleSave(id, true); return }
        patch(id) { copy(pending = true, draft = a.state) }
        send(ctx, nodeId, effects, a.state, prev, false)
    }

    /** The viewer's answer to a confirmation ("Post" or "Cancel"). */
    fun answer(id: String, ok: Boolean) { confirms[id]?.invoke(ok) }

    /** A GM closes a card for everyone. A failure is thrown for the caller to show (the server's message). */
    suspend fun close(channelId: String, id: String) {
        val alive = token()
        try {
            val r = api.close(channelId, id)
            if (alive()) { patch(id) { copy(closedAt = r.closedAt, closesAt = r.closesAt) }; confirms[id]?.invoke(false) }
        } catch (c: CancellationException) { throw c } catch (err: Exception) {
            val o = HypertextPipeline.classify(err)
            if (alive() && (o == HxOutcome.MISSING || o == HxOutcome.DISABLED)) markUnavailable(o)
            throw err
        }
    }

    fun reset() {
        gen++
        jobs.cancel()
        jobs = newJobs()
        saveTimers.clear(); lanes.clear(); inflight.clear()
        statusTimer = null; wanted = null
        val waiting = confirms.values.toList(); confirms.clear()
        flow.value = flow.value.copy(cards = emptyMap(), unavailable = null)
        for (r in waiting) r(false)
        // The engine page goes with the session (it is started again by the next script, if any).
        if (engineUsed) { engineUsed = false; runner?.dispose() }
    }
}
