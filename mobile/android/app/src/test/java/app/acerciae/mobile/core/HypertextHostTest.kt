package app.acerciae.mobile.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Executors

/** The engine page's host (core/HypertextHost.kt) with a stand-in page in place of the WebView: start/take polling,
 *  the warm and cold marks, one run at a time, a stuck or lost page dropped and made again, idle and dispose, the
 *  page's routes, and that whatever the page answers is checked again natively before it is used. */
class HypertextHostTest {
    private val pool = Executors.newSingleThreadExecutor()
    private val main = pool.asCoroutineDispatcher()
    @After fun stop() { pool.shutdownNow() }
    private fun test(body: suspend CoroutineScope.() -> Unit) = runBlocking(main) { withTimeout(20_000) { body() } }
    private fun clock() = System.nanoTime() / 1_000_000
    private suspend fun until(label: String, cond: () -> Boolean) { repeat(2000) { if (cond()) return; delay(2) }; fail("timed out waiting for $label") }

    /** One page as the bundle behaves: start(id, json) queues a run, take(id) gives its result once it is done. */
    inner class Page(val events: HxPageEvents, private val engine: Engine) : HxEnginePage {
        var destroyed = false
        override fun evaluate(script: String, done: (String?) -> Unit) {
            if (destroyed) { done(null); return }
            engine.scripts += script
            if (!engine.answers) return                            // a renderer stuck in a script never answers
            START.find(script)?.let { m ->
                if (!engine.hasEngine) { done("null"); return }
                val warm = engine.ready
                engine.started += m.groupValues[1] to Json.decodeFromString<String>(m.groupValues[2])
                engine.startedAt[m.groupValues[1]] = clock()
                done(warm.toString()); return
            }
            TAKE.find(script)?.let { m ->
                val id = m.groupValues[1]
                val since = engine.startedAt[id] ?: run { done("null"); return }
                val out = engine.result(engine.started.first { it.first == id }.second)
                done(if (out == null || clock() - since < engine.latencyMs) "null" else engine.encode(out)); return
            }
            done("null")
        }
        override fun destroy() { destroyed = true }
    }
    inner class Engine {
        var answers = true; var hasEngine = true; var ready = false
        var latencyMs = 10L
        var loadMs = 5L
        var loads = true
        /** The result for a request; null: it never finishes. */
        var result: (String) -> String? = { OK }
        var encode: (String) -> String = { JsonPrimitive(it).toString() }
        val scripts = mutableListOf<String>()
        val started = mutableListOf<Pair<String, String>>()
        val startedAt = HashMap<String, Long>()
        val pages = mutableListOf<Page>()
        var failCreate = false
    }
    private val timing = HxHostTiming(pollMs = 5, warmMs = 60, coldMs = 400, marginMs = 30, loadMs = 300, idleMs = 400)
    private fun CoroutineScope.host(e: Engine, t: HxHostTiming = timing) = HypertextHost({ events ->
        if (e.failCreate) throw IllegalStateException("no WebView")
        Page(events, e).also { p -> e.pages += p; if (e.loads) launch { delay(e.loadMs); events.loaded() } }
    }, this, t)
    private suspend fun failure(block: suspend () -> Unit): HypertextRunFailure =
        try { block(); fail("no failure"); throw AssertionError() } catch (f: HypertextRunFailure) { f }

    companion object {
        val START = Regex("""h\.start\("(\d+)",("(?:[^"\\]|\\.)*")\);return w""")
        val TAKE = Regex("""h\.take\("(\d+)"\)""")
        const val OK = """{"ok":true,"state":{"done":true},"effects":[],"notices":[],"logs":[],"confirm":null,"changed":true}"""
        const val TIMED_OUT = """{"ok":false,"error":{"code":"timeout","message":"the script did not finish in time"}}"""
        const val STOPPED = """{"ok":false,"error":{"code":"engine","message":"the engine stopped"}}"""
        const val FAILED = """{"ok":false,"error":{"code":"script_error","message":"boom"}}"""
        val RAW = Json.parseToJsonElement("""{"v":1,"title":"T","state":{"done":{"type":"bool"}},"body":[{"type":"button","id":"go","label":"Go","on":"go"}],"script":"on('go', () => {})"}""").jsonObject
        val DOC = Hypertext.parseDoc(RAW)!!
        fun st(done: Boolean) = buildJsonObject { put("done", done) }
    }

    @Test fun aRunStartsOnTheLoadedPageAndPollsTakeUntilTheResultArrives() = test {
        val e = Engine().apply { loadMs = 20; latencyMs = 30 }
        val h = host(e)
        // Quotes, a line break and U+2028 travel as JSON string literals, never as raw script.
        val request = "say \"hi\"\nthen a\u2028b \\ </script>"
        assertEquals(OK, h.run(request))
        assertEquals(listOf("1" to request), e.started)
        val start = e.scripts.first()
        assertTrue(start.contains("\\u2028") && !start.contains("\u2028") && !start.contains("\n"))
        assertTrue("take is polled until the run is done", e.scripts.count { TAKE.containsMatchIn(it) } > 1)
        assertTrue(h.open)
        assertEquals("one page for every run", 1, e.pages.size)
        h.run("{}"); assertEquals(1, e.pages.size)
        h.dispose()
    }

    @Test fun aStuckRunTimesOutDropsOnlyThisPageAndTheNextRunMakesANewOne() = test {
        val e = Engine().apply { ready = true }
        val h = host(e)
        h.run("{}")                                               // the page is warm from now on
        e.result = { null }
        val t0 = clock()
        val f = failure { h.run("{}") }
        val took = clock() - t0
        assertEquals("timeout", f.code)
        assertTrue("the warm mark, its margin and one poll: $took ms", took >= timing.warmMs + timing.marginMs && took < timing.coldMs)
        assertTrue(e.pages[0].destroyed); assertFalse(h.open)
        e.result = { OK }
        assertEquals(OK, h.run("{}"))
        assertEquals(2, e.pages.size); assertFalse(e.pages[1].destroyed)
        h.dispose()
    }

    @Test fun theColdMarkAppliesToANewPageAndAfterThePageTimedOut() = test {
        val e = Engine().apply { ready = true; latencyMs = 200 }   // longer than the warm mark, shorter than the cold one
        val h = host(e)
        assertEquals("a new page's worker starts: the cold mark", OK, h.run("{}"))
        assertEquals("timeout", failure { h.run("{}") }.code)
        assertEquals("a new page: cold again", OK, h.run("{}"))
        assertEquals(2, e.pages.size)
        e.latencyMs = 10; e.result = { TIMED_OUT }
        assertEquals(TIMED_OUT, h.run("{}"))                    // the page timed out itself and starts a new worker
        e.latencyMs = 200; e.result = { OK }
        assertEquals("so the next run is allowed the cold mark", OK, h.run("{}"))
        assertEquals(2, e.pages.size)
        // The page's worker stopped (it crashed): the page starts a new one, so the next run gets the cold mark too.
        e.latencyMs = 10; e.result = { STOPPED }
        assertEquals(STOPPED, h.run("{}"))
        e.latencyMs = 200; e.result = { OK }
        assertEquals("after the worker stopped, the cold mark", OK, h.run("{}"))
        assertEquals(2, e.pages.size)
        // A script's own failure leaves the worker as it was: the warm mark again.
        e.latencyMs = 10; e.result = { FAILED }
        assertEquals(FAILED, h.run("{}"))
        e.latencyMs = 200; e.result = { OK }
        assertEquals("timeout", failure { h.run("{}") }.code)
        assertFalse(h.open)
        assertEquals("a new page: cold again", OK, h.run("{}"))
        assertEquals(3, e.pages.size)
        // A page that is not ready yet is allowed the cold mark too.
        e.ready = false
        assertEquals(OK, h.run("{}"))
        h.dispose()
    }

    @Test fun aPageWhoseRendererIsGoneFailsItsRunAsEngineAndIsMadeAgain() = test {
        val e = Engine().apply { result = { null } }
        val h = host(e)
        val run = async { runCatching { h.run("{}") }.exceptionOrNull() }
        until("start") { e.started.isNotEmpty() }
        val t0 = clock()
        e.pages[0].events.lost("renderer gone")
        val f = run.await() as HypertextRunFailure
        assertEquals("engine", f.code)
        assertTrue("at once, not at the deadline", clock() - t0 < timing.warmMs)
        assertTrue(e.pages[0].destroyed); assertFalse(h.open)
        e.result = { OK }
        assertEquals(OK, h.run("{}")); assertEquals(2, e.pages.size)
        h.dispose()
    }

    @Test fun aPageThatDoesNotLoadDoesNotAnswerOrHasNoEngineFails() = test {
        val e = Engine().apply { loads = false }
        val h = host(e)
        assertEquals("timeout", failure { h.run("{}") }.code)
        assertTrue(e.pages[0].destroyed)
        e.loads = true; e.hasEngine = false
        assertEquals("engine", failure { h.run("{}") }.code)
        assertTrue(e.pages[1].destroyed)
        e.hasEngine = true; e.answers = false
        val t0 = clock()
        assertEquals("a renderer that never answers", "timeout", failure { h.run("{}") }.code)
        assertTrue(clock() - t0 < timing.coldMs + timing.marginMs + 200)
        assertTrue(e.pages[2].destroyed)
        e.answers = true; e.encode = { "42" }
        assertEquals("a take() value that is not a string", "engine", failure { h.run("{}") }.code)
        assertTrue(e.pages[3].destroyed)
        e.failCreate = true
        assertEquals("no WebView at all", "engine_unavailable", failure { h.run("{}") }.code)
        assertFalse(h.open)
        // The page loading and failing (its main frame) fails the run the same way.
        e.failCreate = false; e.encode = { JsonPrimitive(it).toString() }; e.loads = false
        val run = async { runCatching { h.run("{}") }.exceptionOrNull() }
        until("page") { e.pages.size == 5 }
        e.pages[4].events.lost("the engine page did not load")
        assertEquals("engine", (run.await() as HypertextRunFailure).code)
    }

    @Test fun runsGoOneAtATime() = test {
        val e = Engine().apply { latencyMs = 40 }
        val h = host(e)
        val a = async { h.run("""{"n":1}""") }
        val b = async { h.run("""{"n":2}""") }
        until("first start") { e.started.size == 1 }
        delay(20)
        assertEquals("the second waits for the first", 1, e.started.size)
        a.await(); b.await()
        assertEquals(listOf("""{"n":1}""", """{"n":2}"""), e.started.map { it.second })
        val firstTakes = e.scripts.indexOfLast { it.contains("take(\"1\")") }
        val secondStart = e.scripts.indexOfFirst { it.contains("start(\"2\"") }
        assertTrue(firstTakes < secondStart)
        h.dispose()
    }

    @Test fun anIdlePageIsDroppedARunKeepsItAndDisposeEndsARunAtOnce() = test {
        val e = Engine()
        val h = host(e)
        h.run("{}")
        // The first run's timer would have fired by the check, the second run's not yet.
        delay(timing.idleMs / 2); h.run("{}")
        delay(timing.idleMs * 3 / 4)
        assertTrue("a run keeps the page", h.open)
        until("idle") { !h.open }
        assertTrue(e.pages[0].destroyed)
        h.run("{}"); assertEquals(2, e.pages.size)
        // Dispose (the app goes to the background, a reset): the run on the page fails now.
        e.result = { null }
        val run = async { runCatching { h.run("{}") }.exceptionOrNull() }
        until("start") { e.started.size == 4 }
        val t0 = clock()
        h.dispose()
        assertEquals("engine", (run.await() as HypertextRunFailure).code)
        assertTrue(clock() - t0 < timing.warmMs)
        assertTrue(e.pages[1].destroyed); assertFalse(h.open)
        // A cancelled run leaves its page busy: it is dropped too.
        val cancelled = launch { h.run("{}") }
        until("start") { e.started.size == 5 }
        cancelled.cancelAndJoin()
        assertTrue(e.pages[2].destroyed); assertFalse(h.open)
    }

    @Test fun whateverThePageAnswersIsCheckedAgainNatively() = test {
        val e = Engine()
        val h = host(e)
        val event = HxEvent("click", "go", JsonNull)
        val viewer = HxViewer(gm = false, actor = true, character = "Ada")
        suspend fun runWith(out: String): HxRunResult { e.result = { out }; return HypertextPipeline.run(h, DOC, RAW, st(false), st(false), "go", event, viewer) }
        fun ok(state: JsonObject, effects: String, extra: String = "") = """{"ok":true,"state":$state,"effects":$effects,"notices":[],"logs":[]$extra}"""
        fun code(r: HxRunResult) = (r as? HxRunFailed)?.error?.code
        // The request is what the store builds; the page gets it whole.
        val good = runWith(ok(st(true), "[]"))
        assertTrue(good is HxRunOk); assertTrue("changed is computed here", (good as HxRunOk).changed)
        assertEquals(RAW, Json.parseToJsonElement(e.started.last().second).jsonObject["doc"])
        // A forged answer: a key the result may not have, a command no card may post, an undeclared state key.
        assertEquals("invalid_effect", code(runWith(ok(st(true), "[]", ""","token":"x""""))))
        assertEquals("invalid_effect", code(runWith(ok(st(true), """[{"type":"say","text":".st str 99","kind":"ic"}]"""))))
        assertEquals("invalid_state", code(runWith(ok(buildJsonObject { put("done", true); put("admin", true) }, "[]"))))
        assertEquals("invalid_effect", code(runWith("not json")))
        assertEquals("too large", "invalid_effect", code(runWith(ok(st(true), "[]", ""","logs2":"${"x".repeat(70_000)}""""))))
        // The page's own confirm and changed are never taken: free text is confirmed, a change back is no change.
        val forged = runWith(ok(st(true), """[{"type":"say","text":"I open the door.","kind":"ic"}]""", ""","confirm":null,"changed":false""")) as HxRunOk
        assertEquals(HxConfirm("I open the door.", "ic"), forged.confirm); assertTrue(forged.changed)
        val unchanged = runWith(ok(st(false), "[]", ""","changed":true""")) as HxRunOk
        assertFalse(unchanged.changed)
        // A run the page could not do is a failure with the page's code; an unknown code is a script error.
        assertEquals("budget", code(runWith("""{"ok":false,"error":{"code":"budget","message":"too long"}}""")))
        assertEquals("script_error", code(runWith("""{"ok":false,"error":{"code":"fetch","message":"x"}}""")))
        // A request too large for the page is refused before it is sent.
        val before = e.started.size
        val big = HypertextPipeline.run(h, DOC, RAW, st(false), st(false), "go", HxEvent("submit", "go", JsonPrimitive("y".repeat(70_000))), viewer)
        assertEquals("invalid_state", code(big)); assertEquals(before, e.started.size)
        h.dispose()
    }

    @Test fun theValuesEvaluateJavascriptHandsOver() {
        assertNull(HypertextHost.decode("null"))
        assertEquals("""{"ok":true}""", HypertextHost.decode(JsonPrimitive("""{"ok":true}""").toString()))
        assertEquals("a\u2028b", HypertextHost.decode(HypertextHost.literal("a\u2028b")))
        assertEquals("\"a\\u2028b\\u2029\"", HypertextHost.literal("a\u2028b\u2029"))
        for (bad in listOf("42", "{}", "[]", "true", "garbage")) assertEquals(bad, "engine", runCatching { HypertextHost.decode(bad) }.exceptionOrNull().let { (it as HypertextRunFailure).code })
        val start = HypertextHost.startScript("7", "{\"a\":\"</script>\"}")
        assertTrue(start.contains("h.start(\"7\",\"{\\\"a\\\":\\\"</script>\\\"}\")"))
        assertEquals("7", START.find(start)!!.groupValues[1])
    }

    @Test fun thePageLoadsOnlyItsOwnPageAndScript() {
        assertEquals(HxPageRoute.Asset("hypertext-engine.html", "text/html"), HxPageRoute.of(HxPageRoute.PAGE))
        assertEquals(HxPageRoute.Asset("hypertext-engine.js", "text/javascript"), HxPageRoute.of("https://appassets.androidplatform.net/hypertext-engine.js"))
        assertEquals("the bundle's own worker", HxPageRoute.Pass, HxPageRoute.of("blob:https://appassets.androidplatform.net/4f1c2d7e-0000-4000-8000-000000000000"))
        for (url in listOf(
            "https://appassets.androidplatform.net/hypertext-engine.sha256.json", "https://appassets.androidplatform.net/studio-engine.html",
            "https://appassets.androidplatform.net/hypertext-engine.js?x=1", "https://appassets.androidplatform.net/../hypertext-engine.js",
            "https://appassets.androidplatform.net/", "https://appassets.androidplatform.net.example.com/hypertext-engine.js",
            "http://appassets.androidplatform.net/hypertext-engine.js", "https://example.com/hypertext-engine.js",
            "file:///android_asset/hypertext-engine.js", "content://app/x", "data:text/html,hi", "blob:https://example.com/x", "javascript:alert(1)",
        )) assertEquals(url, HxPageRoute.Refuse, HxPageRoute.of(url))
    }
}
