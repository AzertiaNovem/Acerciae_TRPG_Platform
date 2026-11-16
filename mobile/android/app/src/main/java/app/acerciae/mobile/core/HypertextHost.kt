package app.acerciae.mobile.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*

// The host of the engine page, the committed bundle mobile/contracts/hypertext/hypertext-engine.html, in a hidden
// WebView (HypertextEngine.kt) that has no bridge: a run is MobileHypertext.start(id, json) through evaluateJavascript,
// then take(id) polled the same way until it is not null (evaluateJavascript does not wait for promises). Everything
// that decides here is plain Kotlin, so tests drive it with a stand-in page; mobile/contracts/INTEGRATION.md
// (2026-11-14, Engine host) is the contract.
// - One run at a time: the page's own clock for a run starts when the page picks it up, so nothing waits in its queue.
// - The page answers `timeout` itself after 1 s (5 s while its worker starts). The host's clock is a backstop for a
//   page that cannot: it waits that long plus a margin and one poll, the cold mark for a new page and after the page
//   answered `timeout` or `engine` (its worker was ended or stopped, and it starts a new one then). When it runs out,
//   only this page is dropped (its WebView destroyed, never the renderer the app's other web views share) and the next
//   run makes a new one.
// - A page whose renderer is gone fails its run and is dropped. The page is made on the first run, dropped after
//   2 minutes without one, and on dispose() (the app in the background, a reset).
// The host returns the page's result string as it is: HypertextPipeline.run checks it again before anything is used.

/** One engine page: the hidden WebView in the app, a stand-in in tests. */
interface HxEnginePage {
    /** Runs [script] in the page. [done] gets the value as evaluateJavascript gives it, JSON-encoded ("null" for none),
     *  or null when the page cannot run it any more. */
    fun evaluate(script: String, done: (String?) -> Unit)
    /** Drops this page only. */
    fun destroy()
}
/** What a page reports while it lives. */
interface HxPageEvents {
    /** The engine page finished loading. */
    fun loaded()
    /** The page is gone (its load failed, or its renderer stopped) and must not be used again. */
    fun lost(why: String)
}
/** Makes a page and starts loading the engine into it. */
fun interface HxPageFactory { fun create(events: HxPageEvents): HxEnginePage }

/** Timings, in milliseconds. [warmMs] and [coldMs] are the page's own marks (engine.limits timeout_ms and
 *  cold_timeout_ms of fixtures/hypertext-client.json); the host waits [marginMs] and one poll longer. */
data class HxHostTiming(
    val pollMs: Long = 25,
    val warmMs: Long = 1000,
    val coldMs: Long = 5000,
    val marginMs: Long = 500,
    /** How long a new page may take to load (a renderer that has to start can be slow). */
    val loadMs: Long = 30_000,
    /** A page with no run for this long is dropped. */
    val idleMs: Long = 120_000,
)

/** The engine page as a [HypertextRunner]. Call it on [scope]'s thread (the main thread, as WebView needs). */
class HypertextHost(
    private val factory: HxPageFactory,
    private val scope: CoroutineScope,
    private val timing: HxHostTiming = HxHostTiming(),
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) : HypertextRunner {
    private inner class Slot : HxPageEvents {
        var page: HxEnginePage? = null
        val ready = CompletableDeferred<Unit>()
        var gone = false
        /** The page's worker is new (a new page, or the last run ended its worker): the next run gets the cold mark. */
        var cold = true
        val waiting = HashSet<CompletableDeferred<String?>>()
        override fun loaded() { ready.complete(Unit) }
        override fun lost(why: String) { drop(this, why) }
    }
    private val lock = Mutex()
    private var slot: Slot? = null
    private var serial = 0L
    private var idle: Job? = null

    /** Whether a page is up now (for tests and the app's own checks). */
    val open: Boolean get() = slot != null

    override suspend fun run(request: String): String = lock.withLock {
        idle?.cancel(); idle = null
        val s = slot ?: create()
        try { runOn(s, request) }
        catch (e: CancellationException) { drop(s, "the run was cancelled"); throw e }   // the page may still be busy with it
        finally { if (slot != null) scheduleIdle() }
    }

    private suspend fun runOn(s: Slot, request: String): String {
        if (withTimeoutOrNull(timing.loadMs) { s.ready.await() } == null) { drop(s, "load"); throw HypertextRunFailure("timeout", "the engine did not start in time") }
        val id = (++serial).toString()
        val started = now()
        // The page says whether its worker is ready; until then the page itself allows the cold mark.
        val warm = when (eval(s, startScript(id, request), started + timing.coldMs + timing.marginMs)) {
            "true" -> true
            "false" -> false
            null -> throw fail(s, "the engine did not answer")
            else -> { drop(s, "start"); throw HypertextRunFailure("engine", "the engine page is not ready") }
        }
        val deadline = started + (if (warm && !s.cold) timing.warmMs else timing.coldMs) + timing.marginMs + timing.pollMs
        while (true) {
            val v = eval(s, takeScript(id), deadline)
            val out = if (v == null) null else try { decode(v) } catch (e: HypertextRunFailure) { drop(s, "result"); throw e }
            if (out != null) { s.cold = restartsWorker(out); return out }
            if (v == null || now() >= deadline) throw fail(s, "the script did not finish in time")
            delay(timing.pollMs)
        }
    }
    // No answer in time: a page whose renderer went fails as `engine`, one that is stuck as `timeout`; either is dropped.
    private fun fail(s: Slot, message: String): HypertextRunFailure {
        val code = if (s.gone) "engine" else "timeout"
        drop(s, code)
        return HypertextRunFailure(code, if (code == "engine") "the engine stopped" else message)
    }

    // One evaluation, answered by [until]; null when it was not (or the page went).
    private suspend fun eval(s: Slot, script: String, until: Long): String? {
        val page = s.page ?: return null
        if (s.gone) return null
        val answer = CompletableDeferred<String?>()
        s.waiting += answer
        try {
            page.evaluate(script) { answer.complete(it ?: NO_ANSWER) }
            val v = withTimeoutOrNull(maxOf(1L, until - now())) { answer.await() }
            return if (v == NO_ANSWER) null else v
        } finally { s.waiting -= answer }
    }

    private fun create(): Slot {
        val s = Slot()
        val page = try { factory.create(s) } catch (e: Exception) {
            // No WebView on this device (or none that starts): the answer for the session, as without WebAssembly.
            throw HypertextRunFailure("engine_unavailable", "this device cannot run interactive actions")
        }
        s.page = page
        if (s.gone) { runCatching { page.destroy() }; throw HypertextRunFailure("engine", "the engine page did not load") }
        slot = s
        return s
    }
    private fun drop(s: Slot, why: String) {
        if (slot === s) slot = null
        if (s.gone) return
        s.gone = true
        s.ready.completeExceptionally(HypertextRunFailure("engine", "the engine page did not load ($why)"))
        for (w in s.waiting.toList()) w.complete(NO_ANSWER)
        s.page?.let { runCatching { it.destroy() } }
        s.page = null
    }
    private fun scheduleIdle() {
        idle?.cancel()
        idle = scope.launch { delay(timing.idleMs); if (!lock.isLocked) slot?.let { drop(it, "idle") } }
    }

    /** Drops the page now (a run on it fails); the next run makes a new one. */
    override fun dispose() { idle?.cancel(); idle = null; slot?.let { drop(it, "disposed") } }

    companion object {
        private const val NO_ANSWER = "\u0000no answer"
        /** A JSON string literal that is also a valid JavaScript one on every engine (U+2028/U+2029 escaped too). */
        fun literal(s: String): String = JsonPrimitive(s).toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        /** Starts a run and answers whether the page's worker was ready (null when the page has no engine). */
        fun startScript(id: String, request: String) =
            "(function(){var h=window.MobileHypertext;if(!h||typeof h.start!=='function')return null;var w=h.ready===true;h.start(${literal(id)},${literal(request)});return w})()"
        fun takeScript(id: String) = "(function(){var h=window.MobileHypertext;return h&&typeof h.take==='function'?h.take(${literal(id)}):null})()"
        /** The value of take() as evaluateJavascript hands it over: null while the run goes on, else the result JSON. */
        fun decode(value: String): String? = when (val v = try { Json.parseToJsonElement(value) } catch (_: Exception) { null }) {
            is JsonNull -> null
            is JsonPrimitive -> if (v.isString) v.content else throw HypertextRunFailure("engine", "the engine sent no result")
            else -> throw HypertextRunFailure("engine", "the engine sent no result")
        }
        // The page ended its worker (`timeout`) or the worker stopped (`engine`): the page starts a new one, which
        // compiles again, so the next run gets the cold mark. `ready` stays true on the page, so it cannot tell us.
        // A false alarm (an `engine` answer with the worker intact) only costs a longer backstop once.
        private fun restartsWorker(out: String): Boolean {
            if (out.length > HypertextPipeline.MESSAGE_BYTES) return false
            val o = runCatching { Json.parseToJsonElement(out) as? JsonObject }.getOrNull() ?: return false
            return Hypertext.boolOf(o["ok"]) == false && (o["error"] as? JsonObject)?.text("code") in setOf("timeout", "engine")
        }
    }
}

/** What the engine page may load (HypertextEngine.kt serves these from the APK's assets, the folder
 *  mobile/contracts/hypertext packaged by build.gradle.kts). Everything else is refused with a 403; the bundle's own
 *  blob: worker is left to the WebView (it never touches the network). */
object HxPageRoute {
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val PAGE = "$ORIGIN/hypertext-engine.html"
    sealed interface Answer
    data class Asset(val name: String, val mime: String) : Answer
    data object Pass : Answer
    data object Refuse : Answer
    private val ASSETS = mapOf("/hypertext-engine.html" to Asset("hypertext-engine.html", "text/html"), "/hypertext-engine.js" to Asset("hypertext-engine.js", "text/javascript"))
    fun of(url: String): Answer {
        if (url.startsWith("blob:$ORIGIN/")) return Pass
        if (!url.startsWith("$ORIGIN/")) return Refuse
        return ASSETS[url.substring(ORIGIN.length)] ?: Refuse   // exact paths only: no query, fragment or other file
    }
}
