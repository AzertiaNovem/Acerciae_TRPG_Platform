package app.acerciae.mobile.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Interactive messages around the card: the message row, the card routes of BackendClient, pins, read-aloud, and what
 *  the card shows (HypertextView, after the web's HypertextCard.tsx). */
class HypertextClientTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val row = """{"id":"m1","content":"The study\n☐ Seen\n[Roll]","author_name":"GM","author_id":"g","kind":"hypertext","seq":7,"channel_id":"c","chat_window_id":"w",
        "hypertext":{"v":1,"title":"The study","state":{"seen":{"type":"bool"},"n":{"type":"int","min":0,"max":3}},"body":[{"type":"checkbox","id":"seen_box","label":"Seen","bind":"seen"},
        {"type":"button","id":"roll","label":"Roll","act":{"say":".ra Spot Hidden"}}],"script":null,"actors":null,"runs_per_viewer":1,"closes_at":"2026-11-21T00:00:00Z","replies":[]},
        "via_hypertext_id":null,"via_user_id":null,"via_interaction_id":null,"via_effect":null}"""

    @Test fun aCardRowDecodesKeepsItsDocumentAndRoundTripsThroughTheHistorySnapshot() {
        val m = json.decodeFromString<Message>(row)
        assertEquals(listOf("hypertext", "w"), listOf(m.kind, m.chatWindowId))
        assertEquals("The study", Hypertext.parseDoc(m.hypertext)!!.title)
        assertEquals("the number stays as written", "3", m.hypertext!!.getValue("state").jsonObject.getValue("n").jsonObject.text("max"))
        val via = json.decodeFromString<Message>("""{"id":"r1","content":"The door creaks.","author_name":"GM","author_id":"g","kind":"narration","seq":8,"chat_window_id":"w","via_hypertext_id":"m1","via_user_id":"u2","via_user_name":"Ada"}""")
        assertEquals(listOf("m1", "u2", "Ada"), listOf(via.viaHypertextId, via.viaUserId, via.viaUserName))
        for (x in listOf(m, via)) assertEquals(x, json.decodeFromString<Message>(json.encodeToString(x)))
        val history = ChatHistory(listOf(m, via), hasOlder = false)
        assertEquals(history, json.decodeFromString<ChatHistory>(json.encodeToString(history)))
        // A line of an older server has none of the fields.
        val plain = json.decodeFromString<Message>("""{"id":"p","content":"hi","author_name":"Ann","kind":"ic","seq":1}""")
        assertNull(plain.hypertext); assertNull(plain.chatWindowId); assertNull(plain.viaHypertextId)
        // Snapshots written before these fields existed are not read back.
        assertEquals("mobile-history-2", BackendClient.HISTORY_SNAPSHOT)
    }

    @Test fun theHistorySnapshotIsKeptUnderItsNewName() = runBlocking {
        val dir = Files.createTempDirectory("history").toFile()
        try {
            val disk = AssetDiskCache(File(dir, "reads"))
            val client = BackendClient(BackendAddress("https://example.com", false), reads = disk)
            val history = ChatHistory(listOf(json.decodeFromString(row)), hasOlder = true)
            client.keepHistory(history, "c", "w").join()
            assertEquals(history, client.cachedHistory("c", "w"))
            assertNotNull(disk.get("https://example.com/api/channels/c/windows/w/mobile-history-2"))
            assertNull(disk.get("https://example.com/api/channels/c/windows/w/mobile-history"))
        } finally { dir.deleteRecursively() }
    }

    @Test fun pinsAndReadAloudLeaveCardsOut() {
        fun line(kind: String, recalled: String? = null) = Message(id = "m", content = "x", authorName = "Ann", kind = kind, seq = 1, recalledAt = recalled)
        assertFalse(Pins.canPin(line("hypertext"))); assertTrue(Pins.canPin(line("ic")))
        assertTrue("a line a card produced stays pinnable", Pins.canPin(line("roll").copy(viaHypertextId = "m1")))
        assertFalse(ReadAloud.speaks(line("hypertext"))); assertFalse(ReadAloud.speaks(line("system"))); assertFalse(ReadAloud.speaks(line("ic", "2026-11-07T00:00:00Z")))
        assertTrue(ReadAloud.speaks(line("ic"))); assertTrue(ReadAloud.speaks(line("narration").copy(viaHypertextId = "m1")))
    }

    @Test fun theCardRoutesAskAtMostAHundredIdsAndKeepTheErrorBody() = runBlocking {
        MockWebServer().use { server ->
            var reply: (RecordedRequest) -> MockResponse = { r ->
                val ids = r.requestUrl!!.queryParameter("ids")!!.split(",")
                MockResponse().setBody(buildJsonObject { put("enabled", true); put("items", JsonArray(ids.map { buildJsonObject { put("message_id", it); put("closes_at", JsonNull); put("closed_at", JsonNull); put("closed", false); put("state", JsonNull); put("version", 0); put("runs_left", 1) } })) }.toString())
            }
            server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = reply(request) }
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            val api = client.hypertext("token")
            val ids = (0 until 230).map { "id$it" }
            val r = api.status("c", ids)
            assertEquals(3, server.requestCount)
            val asked = (0 until 3).map { server.takeRequest() }
            assertEquals(listOf(100, 100, 30), asked.map { it.requestUrl!!.queryParameter("ids")!!.split(",").size })
            assertEquals(ids, asked.flatMap { it.requestUrl!!.queryParameter("ids")!!.split(",") })
            assertTrue(asked.all { it.method == "GET" && it.requestUrl!!.encodedPath == "/api/channels/c/hypertext" && it.getHeader("Authorization") == "Bearer token" })
            assertEquals(ids, r.items.map { it.messageId })
            assertEquals(HypertextStatus(true, emptyList()), api.status("c", emptyList()))
            assertEquals("none asks nothing", 3, server.requestCount)
            // Turned off: the answer says so at once.
            reply = { MockResponse().setBody("""{"enabled":false,"items":[]}""") }
            assertEquals(HypertextStatus(false, emptyList()), api.status("c", ids))
            assertEquals(4, server.requestCount); server.takeRequest()
            // A refusal keeps its whole body (the stored state of a 409, the text of a 428).
            reply = { MockResponse().setResponseCode(409).setBody("""{"error":"state_conflict","message":"changed","state":{"seen":true},"version":4}""") }
            val conflict = runCatching { api.save("c", "m1", buildJsonObject { put("seen", false) }, 1) }.exceptionOrNull() as BackendException
            assertEquals(listOf(409, "state_conflict", true), listOf(conflict.status, conflict.code, conflict.apiResponse))
            assertEquals(buildJsonObject { put("seen", true) }, conflict.details!!["state"]); assertEquals(4, conflict.details!!["version"]!!.jsonPrimitive.int)
            assertFalse("the server's words never become the exception's message", conflict.message!!.contains("changed"))
            val put = server.takeRequest()
            assertEquals(listOf("PUT", "/api/channels/c/messages/m1/hypertext/state"), listOf(put.method, put.path))
            assertEquals(Json.parseToJsonElement("""{"state":{"seen":false},"base_version":1}"""), Json.parseToJsonElement(put.body.readUtf8()))
            assertEquals(HxOutcome.CONFLICT, HypertextPipeline.classify(conflict))
            reply = { MockResponse().setResponseCode(428).setBody("""{"error":"confirmation_required","message":"Confirm","text":".sc 1/1d6","sheet":true}""") }
            val ask = runCatching { api.act("c", "m1", HypertextPipeline.actBody("x", "b", listOf(HxSay(".sc 1/1d6", "ic")), JsonObject(emptyMap()), 0)) }.exceptionOrNull() as BackendException
            assertEquals(HxConfirm(".sc 1/1d6", "ic", sheet = true), HypertextPipeline.confirmOf428(ask, HypertextPipeline.actBody("x", "b", listOf(HxSay(".sc 1/1d6", "ic")), JsonObject(emptyMap()), 0)))
            val act = server.takeRequest()
            assertEquals(listOf("POST", "/api/channels/c/messages/m1/hypertext/act"), listOf(act.method, act.path))
            assertEquals("x", Json.parseToJsonElement(act.body.readUtf8()).jsonObject.text("interaction_id"))
            // An action's answer, with a line the viewer may read and one they may not.
            reply = { MockResponse().setBody("""{"interaction_id":"x","replayed":true,"partial":false,"results":[{"type":"say","ok":true,"message":$row},{"type":"reply","ok":true,"message":null},{"type":"say","ok":true,"message":{"id":"broken"}}],"state":{"state":{"seen":true},"version":2}}""") }
            val done = api.act("c", "m1", buildJsonObject { put("interaction_id", "x") })
            assertEquals(listOf("m1", null, null), done.results.map { it.row?.id })
            assertEquals(listOf(true, 2L), listOf(done.replayed, done.state!!.version))
            server.takeRequest()
            reply = { MockResponse().setBody("""{"message_id":"m1","closes_at":"2026-11-21T00:00:00Z","closed_at":"2026-11-14T10:00:00Z","closed_by":"g","closed":true}""") }
            assertEquals("2026-11-14T10:00:00Z", api.close("c", "m1").closedAt)
            val close = server.takeRequest()
            assertEquals(listOf("POST", "/api/channels/c/messages/m1/hypertext/close"), listOf(close.method, close.path))
            // An older server without the route answers with its own page, not the API's JSON.
            reply = { MockResponse().setResponseCode(404).setBody("<html>Not Found</html>") }
            val missing = runCatching { api.status("c", listOf("a")) }.exceptionOrNull() as BackendException
            assertEquals(listOf(404, false, null), listOf(missing.status, missing.apiResponse, missing.details))
            assertEquals(HxOutcome.MISSING, HypertextPipeline.classify(missing))
            reply = { MockResponse().setResponseCode(404).setBody("""{"error":"not_found","message":"Message not found"}""") }
            assertEquals(HxOutcome.GONE, HypertextPipeline.classify(runCatching { api.save("c", "m1", JsonObject(emptyMap()), 0) }.exceptionOrNull()!!))
            reply = { MockResponse().setResponseCode(403).setBody("""{"error":"feature_disabled","message":"off"}""") }
            assertEquals(HxOutcome.DISABLED, HypertextPipeline.classify(runCatching { api.close("c", "m1") }.exceptionOrNull()!!))
        }
    }

    // ---- what the card shows ----

    private val window = Json.parseToJsonElement("""{"id":"w","name":"Main","kind":"main","members":[{"user_id":"u1","character_id":"ADA","character_name":"Ada","visibility_paused":false},{"user_id":"u3","character_id":null,"character_name":null,"visibility_paused":true}]}""").jsonObject
    private val characters = listOf(buildJsonObject { put("id", "ADA"); put("name", "Ada"); put("user_id", "u1") }, buildJsonObject { put("id", "bea"); put("name", "Bea"); put("user_id", "u1") })
    private fun facts(userId: String = "u1", gm: Boolean = false, spectator: Boolean = false, open: String = "w", win: JsonObject? = window, speakAs: String = "", engine: Boolean = true, now: Long = HypertextView.timeOf("2026-11-14T00:00:00Z")!!) =
        HxViewerFacts(spectator, gm, userId, "Ann (account)", open, win, characters, speakAs, engine, now)
    private fun cardDoc(extra: String = "") = Json.parseToJsonElement("""{"v":1,"title":"T","state":{"seen":{"type":"bool"}},"body":[{"type":"checkbox","id":"seen_box","label":"Seen","bind":"seen"},
        {"type":"button","id":"roll","label":"Roll","act":{"say":".ra Spot Hidden","say_kind":"ooc"}},{"type":"button","id":"go","label":"Go","on":"go"}],"script":"on('go', () => {})"$extra}""").jsonObject
    private fun message(raw: JsonObject = cardDoc(), recalled: String? = null) = Message(id = "m1", content = "T", authorName = "GM", kind = "hypertext", seq = 1, channelId = "c", hypertext = raw, chatWindowId = "w", recalledAt = recalled)
    private val loaded = HxCard("c", loaded = true, runsLeft = 1)

    @Test fun theLockReasonsComeInTheWebsOrder() {
        val doc = Hypertext.parseDoc(cardDoc(""","actors":["ada"]"""))!!
        fun reason(m: Message = message(cardDoc(""","actors":["ada"]""")), card: HxCard? = loaded, u: HxUnavailable? = null, f: HxViewerFacts = facts()) = HypertextView.of(m, doc, card, u, f).reason
        assertNull("a cast actor may act (ids compared without case)", reason())
        assertEquals(HxReason.SPECTATOR, reason(f = facts(spectator = true), card = null, u = HxUnavailable.MISSING))
        assertEquals(HxReason.RECALLED, reason(m = message(recalled = "2026-11-14T00:00:00Z"), u = HxUnavailable.MISSING))
        assertEquals(HxReason.HISTORY, reason(f = facts(open = "fork"), u = HxUnavailable.MISSING))
        assertEquals(HxReason.MISSING, reason(u = HxUnavailable.MISSING, card = loaded.copy(closed = true)))
        assertEquals(HxReason.DISABLED, reason(u = HxUnavailable.DISABLED))
        assertEquals(HxReason.CLOSED, reason(card = loaded.copy(closedAt = "2026-11-14T00:00:00Z")))
        assertEquals(HxReason.CLOSED, reason(card = loaded.copy(gone = true)))
        assertEquals("at closes_at", HxReason.CLOSED, reason(card = loaded.copy(closesAt = "2026-11-13T23:59:59.5+00:00")))
        assertNull(reason(card = loaded.copy(closesAt = "2026-11-14T00:00:01Z")))
        assertEquals(HxReason.ARCHIVED, reason(f = facts(win = JsonObject(window + ("archived_at" to JsonPrimitive("2026-11-01T00:00:00Z")))), card = loaded))
        assertEquals(HxReason.PAUSED, reason(f = facts(userId = "u3")))
        assertEquals("a paused GM still acts", null, reason(f = facts(userId = "u3", gm = true)))
        assertEquals(HxReason.MEMBER, reason(f = facts(userId = "u9")))
        assertEquals(HxReason.NOT_ACTOR, reason(f = facts(userId = "u3", win = Json.parseToJsonElement("""{"members":[{"user_id":"u3","character_id":"bob"}]}""").jsonObject)))
        assertEquals(HxReason.LOADING, reason(card = HxCard("c")))
        assertEquals(HxReason.LOADING, reason(card = null))
        // What resolve gets for each.
        assertEquals(HxLockReason.NOT_ACTOR, HxReason.MEMBER.lock); assertEquals(HxLockReason.CLOSED, HxReason.MISSING.lock); assertEquals(HxLockReason.CLOSED, HxReason.DISABLED.lock)
        val spectator = HypertextView.of(message(), doc, loaded.copy(draft = buildJsonObject { put("seen", true) }), null, facts(spectator = true))
        assertEquals("spectators draw the defaults", buildJsonObject { put("seen", false) }, spectator.state)
        assertTrue(spectator.resolved.filter { it.node is HxControl }.all { it.disabled })
    }

    @Test fun theFooterTheConfirmationAndTheControlsFollowTheWebCard() {
        val doc = Hypertext.parseDoc(cardDoc(""","runs_per_viewer":3"""))!!
        fun view(card: HxCard? = loaded, f: HxViewerFacts = facts(), u: HxUnavailable? = null) = HypertextView.of(message(cardDoc(""","runs_per_viewer":3""")), doc, card, u, f)
        val open = view(loaded.copy(runsLeft = 2))
        assertEquals(listOf(null, 2, false, false, false), listOf(open.reason, open.usesLeft, open.spentShown, open.working, open.noEngineShown))
        assertTrue(open.footerShown); assertFalse("players get no Close", open.closeShown)
        assertNull("runs_left 1 of 3 still shows", view(loaded.copy(runsLeft = null)).usesLeft)
        // The viewer as a script sees them, and the line goes out as the composer's character.
        assertEquals(HxViewer(false, true, "Ada"), open.viewer); assertNull(open.sayCharacterId)
        val asBea = view(f = facts(speakAs = "bea"))
        assertEquals(HxViewer(false, true, "Bea"), asBea.viewer); assertEquals("bea", asBea.sayCharacterId)
        assertEquals("not cast in the window: their first own character", "ADA", view(f = facts(win = Json.parseToJsonElement("""{"members":[{"user_id":"u1","character_id":null}]}""").jsonObject)).sayCharacterId)
        // Spent: the controls that post are off, the others stay usable.
        val spent = view(loaded.copy(runsLeft = 0))
        val byId = spent.resolved.associateBy { it.node.id }
        assertEquals(listOf(true, false, true), listOf(spent.spentShown, spent.off(byId.getValue("seen_box")), spent.off(byId.getValue("roll"))))
        assertFalse("a script control stays usable: a run that would post is refused then", spent.off(byId.getValue("go")))
        // No engine: only the script controls are off.
        val noEngine = view(f = facts(engine = false))
        val r = noEngine.resolved.associateBy { it.node.id }
        assertEquals(listOf(true, false, false, true), listOf(noEngine.noEngineShown, noEngine.off(r.getValue("seen_box")), noEngine.off(r.getValue("roll")), noEngine.off(r.getValue("go"))))
        // Under way: everything waits (and stays focusable); a confirmation is not "Working…".
        val busy = view(loaded.copy(pending = true))
        assertEquals(listOf(true, true, true), listOf(busy.working, busy.busy, busy.waiting(busy.resolved.first { it.node.id == "seen_box" })))
        val asking = view(loaded.copy(pending = true, confirm = HxConfirm("brb", "ooc")))
        assertEquals(listOf(false, true, "Ann (account)"), listOf(asking.working, asking.busy, asking.confirmName))
        assertEquals("Ada", view(loaded.copy(confirm = HxConfirm("I open the door.", "ic"))).confirmName)
        assertEquals(HypertextView.CONFIRM_OOC, HypertextView.confirmKey(HxConfirm("brb", "ooc")))
        assertEquals("\u2068Ann (account)\u2069 · \u2068brb\u2069", Hypertext.fill("{name} · {text}", "name" to asking.confirmName, "text" to "brb"))
        assertEquals(HypertextView.POSTS_OOC, HypertextView.captionKey(doc.body[1])); assertNull(HypertextView.captionKey(doc.body[2]))
        // GMs: Close once loaded and open, outside fork history and with the feature there; script details on a failure.
        val gm = view(f = facts(gm = true, userId = "g"))
        assertEquals(listOf(true, false, null), listOf(gm.closeShown, gm.detailsShown, gm.reason))
        assertFalse(view(card = HxCard("c"), f = facts(gm = true)).closeShown)
        assertFalse(view(card = loaded.copy(closedAt = "2026-11-13T00:00:00Z"), f = facts(gm = true)).closeShown)
        assertFalse(view(f = facts(gm = true, open = "fork")).closeShown)
        assertFalse(view(f = facts(gm = true), u = HxUnavailable.DISABLED).closeShown)
        val watching = view(f = facts(gm = true, spectator = true))
        assertEquals("a spectator GM gets the reason, no Close", listOf(true, HxReason.SPECTATOR, false), listOf(watching.footerShown, watching.reason, watching.closeShown))
        assertTrue(view(card = loaded.copy(failure = HxEngineError("script_error", "boom", 2)), f = facts(gm = true)).detailsShown)
        assertFalse(view(card = loaded.copy(failure = HxEngineError("script_error", "boom", 2))).detailsShown)
        // The card is drawn again at closes_at.
        assertEquals(1000L, view(loaded.copy(closesAt = "2026-11-14T00:00:01Z")).closesInMillis)
        assertNull(view(loaded.copy(closesAt = "2026-11-13T00:00:00Z")).closesInMillis)
        assertNull(HypertextView.timeOf("soon"))
        // The context an action runs with.
        val ctx = asBea.context("c", message(), doc, dice = false)
        assertEquals(listOf("bea", null, false, true), listOf(ctx.sayCharacterId, ctx.lock, ctx.dice, ctx.engine))
    }

    @Test fun aLineACardProducedSaysSoAndWhoItAnswered() {
        val m = Message(id = "r", content = "x", authorName = "GM", authorId = "g", kind = "narration", seq = 2, viaHypertextId = "m1", viaUserId = "u2", viaUserName = "Ada")
        assertTrue(HypertextView.via(m)); assertEquals("Ada", HypertextView.answering(m))
        assertNull("the clicker's own line answers nobody", HypertextView.answering(m.copy(authorId = "u2")))
        assertNull(HypertextView.answering(m.copy(viaUserId = null)))
        assertFalse(HypertextView.via(m.copy(viaHypertextId = null))); assertNull(HypertextView.answering(m.copy(viaHypertextId = null)))
        assertEquals("answering \u2068Ada\u2069", Hypertext.fill(HypertextView.ANSWERING, "name" to "Ada"))
    }

    @Test fun everyCardStringIsInThePackagedCatalog() {
        val here = File(System.getProperty("user.dir") ?: ".").absoluteFile
        val catalog = listOf("src/main/assets", "app/src/main/assets").map { File(here, "$it/mobile-localizations.json") }.firstOrNull { it.isFile }
            ?: throw AssertionError("mobile-localizations.json not found from $here")
        val packaged = Json.decodeFromString<TranslationCatalog>(catalog.readText())
        val keys = HxReason.entries.map { it.text } + HypertextPipeline.ERRORS.values + listOf(
            HypertextPipeline.FAILED, HypertextPipeline.UNSENT, HypertextPipeline.UNSAVED, HypertextPipeline.PARTIAL, HypertextPipeline.NO_ENGINE, Hypertext.UPDATE_APP,
            HypertextView.PILL, HypertextView.VIA, HypertextView.VIA_HINT, HypertextView.ANSWERING, HypertextView.POSTS, HypertextView.POSTS_OOC, HypertextView.CONFIRM_LABEL,
            HypertextView.CONFIRM, HypertextView.CONFIRM_OOC, HypertextView.SHEET, HypertextView.POST, HypertextView.CANCEL, HypertextView.DETAILS, HypertextView.GM_ONLY,
            HypertextView.LINE, HypertextView.WORKING, HypertextView.USES_LEFT, HypertextView.SPENT, HypertextView.CLOSE, HypertextView.CLOSE_HINT, HypertextView.CHOOSE,
            HypertextView.SEND, HypertextView.AT_MOST, HypertextView.SHARED,
        )
        for (k in keys) {
            assertTrue("not packaged: $k", packaged.catalog.containsKey(k))
            assertNotEquals("not translated: $k", k, packaged.text(k, "de"))
        }
    }
}
