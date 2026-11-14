package app.acerciae.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** The real engine page on a device or emulator: the committed bundle served from the APK into the hidden WebView of
 *  HypertextEngine.kt, driven by core/HypertextHost.kt on the main thread. The JVM tests use a stand-in page, and CI
 *  runs no emulator, so this runs only locally: `./gradlew connectedDebugAndroidTest` from mobile/android. */
@RunWith(AndroidJUnit4::class)
class HypertextEngineSmokeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    /** fixtures/hypertext-client.json, which build.gradle.kts packages with the app's assets. */
    private val fixture by lazy { Json.parseToJsonElement(context.assets.open("hypertext-client.json").bufferedReader().use { it.readText() }).jsonObject }
    private fun case(name: String) = fixture.getValue("runs").jsonArray.map { it.jsonObject }.first { it.text("name") == name }
    /** A runs case as the request the app sends (HypertextPipeline.engineRequest). */
    private fun request(c: JsonObject): String {
        val doc = fixture.getValue("docs").jsonObject.getValue(c.text("doc")).jsonObject
        return buildJsonObject {
            put("doc", c["script"]?.let { JsonObject(doc + ("script" to it)) } ?: doc)
            put("state", c.getValue("state")); put("prev", c["prev"] ?: c.getValue("state"))
            put("handler", c.getValue("handler")); put("event", c.getValue("event")); put("viewer", c.getValue("viewer"))
        }.toString()
    }
    /** The code a run failed with, from the page's answer or from the host's own backstop. */
    private suspend fun failedWith(host: HypertextHost, c: JsonObject): String = try {
        val out = Json.parseToJsonElement(host.run(request(c))).jsonObject
        assertEquals("${c.text("name")}: $out", false, out.getValue("ok").jsonPrimitive.boolean)
        out.getValue("error").jsonObject.text("code")
    } catch (e: HypertextRunFailure) { e.code }
    private fun checkOk(c: JsonObject, raw: String) {
        val out = Json.parseToJsonElement(raw).jsonObject
        val expect = c.getValue("expect").jsonObject
        assertEquals("${c.text("name")}: $out", true, out.getValue("ok").jsonPrimitive.boolean)
        for ((k, v) in expect) if (k != "ok") assertEquals("${c.text("name")}: $k", v, out[k])
    }
    private fun onMain(body: suspend CoroutineScope.() -> Unit) = runBlocking(Dispatchers.Main) { withTimeout(120_000) { body() } }

    @Test fun aScriptRunsAStuckOneEndsAndTheNextRunWorks() = onMain {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val host = hypertextEngine(context, scope)
        try {
            val steady = case("say an allowed roll and set state")
            checkOk(steady, host.run(request(steady)))
            assertTrue(host.open)
            assertTrue(failedWith(host, case("while(1) runs out of budget")) in setOf("budget", "timeout"))
            assertEquals("timeout", failedWith(host, case("caught stack overflows end at the deadline")))
            checkOk(steady, host.run(request(steady)))
        } finally { host.dispose(); scope.cancel() }
        assertFalse(host.open)
    }

    @Test fun thePageStartsBlobWorkersAndLoadsNothingElse() = onMain {
        val loaded = CompletableDeferred<Unit>()
        val page = HypertextWebPages(context).create(object : HxPageEvents {
            override fun loaded() { loaded.complete(Unit) }
            override fun lost(why: String) { loaded.completeExceptionally(AssertionError(why)) }
        })
        try {
            loaded.await()
            suspend fun value(script: String): String? { val d = CompletableDeferred<String?>(); page.evaluate(script) { d.complete(it) }; return d.await() }
            suspend fun poll(label: String, script: String): String {
                repeat(400) { val v = value(script); if (v != null && v != "null") return v; delay(25) }
                throw AssertionError("timed out waiting for $label")
            }
            assertEquals("true", poll("the engine", "window.MobileHypertext && window.MobileHypertext.ready === true || null"))
            // A blob: worker, as the bundle starts one for its runs; the network and every other load are refused.
            value("""(function(){window.__probe={};
                var w=new Worker(URL.createObjectURL(new Blob(["postMessage('up')"],{type:'text/javascript'})));
                w.onmessage=function(e){window.__probe.worker=e.data};w.onerror=function(){window.__probe.worker='failed'};
                fetch('https://example.com/').then(function(){window.__probe.fetch='loaded'},function(){window.__probe.fetch='blocked'});
                var i=new Image();i.onload=function(){window.__probe.img='loaded'};i.onerror=function(){window.__probe.img='blocked'};i.src='https://example.com/x.png';
                return true})()""")
            assertEquals("\"up\"", poll("the worker", "window.__probe.worker || null"))
            assertEquals("\"blocked\"", poll("fetch", "window.__probe.fetch || null"))
            assertEquals("\"blocked\"", poll("the image", "window.__probe.img || null"))
        } finally { page.destroy() }
    }
}
