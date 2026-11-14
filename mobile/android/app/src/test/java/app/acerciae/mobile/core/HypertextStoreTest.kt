package app.acerciae.mobile.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.Executors

/** Interactive messages: the action pipeline (core/HypertextStore.kt), with stand-ins for the card routes, the chat and
 *  the engine page. The same cases as the web store's (frontend/tests/hypertext-store.test.cjs): one interaction id per
 *  action reused by its retries, 428 confirm-and-resend, 409 adopt, partial results, newer pushes only, resets that drop
 *  late answers, the feature marked unavailable on an older or switched-off server, coalesced saves. */
class HypertextStoreTest {
    private val pool = Executors.newSingleThreadExecutor()
    private val main = pool.asCoroutineDispatcher()
    @After fun stop() { pool.shutdownNow() }

    /** A request the test answers. */
    class Pending(val kind: String, val channel: String, val id: String?, val ids: List<String>, val body: JsonObject?) {
        val reply = CompletableDeferred<Any>()
        fun resolve(value: Any) { reply.complete(value) }
        fun reject(e: Throwable) { reply.completeExceptionally(e) }
    }
    inner class Harness(engineAvailable: Boolean = true) {
        val pending = mutableMapOf<String, ArrayDeque<Pending>>()
        val pushed = mutableListOf<Message>()
        val runs = mutableListOf<JsonObject>()
        var result: (JsonObject) -> String = { error("no engine result") }
        var disposed = 0
        private suspend fun wait(p: Pending): Any { pending.getOrPut(p.kind) { ArrayDeque() }.addLast(p); return p.reply.await() }
        val api = object : HypertextApi {
            override suspend fun status(channel: String, ids: List<String>) = wait(Pending("status", channel, null, ids, null)) as HypertextStatus
            override suspend fun save(channel: String, message: String, state: JsonObject, baseVersion: Long) =
                wait(Pending("save", channel, message, emptyList(), buildJsonObject { put("state", state); put("base_version", baseVersion) })) as HypertextSaved
            override suspend fun act(channel: String, message: String, body: JsonObject) = wait(Pending("act", channel, message, emptyList(), body)) as HypertextActResult
            override suspend fun close(channel: String, message: String) = wait(Pending("close", channel, message, emptyList(), null)) as HypertextClosed
        }
        val runner = object : HypertextRunner {
            override suspend fun run(request: String): String { val r = Json.parseToJsonElement(request).jsonObject; runs.add(r); return result(r) }
            override fun dispose() { disposed++ }
        }
        val scope = CoroutineScope(SupervisorJob() + main)
        val store = HypertextStore(api, if (engineAvailable) runner else null, scope, HxTiming(statusDebounceMs = 0, saveDebounceMs = 30, retryMs = listOf(1, 2, 3), statusRetryMs = 10), { pushed.add(it) })
        fun card(id: String = "m1") = store.cards[id]
        fun count(kind: String) = pending[kind]?.size ?: 0
        suspend fun next(kind: String, label: String = kind): Pending { until(label) { count(kind) > 0 }; return pending.getValue(kind).removeFirst() }
        suspend fun loaded(id: String = "m1", item: HypertextStatusItem = item(id)) {
            store.track("c", listOf(id))
            next("status").resolve(HypertextStatus(true, listOf(item)))
            until("status") { card(id)?.loaded == true }
        }
    }
    private suspend fun until(label: String, cond: () -> Boolean) { repeat(1000) { if (cond()) return; delay(2) }; fail("timed out waiting for $label") }
    private suspend fun tick() = repeat(30) { yield(); delay(1) }
    private fun test(body: suspend CoroutineScope.() -> Unit) = runBlocking(main) { withTimeout(20_000) { body() } }

    companion object {
        val RAW = Json.parseToJsonElement("""{"v":1,"title":"The study",
            "state":{"seen":{"type":"bool"},"done":{"type":"bool"},"pick":{"type":"enum","values":[{"value":"a"},{"value":"b"}]}},
            "body":[
              {"type":"checkbox","id":"seen_box","label":"Seen","bind":"seen"},
              {"type":"choice","id":"pick_box","label":"Pick","bind":"pick","display":"buttons"},
              {"type":"button","id":"roll","label":"Roll","act":{"set":{"done":true},"say":".ra Spot Hidden"},"enable_if":{"key":"done","eq":false}},
              {"type":"button","id":"sanity","label":"Sanity","act":{"say":".sc 1/1d6"}},
              {"type":"button","id":"mark","label":"Mark","act":{"set":{"done":true}}},
              {"type":"button","id":"go","label":"Go","on":"go"}],
            "script":"on('go', () => { say('I open the door.'); state.done = true; })"}""").jsonObject
        val DOC = Hypertext.parseDoc(RAW)!!
        fun state(seen: Boolean = false, done: Boolean = false, pick: String? = null) = buildJsonObject { put("seen", seen); put("done", done); put("pick", pick) }
        val DEFAULT = state()
        fun item(id: String, state: JsonObject? = null, version: Long = 0, runsLeft: Int? = 1, closedAt: String? = null) =
            HypertextStatusItem(id, "2099-01-01T00:00:00Z", closedAt, closedAt != null, state, version, runsLeft)
        fun card(id: String = "m1") = Message(id = id, content = "The study", authorName = "GM", kind = Hypertext.KIND, seq = 1, channelId = "c", hypertext = RAW, chatWindowId = "w")
        fun ctx(id: String = "m1", lock: HxLockReason? = null, engine: Boolean = true, say: String? = null, dice: Boolean = true) =
            HxContext("c", card(id), DOC, lock, HxViewer(gm = false, actor = true, character = "Ada"), engine, say, dice)
        fun line(id: String) = buildJsonObject { put("id", id); put("content", ".ra Spot Hidden"); put("author_name", "Ada"); put("kind", "roll"); put("seq", 2); put("channel_id", "c"); put("chat_window_id", "w"); put("via_hypertext_id", "m1") }
        fun acted(state: JsonObject?, version: Long, vararg lines: JsonObject?, partial: Boolean = false) =
            HypertextActResult("i", false, partial, lines.map { HypertextLine("say", it != null, it) }, state?.let { HypertextVersioned(it, version) })
        fun refused(status: Int, code: String, details: JsonObject = JsonObject(emptyMap()), api: Boolean = true) =
            BackendException(status, api, if (api) code else "", if (api) JsonObject(details + ("error" to JsonPrimitive(code))) else null)
        fun output(state: JsonObject, vararg effects: JsonObject, notices: List<String> = emptyList(), logs: List<String> = emptyList()) = buildJsonObject {
            put("ok", true); put("state", state); put("effects", JsonArray(effects.toList())); put("notices", JsonArray(notices.map(::JsonPrimitive))); put("logs", JsonArray(logs.map(::JsonPrimitive)))
        }.toString()
        fun say(text: String, kind: String = "ic") = buildJsonObject { put("type", "say"); put("text", text); put("kind", kind) }
        val UUID_V4 = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    }

    // ---- the pure decisions ----

    @Test fun classifyEveryAnswerOfTheCardRoutes() {
        val o = HypertextPipeline::classify
        assertEquals(HxOutcome.RETRY, o(IOException("offline"))); assertEquals(HxOutcome.RETRY, o(java.net.SocketTimeoutException()))
        assertEquals(HxOutcome.RETRY, o(refused(408, "request_timeout"))); assertEquals(HxOutcome.RETRY, o(refused(502, "", api = false))); assertEquals(HxOutcome.RETRY, o(refused(500, "internal")))
        assertEquals(HxOutcome.RETRY, o(refused(409, "interaction_in_progress")))
        assertEquals(HxOutcome.MISSING, o(refused(405, "", api = false))); assertEquals(HxOutcome.MISSING, o(refused(404, "", api = false)))
        assertEquals(HxOutcome.DISABLED, o(refused(403, "feature_disabled"))); assertEquals(HxOutcome.FAIL, o(refused(403, "not_an_actor")))
        assertEquals(HxOutcome.GONE, o(refused(404, "not_found")))
        assertEquals(HxOutcome.CONFIRM, o(refused(428, "confirmation_required")))
        assertEquals(HxOutcome.CONFLICT, o(refused(409, "state_conflict")))
        for (c in listOf("hypertext_closed", "runs_exhausted", "reply_exhausted", "interaction_mismatch", "sender_unavailable", "conflict")) assertEquals(c, HxOutcome.REFETCH, o(refused(409, c)))
        for (s in listOf(400, 429)) assertEquals(HxOutcome.FAIL, o(refused(s, "x")))
        // The sentence: the catalog's for a known code, else the server's own words, else the generic one.
        assertEquals("You already used this.", HypertextPipeline.errorText(refused(409, "runs_exhausted")))
        assertEquals("Too many actions. Try again in a moment.", HypertextPipeline.errorText(refused(429, "rate_limited")))
        assertEquals("Slot n is out of range", HypertextPipeline.errorText(refused(400, "invalid_slot", buildJsonObject { put("message", "Slot n is out of range") })))
        assertEquals("This message's action failed.", HypertextPipeline.errorText(refused(400, "", api = false)))
    }

    @Test fun statesVersionsBodiesAndConfirmations() {
        assertTrue(HypertextPipeline.sameState(state(seen = true), buildJsonObject { put("pick", JsonNull); put("done", false); put("seen", true) }))
        assertFalse(HypertextPipeline.sameState(state(), state(seen = true)))
        assertTrue(HypertextPipeline.sameState(null, null)); assertFalse(HypertextPipeline.sameState(state(), null))
        val sets = Json.parseToJsonElement("""{"t":["a","b"]}""").jsonObject
        assertTrue(HypertextPipeline.sameState(sets, Json.parseToJsonElement("""{"t":["a","b"]}""").jsonObject))
        assertFalse(HypertextPipeline.sameState(sets, Json.parseToJsonElement("""{"t":["b","a"]}""").jsonObject))
        assertEquals(DEFAULT, HypertextPipeline.shownState(DOC, null))
        assertEquals(state(pick = "a"), HypertextPipeline.shownState(DOC, HxCard("c", state = Json.parseToJsonElement("""{"pick":"a","extra":1}""").jsonObject)))
        assertEquals(state(seen = true), HypertextPipeline.shownState(DOC, HxCard("c", state = DEFAULT, draft = state(seen = true))))
        assertTrue(HypertextPipeline.newer(2, 1)); assertFalse(HypertextPipeline.newer(1, 1)); assertTrue(HypertextPipeline.newer(1, 1, orEqual = true)); assertFalse(HypertextPipeline.newer(0, 1, true))
        assertEquals(listOf(null, 0, 0, 4), listOf(null, 0, 1, 5).map(HypertextPipeline::runsAfter))
        val body = HypertextPipeline.actBody("x", "roll", listOf(HxSay(".ra Spot Hidden", "ic"), HxReply("hint", buildJsonObject { put("n", 2) })), DEFAULT, 3, characterId = "bea")
        assertEquals(Json.parseToJsonElement("""{"interaction_id":"x","node":"roll","base_version":3,"state":{"seen":false,"done":false,"pick":null},
            "say":{"text":".ra Spot Hidden","kind":"ic","character_id":"bea"},"reply":{"id":"hint","slots":{"n":2}}}"""), body)
        val again = HypertextPipeline.confirmed(body)
        assertEquals(JsonPrimitive(true), again.getValue("say").jsonObject["confirmed"]); assertEquals(body["reply"], again["reply"]); assertEquals("x", again.text("interaction_id"))
        assertNull(HypertextPipeline.actBody("x", "n", emptyList(), DEFAULT, 0)["say"])
        // A 428 asks with the server's text, and warns of the sheet unless it says sheet:false.
        assertEquals(HxConfirm(".sc 1/1d6", "ic", sheet = true), HypertextPipeline.confirmOf428(refused(428, "confirmation_required", buildJsonObject { put("text", ".sc 1/1d6") }), body))
        assertEquals(HxConfirm(".ra Spot Hidden", "ic"), HypertextPipeline.confirmOf428(refused(428, "confirmation_required", buildJsonObject { put("sheet", false) }), body))
        assertNull(HypertextPipeline.confirmOf428(refused(428, "confirmation_required"), HypertextPipeline.actBody("x", "n", listOf(HxReply("r", JsonObject(emptyMap()))), DEFAULT, 0)))
        // With the server's dice off, any say from a script is confirmed (and changes no sheet).
        val run = HxRunOk(DEFAULT, listOf(HxSay(".ra Spot Hidden", "ic")), emptyList(), emptyList(), null, false)
        assertNull(HypertextPipeline.confirmOf(run)); assertEquals(HxConfirm(".ra Spot Hidden", "ic"), HypertextPipeline.confirmOf(run, dice = false))
        assertTrue(UUID_V4.matches(HypertextPipeline.newInteractionId()))
        // The engine request carries the card as stored and the two states, nothing else.
        val request = Json.parseToJsonElement(HypertextPipeline.engineRequest(RAW, state(done = true), DEFAULT, "go", HxEvent("click", "go", JsonNull), HxViewer(false, true, "Ada"))).jsonObject
        assertEquals(listOf("doc", "state", "prev", "handler", "event", "viewer"), request.keys.toList())
        assertEquals(RAW, request["doc"]); assertEquals(buildJsonObject { put("gm", false); put("actor", true); put("character", "Ada") }, request["viewer"])
    }

    @Test fun theEngineRunIsCappedAndCheckedHere() = runBlocking {
        val doc = DOC
        suspend fun run(answer: suspend (String) -> String) = HypertextPipeline.run(object : HypertextRunner { override suspend fun run(request: String) = answer(request) }, doc, RAW, state(done = true), DEFAULT, "go", HxEvent("click", "go", JsonNull), HxViewer(false, true, null))
        val ok = run { output(state(done = true), say("I open the door.")) } as HxRunOk
        assertEquals(HxConfirm("I open the door.", "ic"), ok.confirm); assertTrue(ok.changed)
        assertEquals("timeout", (run { throw HypertextRunFailure("timeout", "the script did not finish in time") } as HxRunFailed).error.code)
        assertEquals("engine", (run { throw HypertextRunFailure("odd", "x") } as HxRunFailed).error.code)
        assertEquals("engine", (run { throw IllegalStateException("page gone") } as HxRunFailed).error.code)
        assertEquals("invalid_effect", (run { "x".repeat(70_000) } as HxRunFailed).error.code)
        val huge = JsonObject(RAW + ("script" to JsonPrimitive("x".repeat(70_000))))
        assertEquals("invalid_state", (HypertextPipeline.run(object : HypertextRunner { override suspend fun run(request: String) = error("not sent") }, doc, huge, DEFAULT, DEFAULT, "go", HxEvent("click", "go", JsonNull), HxViewer(false, true, null)) as HxRunFailed).error.code)
    }

    // ---- the store ----

    @Test fun statusIsAskedOncePerCardAgainForAllOnRefreshAndResync() = test {
        val h = Harness()
        h.store.track("c", listOf("a", "b"))
        assertEquals("controls wait for the status", false, h.card("a")!!.loaded)
        val first = h.next("status")
        assertEquals(listOf("c", listOf("a", "b")), listOf(first.channel, first.ids))
        first.resolve(HypertextStatus(true, listOf(item("a", state(seen = true), 2, 0))))
        until("loaded") { h.card("a")!!.loaded && h.card("b")!!.loaded }
        assertEquals(listOf(state(seen = true), 2L, 0), h.card("a")!!.let { listOf(it.state, it.version, it.runsLeft) })
        assertTrue("a card left out of the status is gone", h.card("b")!!.gone)
        h.store.track("c", listOf("a", "b", "c3"))
        val second = h.next("status")
        assertEquals(listOf("c3"), second.ids)
        second.resolve(HypertextStatus(true, listOf(item("c3"))))
        until("c3") { h.card("c3")!!.loaded }
        h.store.track("c", listOf("a", "b", "c3")); tick()
        assertEquals("nothing new: nothing asked", 0, h.count("status"))
        h.store.resync()
        val third = h.next("status")
        assertEquals(listOf("a", "b", "c3"), third.ids)
        third.resolve(HypertextStatus(true, listOf(item("a", state(), 3), item("b"), item("c3", closedAt = "2026-01-01T00:00:00Z"))))
        until("refresh adopted") { h.card("a")!!.version == 3L }
        assertFalse(h.card("b")!!.gone); assertEquals("2026-01-01T00:00:00Z", h.card("c3")!!.closedAt)
        // A failed status request is tried again later; the controls stay "Loading…" meanwhile.
        h.store.track("c", listOf("d"))
        h.next("status").reject(IOException("offline"))
        tick(); assertFalse(h.card("d")!!.loaded)
        val retry = h.next("status", "status retry")
        assertEquals(listOf("d"), retry.ids)
        retry.resolve(HypertextStatus(true, listOf(item("d"))))
        until("d") { h.card("d")!!.loaded }
    }

    @Test fun plainChangesAreOneCoalescedPutAndOnlyANewerPushWins() = test {
        val h = Harness()
        h.loaded(item = item("m1", state(), 2))
        val s = h.store
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        s.interact(ctx(), "pick_box", HxAction.Select("b")).join()
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        assertEquals("shown at once", state(seen = true, pick = "b"), h.card()!!.draft)
        val put = h.next("save")
        assertEquals(buildJsonObject { put("state", state(seen = true, pick = "b")); put("base_version", 2) }, put.body)
        tick(); assertEquals("one request for the four changes", 0, h.count("save"))
        put.resolve(HypertextSaved("m1", state(seen = true, pick = "b"), 3))
        until("saved") { h.card()!!.version == 3L }
        assertNull("nothing left to save", h.card()!!.draft)
        // Pushes: only a newer version applies.
        s.applyState("m1", state(done = true, pick = "a"), 5)
        s.applyState("m1", state(seen = true, done = true, pick = "b"), 4)
        s.applyState("m1", state(seen = true, done = true, pick = "b"), 5)
        assertEquals(listOf(state(done = true, pick = "a"), 5L), listOf(h.card()!!.state, h.card()!!.version))
        // A save refused because another device saved first adopts the stored state.
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        val conflicting = h.next("save")
        assertEquals(JsonPrimitive(5), conflicting.body!!["base_version"])
        conflicting.reject(refused(409, "state_conflict", buildJsonObject { put("state", state(pick = "b")); put("version", 7) }))
        until("conflict adopted") { h.card()!!.version == 7L }
        assertEquals(listOf(state(pick = "b"), null, "This message changed on another device."), h.card()!!.let { listOf(it.state, it.draft, it.error) })
        s.applyClosed("m1", "2026-11-14T00:00:00Z")
        assertEquals("2026-11-14T00:00:00Z", h.card()!!.closedAt)
    }

    @Test fun aNetworkFailureRetriesTheActionWithTheSameIdThenItsLinesAreMergedAndTheStateAdopted() = test {
        val h = Harness()
        h.loaded(item = item("m1", runsLeft = 2))
        val done = h.store.interact(ctx(), "roll", HxAction.Click)
        val first = h.next("act")
        assertTrue(h.card()!!.pending)
        assertEquals("the new state shows while it is sent", state(done = true), h.card()!!.draft)
        assertEquals(Json.parseToJsonElement("""{"interaction_id":"x","node":"roll","base_version":0,"state":{"seen":false,"done":true,"pick":null},"say":{"text":".ra Spot Hidden","kind":"ic"}}"""),
            JsonObject(first.body!! + ("interaction_id" to JsonPrimitive("x"))))
        assertTrue(UUID_V4.matches(first.body!!.text("interaction_id")))
        // Ignored meanwhile: one action per card at a time.
        h.store.interact(ctx(), "seen_box", HxAction.Toggle).join()
        first.reject(IOException("offline"))
        val second = h.next("act"); second.reject(refused(502, "", api = false))
        val third = h.next("act"); third.reject(refused(409, "interaction_in_progress"))
        val fourth = h.next("act")
        assertEquals("every retry sends the same action", listOf(first.body, first.body, first.body), listOf(second, third, fourth).map { it.body })
        fourth.resolve(acted(state(done = true), 1, line("r1")))
        done.join()
        assertEquals("the posted line goes into the chat", listOf("r1"), h.pushed.map { it.id })
        assertEquals("m1", h.pushed.single().viaHypertextId)
        assertEquals(listOf(false, null, 1L, state(done = true), 1, null), h.card()!!.let { listOf(it.pending, it.draft, it.version, it.state, it.runsLeft, it.error) })
        assertEquals(0, h.count("save"))
    }

    @Test fun afterThreeRetriesTheActionRevertsAndARefusalRevertsWithItsReason() = test {
        val h = Harness()
        h.loaded()
        val done = h.store.interact(ctx(), "roll", HxAction.Click)
        val ids = mutableSetOf<String>()
        repeat(4) { val r = h.next("act"); ids.add(r.body!!.text("interaction_id")); r.reject(IOException("offline")) }
        done.join()
        assertEquals(1, ids.size)
        assertEquals(listOf(false, null, "This message's action could not be sent. Check your connection."), h.card()!!.let { listOf(it.pending, it.draft, it.error) })
        assertEquals("no fifth attempt", 0, h.count("act"))
        val again = h.store.interact(ctx(), "roll", HxAction.Click)
        val r = h.next("act")
        assertFalse("a new action has a new id", r.body!!.text("interaction_id") in ids)
        r.reject(refused(403, "not_an_actor"))
        again.join()
        assertEquals(listOf(null, "This message is for other characters."), h.card()!!.let { listOf(it.draft, it.error) })
    }

    @Test fun on428TheViewerConfirmsAndTheSameActionIsSentAgainConfirmedCancellingSendsNothing() = test {
        val h = Harness()
        h.loaded()
        val done = h.store.interact(ctx(), "sanity", HxAction.Click)
        val first = h.next("act")
        assertNull(first.body!!.getValue("say").jsonObject["confirmed"])
        first.reject(refused(428, "confirmation_required", buildJsonObject { put("text", ".sc 1/1d6") }))
        until("confirm") { h.card()!!.confirm != null }
        assertEquals(HxConfirm(".sc 1/1d6", "ic", sheet = true), h.card()!!.confirm)
        h.store.answer("m1", true)
        val second = h.next("act")
        assertEquals(first.body!!.text("interaction_id"), second.body!!.text("interaction_id"))
        assertEquals(Json.parseToJsonElement("""{"text":".sc 1/1d6","kind":"ic","confirmed":true}"""), second.body!!["say"])
        second.resolve(acted(DEFAULT, 1, line("s1")))
        done.join()
        assertNull(h.card()!!.confirm)
        val cancelled = h.store.interact(ctx(), "sanity", HxAction.Click)
        h.next("act").reject(refused(428, "confirmation_required", buildJsonObject { put("text", ".sc 1/1d6") }))
        until("confirm 2") { h.card()!!.confirm != null }
        h.store.answer("m1", false)
        cancelled.join(); tick()
        assertEquals(0, h.count("act"))
        assertEquals(listOf(false, null, null), h.card()!!.let { listOf(it.pending, it.confirm, it.draft) })
    }

    @Test fun on409TheStateIsAdoptedFromTheRefusalOrTheStatusAskedAgain() = test {
        val h = Harness()
        h.loaded()
        var done = h.store.interact(ctx(), "roll", HxAction.Click)
        h.next("act").reject(refused(409, "state_conflict", buildJsonObject { put("state", state(true, true, "a")); put("version", 4) }))
        done.join()
        assertEquals(listOf(state(true, true, "a"), 4L, null, false), h.card()!!.let { listOf(it.state, it.version, it.draft, it.pending) })
        done = h.store.interact(ctx(), "sanity", HxAction.Click)
        val act = h.next("act")
        assertEquals("from the version adopted", JsonPrimitive(4), act.body!!["base_version"])
        act.reject(refused(409, "runs_exhausted"))
        done.join()
        assertEquals("You already used this.", h.card()!!.error)
        val st = h.next("status")
        assertEquals(listOf("m1"), st.ids)
        st.resolve(HypertextStatus(true, listOf(item("m1", state(true, true, "b"), 5, 0))))
        until("refetched") { h.card()!!.version == 5L }
        assertEquals(0, h.card()!!.runsLeft)
    }

    @Test fun partialResultsMergeWhatWasPostedAndSayTheRestFailed() = test {
        val h = Harness()
        h.loaded()
        val done = h.store.interact(ctx(), "roll", HxAction.Click)
        h.next("act").resolve(HypertextActResult("i", false, true, listOf(HypertextLine("say", true, line("p1")), HypertextLine("reply", false, null, buildJsonObject { put("error", "internal") })), HypertextVersioned(state(done = true), 1)))
        done.join()
        assertEquals(listOf("p1"), h.pushed.map { it.id })
        assertEquals(listOf(1L, "Part of this action could not be posted.", false), h.card()!!.let { listOf(it.version, it.error, it.pending) })
        // A line the viewer may not read (a GM-only reply) comes back as null and is not merged.
        val again = h.store.interact(ctx(), "sanity", HxAction.Click)
        h.next("act").resolve(acted(null, 0, null))
        again.join()
        assertEquals(1, h.pushed.size)
    }

    @Test fun aScriptHandlersStateAndNoticesShowItsFreeTextWaitsForTheViewerThenTheActionIsSent() = test {
        val h = Harness()
        h.loaded()
        h.result = { r -> output(JsonObject(r.getValue("state").jsonObject + ("done" to JsonPrimitive(true))), say("I open the door."), notices = listOf("Creak."), logs = listOf("ran")) }
        val done = h.store.interact(ctx(), "go", HxAction.Click)
        until("confirm") { h.card()!!.confirm != null }
        val run = h.runs[0]
        assertEquals(listOf(JsonPrimitive("go"), HxEvent("click", "go", JsonNull).json(), HxViewer(false, true, "Ada").json()), listOf(run["handler"], run["event"], run["viewer"]))
        assertEquals(RAW, run["doc"]); assertEquals("prev is the state shown before the action", DEFAULT, run["prev"])
        assertEquals(listOf(listOf("Creak."), listOf("ran"), state(done = true)), h.card()!!.let { listOf(it.notices, it.logs, it.draft) })
        assertEquals(HxConfirm("I open the door.", "ic"), h.card()!!.confirm)
        assertEquals("nothing is sent before the viewer confirms", 0, h.count("act"))
        h.store.answer("m1", true)
        val act = h.next("act")
        assertEquals(Json.parseToJsonElement("""{"text":"I open the door.","kind":"ic","confirmed":true}"""), act.body!!["say"])
        act.resolve(acted(state(done = true), 1, line("d1")))
        done.join()
        // A failing script: reverted, nothing sent, the details kept for GMs.
        h.result = { """{"ok":false,"error":{"code":"script_error","message":"boom","line":1},"logs":["before"]}""" }
        h.store.interact(ctx(), "go", HxAction.Click).join()
        assertEquals(listOf("This message's action failed.", HxEngineError("script_error", "boom", 1), listOf("before"), null, false), h.card()!!.let { listOf(it.error, it.failure, it.logs, it.draft, it.pending) })
        assertEquals(0, h.count("act"))
        // A forged result is refused here even though the page said it was fine.
        h.result = { r -> output(r.getValue("state").jsonObject, say(".st STR 99")) }
        h.store.interact(ctx(), "go", HxAction.Click).join()
        assertEquals(listOf("This message's action failed.", "invalid_effect"), h.card()!!.let { listOf(it.error, it.failure?.code) })
        // No effects: the changed state is saved by a PUT.
        h.result = { r -> output(JsonObject(r.getValue("state").jsonObject + ("pick" to JsonPrimitive("a")))) }
        h.store.interact(ctx(), "go", HxAction.Click).join()
        assertEquals(state(done = true, pick = "a"), h.next("save").body!!["state"])
        // Without the engine on this device, a handler does not run.
        val before = h.runs.size
        h.store.interact(ctx(engine = false), "go", HxAction.Click).join()
        assertEquals(before, h.runs.size)
        assertEquals("Interactive actions are unavailable on this device.", h.card()!!.error)
    }

    @Test fun theFirstEngineUnavailableIsTheAnswerForTheSession() = test {
        val h = Harness()
        h.loaded()
        assertTrue(h.store.engine)
        h.result = { """{"ok":false,"error":{"code":"engine_unavailable","message":"WebAssembly is not available on this device"}}""" }
        h.store.interact(ctx(), "go", HxAction.Click).join()
        assertFalse(h.store.engine)
        assertEquals(listOf("Interactive actions are unavailable on this device.", false, null), h.card()!!.let { listOf(it.error, it.pending, it.draft) })
        h.store.reset()
        assertFalse("kept across resets", h.store.engine)
        assertFalse("no runner: no engine", Harness(engineAvailable = false).store.engine)
        // Declarative cards keep working.
        h.loaded()
        h.store.interact(ctx(), "mark", HxAction.Click).join()
        assertEquals(state(done = true), h.next("save").body!!["state"])
    }

    @Test fun aResetDropsLateAnswersCancelsConfirmationsAndStopsTheEngine() = test {
        val h = Harness()
        h.loaded()
        val act = h.store.interact(ctx(), "roll", HxAction.Click)
        val sent = h.next("act")
        h.store.track("c", listOf("m1", "m2"))
        val late = h.next("status")
        h.result = { r -> output(r.getValue("state").jsonObject, say("Hi")) }
        h.store.track("c", listOf("m3"))
        h.next("status").resolve(HypertextStatus(true, listOf(item("m3"))))
        until("m3") { h.card("m3")?.loaded == true }
        val asking = h.store.interact(ctx("m3"), "go", HxAction.Click)
        until("confirm") { h.card("m3")!!.confirm != null }
        h.store.reset()
        assertEquals(emptyMap<String, HxCard>(), h.store.cards)
        assertEquals("the engine page goes with the session", 1, h.disposed)
        asking.join()
        sent.resolve(acted(DEFAULT, 1, line("late")))
        late.resolve(HypertextStatus(true, listOf(item("m1"), item("m2"))))
        act.join(); tick()
        assertEquals("nothing from before the reset comes back", emptyMap<String, HxCard>(), h.store.cards)
        assertEquals(emptyList<Message>(), h.pushed)
        assertEquals(0, h.count("act"))
        h.store.applyState("m1", state(seen = true), 9)
        assertNull("pushes for cards not tracked are ignored", h.card("m1"))
    }

    @Test fun theFeatureIsUnavailableOnAnOlderOrSwitchedOffServerButTheApisOwn404IsACardGone() = test {
        var h = Harness()
        h.store.track("c", listOf("m1"))
        h.next("status").reject(refused(404, "", api = false))
        until("loaded") { h.card()?.loaded == true }
        assertEquals(HxUnavailable.MISSING, h.store.unavailable)
        h.store.interact(ctx(), "roll", HxAction.Click).join()
        assertEquals("nothing is sent while unavailable", 0, h.count("act"))

        h = Harness()
        h.store.track("c", listOf("m1"))
        h.next("status").resolve(HypertextStatus(false, emptyList()))
        until("loaded") { h.card()?.loaded == true }
        assertEquals(HxUnavailable.DISABLED, h.store.unavailable)

        h = Harness()
        h.loaded()
        var done = h.store.interact(ctx(), "roll", HxAction.Click)
        h.next("act").reject(refused(403, "feature_disabled"))
        done.join()
        assertEquals(listOf(HxUnavailable.DISABLED, null, false), listOf(h.store.unavailable, h.card()!!.draft, h.card()!!.pending))

        h = Harness()
        h.loaded()
        h.store.interact(ctx(), "seen_box", HxAction.Toggle).join()
        h.next("save").reject(refused(405, "", api = false))
        until("missing") { h.store.unavailable == HxUnavailable.MISSING }
        assertNull(h.card()!!.draft)

        h = Harness()
        h.loaded()
        done = h.store.interact(ctx(), "roll", HxAction.Click)
        h.next("act").reject(refused(404, "not_found"))
        done.join()
        assertNull(h.store.unavailable)
        h.next("status").resolve(HypertextStatus(true, emptyList()))
        until("gone") { h.card()!!.gone }
    }

    @Test fun aDeclarativeActThatPostsNothingIsAPutAndClosingAdoptsTheClosingTime() = test {
        val h = Harness()
        h.loaded()
        h.store.interact(ctx(), "mark", HxAction.Click).join()
        val put = h.next("save")
        assertEquals(buildJsonObject { put("state", state(done = true)); put("base_version", 0) }, put.body)
        assertEquals(0, h.count("act"))
        put.resolve(HypertextSaved("m1", state(done = true), 1))
        until("saved") { h.card()!!.version == 1L }
        h.store.interact(ctx(lock = HxLockReason.CLOSED), "seen_box", HxAction.Toggle).join(); tick()
        assertNull("a control the lock disables does nothing", h.card()!!.draft)
        val closing = async { h.store.close("c", "m1") }
        h.next("close").resolve(HypertextClosed("m1", "2099-01-01T00:00:00Z", "2026-11-14T10:00:00Z", "gm", true))
        closing.await()
        assertEquals("2026-11-14T10:00:00Z", h.card()!!.closedAt)
        // A refused close is thrown for the app to show; an older server is marked as such.
        val failing = async { runCatching { h.store.close("c", "m1") }.exceptionOrNull() }
        h.next("close").reject(refused(405, "", api = false))
        assertTrue(failing.await() is BackendException)
        assertEquals(HxUnavailable.MISSING, h.store.unavailable)
    }

    @Test fun aChangeBackWhileASaveIsOnItsWayIsSavedToo() = test {
        val h = Harness()
        h.loaded(item = item("m1", state(), 2))
        val s = h.store
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        val first = h.next("save")
        assertEquals(buildJsonObject { put("state", state(seen = true)); put("base_version", 2) }, first.body)
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        assertEquals("the untick shows and is kept to be saved", state(), h.card()!!.draft)
        first.resolve(HypertextSaved("m1", state(seen = true), 3))
        val second = h.next("save", "the second save")
        assertEquals(buildJsonObject { put("state", state()); put("base_version", 3) }, second.body)
        second.resolve(HypertextSaved("m1", state(), 4))
        until("saved again") { h.card()!!.version == 4L }
        assertNull(h.card()!!.draft)
        tick(); assertEquals("nothing more to save", 0, h.count("save"))
        // Without a save on its way, a change back to the server's copy needs no request.
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        s.interact(ctx(), "seen_box", HxAction.Toggle).join()
        assertNull(h.card()!!.draft)
        delay(30); assertEquals(0, h.count("save"))
    }

    @Test fun anActionRefusedAsUsedUpKeepsTheChangeMadeJustBeforeItAndSavesIt() = test {
        val h = Harness()
        h.loaded()
        h.store.interact(ctx(), "seen_box", HxAction.Toggle).join()     // its save is still waiting for its timer…
        val done = h.store.interact(ctx(), "sanity", HxAction.Click)      // …and goes with the action
        val act = h.next("act")
        assertEquals(JsonPrimitive(true), act.body!!.getValue("state").jsonObject["seen"])
        act.reject(refused(409, "reply_exhausted"))
        done.join()
        assertEquals(listOf(state(seen = true), "This answer is no longer available."), h.card()!!.let { listOf(it.draft, it.error) })
        assertEquals("the tick saved on its own", state(seen = true), h.next("save").body!!["state"])
        assertEquals(listOf("m1"), h.next("status").ids)
    }

    @Test fun aScriptWhoseLinesCanNoLongerBePostedAsksNothingAndSendsNothing() = test {
        val h = Harness()
        h.loaded(item = item("m1", runsLeft = 0))
        h.result = { r -> output(JsonObject(r.getValue("state").jsonObject + ("done" to JsonPrimitive(true))), say("brb, need a sec", "ooc"), notices = listOf("Hm."), logs = listOf("ran")) }
        h.store.interact(ctx(), "go", HxAction.Click).join()
        assertEquals(listOf(null, false, null, "You already used this.", emptyList<String>(), listOf("ran")), h.card()!!.let { listOf(it.confirm, it.pending, it.draft, it.error, it.notices, it.logs) })
        tick(); assertEquals(0, h.count("act") + h.count("save"))
        h.result = { r -> output(JsonObject(r.getValue("state").jsonObject + ("pick" to JsonPrimitive("a")))) }
        h.store.interact(ctx(), "go", HxAction.Click).join()
        assertEquals(state(pick = "a"), h.next("save").body!!["state"])
    }

    @Test fun theLineGoesOutAsTheComposersCharacterAndWithDiceOffEveryScriptLineIsConfirmed() = test {
        val h = Harness()
        h.loaded(item = item("m1", runsLeft = 5))
        var done = h.store.interact(ctx(say = "bea"), "roll", HxAction.Click)
        var act = h.next("act")
        assertEquals(Json.parseToJsonElement("""{"text":".ra Spot Hidden","kind":"ic","character_id":"bea"}"""), act.body!!["say"])
        act.resolve(acted(state(done = true), 1))
        done.join()
        assertEquals(listOf<Any?>(1L, 4), h.card()!!.let { listOf(it.version, it.runsLeft) })
        h.result = { r -> output(r.getValue("state").jsonObject, say(".ra I betray Bob")) }
        done = h.store.interact(ctx(dice = false), "go", HxAction.Click)
        until("confirm") { h.card()!!.confirm != null }
        assertEquals(HxConfirm(".ra I betray Bob", "ic"), h.card()!!.confirm)
        h.store.answer("m1", true)
        act = h.next("act")
        assertEquals(Json.parseToJsonElement("""{"text":".ra I betray Bob","kind":"ic","confirmed":true}"""), act.body!!["say"])
        act.resolve(acted(null, 0))
        done.join()
        done = h.store.interact(ctx(), "sanity", HxAction.Click)
        h.next("act").reject(refused(428, "confirmation_required", buildJsonObject { put("text", ".sc 1/1d6"); put("sheet", false) }))
        until("confirm 2") { h.card()!!.confirm != null }
        assertEquals(HxConfirm(".sc 1/1d6", "ic"), h.card()!!.confirm)
        h.store.answer("m1", false)
        done.join()
    }

    @Test fun theServersCardPushesApplyAndNeverAskForARefresh() = test {
        val text = javaClass.classLoader!!.getResourceAsStream("realtime-events.json")!!.bufferedReader().use { it.readText() }
        val events = Json.parseToJsonElement(text).jsonObject.getValue("events").jsonArray.map { RealtimeEvent.parse(it.toString())!! }
        val statePush = events.first { it.type == "hypertext.state" }; val closedPush = events.first { it.type == "hypertext.closed" }
        val id = statePush.payload.text("message_id")
        assertEquals(HypertextPipeline.StatePush(id, buildJsonObject { put("door", JsonNull); put("lamp", true) }, 1), HypertextPipeline.statePush(statePush))
        assertEquals(id, HypertextPipeline.closedPush(closedPush)!!.messageId)
        assertNull(HypertextPipeline.statePush(closedPush)); assertNull(HypertextPipeline.closedPush(events[2]))
        val h = Harness()
        assertTrue("a card not loaded here: handled, ignored", h.store.onPush(statePush))
        assertNull(h.card(id))
        h.loaded(id)
        assertTrue(h.store.onPush(statePush))
        assertEquals(listOf(buildJsonObject { put("door", JsonNull); put("lamp", true) }, 1L), h.card(id)!!.let { listOf(it.state, it.version) })
        assertTrue("the echo of the same version changes nothing", h.store.onPush(statePush))
        assertTrue(h.store.onPush(closedPush))
        assertEquals("2026-11-14T14:25:47.149433+00:00", h.card(id)!!.closedAt)
        assertFalse("other pushes are the app's", h.store.onPush(events[2]))
        // A pending confirmation is cancelled by the close.
        val m = Harness(); m.loaded()
        val done = m.store.interact(ctx(), "sanity", HxAction.Click)
        m.next("act").reject(refused(428, "confirmation_required", buildJsonObject { put("text", ".sc 1/1d6") }))
        until("confirm") { m.card()!!.confirm != null }
        m.store.applyClosed("m1", "2026-11-14T10:00:00Z")
        done.join()
        assertEquals(listOf(null, false, null), m.card()!!.let { listOf(it.confirm, it.pending, it.draft) })
        assertEquals(0, m.count("act"))
    }
}
