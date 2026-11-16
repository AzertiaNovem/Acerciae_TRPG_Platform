package app.acerciae.mobile

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Rules that live in the app's Android code, read from its sources (there is no device in CI): every WebView survives
 *  its shared renderer stopping, the engine page has no bridge and nothing to reach, the bundle is packaged, and the
 *  chat applies card pushes without a refresh and never reads a card aloud. */
class HypertextWiringTest {
    private val module: File = File(System.getProperty("user.dir") ?: ".").absoluteFile.let { here -> listOf(here, File(here, "app")).first { File(it, "src/main/java").isDirectory } }
    private val sources = File(module, "src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    private fun source(name: String) = sources.first { it.name == name }.readText()
    /** The text without comments (a // inside a string goes too, which these checks do not mind). */
    private fun code(text: String) = text.replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "").lines().joinToString("\n") { it.substringBefore("//") }

    /** The body of each `object : WebViewClient() { … }` (braces counted; these bodies hold no braces in strings). */
    private fun clients(text: String): List<String> = Regex("""object\s*:\s*WebViewClient\(\)\s*\{""").findAll(text).map { m ->
        var depth = 1; var i = m.range.last + 1
        while (depth > 0 && i < text.length) { if (text[i] == '{') depth++ else if (text[i] == '}') depth--; i++ }
        text.substring(m.range.last + 1, i - 1)
    }.toList()

    @Test fun everyWebViewClientSurvivesTheSharedRendererStopping() {
        val all = sources.flatMap { f -> clients(f.readText()).map { f.name to it } }
        assertTrue("the app's web views were found: ${all.map { it.first }}", all.size >= 3 && all.any { it.first == "HypertextEngine.kt" })
        assertEquals("every WebViewClient is an object here", sources.sumOf { Regex("""WebViewClient\(\)""").findAll(it.readText()).count() }, all.size)
        for ((file, body) in all) {
            val gone = Regex("""override fun onRenderProcessGone\([^)]*\)\s*:\s*Boolean\s*\{(.*)""", RegexOption.DOT_MATCHES_ALL).find(body)
            assertNotNull("$file: a WebViewClient without onRenderProcessGone", gone)
            assertTrue("$file: onRenderProcessGone answers true", gone!!.groupValues[1].substringBefore("override fun").contains("return true"))
        }
        // The renderer is shared with Open Log Studio and its viewer: nothing may end it (comments aside).
        for (f in sources) assertFalse(f.name, Regex("""webViewRenderProcess|\.terminate\(\)""").containsMatchIn(code(f.readText())))
    }

    @Test fun theEnginePageHasNoBridgeAndNothingToReach() {
        val engine = source("HypertextEngine.kt")
        for (setting in listOf("javaScriptEnabled = true", "blockNetworkLoads = true", "allowFileAccess = false", "allowContentAccess = false", "domStorageEnabled = false", "databaseEnabled = false"))
            assertTrue(setting, engine.contains(setting))
        assertFalse("no JavaScript bridge", engine.contains("addJavascriptInterface("))
        assertTrue("every request goes through the page's routes", engine.contains("HxPageRoute.of(") && engine.contains("403"))
        assertTrue("no navigation is followed", Regex("""shouldOverrideUrlLoading\([^)]*\)\s*=\s*true""").containsMatchIn(engine))
        assertTrue("loaded from the served origin, not file:", engine.contains("loadUrl(HxPageRoute.PAGE)") && !engine.contains("android_asset"))
        // Only Open Log Studio's own engine has a bridge, as before.
        assertEquals(listOf("LocalStudio.kt"), sources.filter { it.readText().contains("addJavascriptInterface(") }.map { it.name })
    }

    @Test fun theBundleIsPackagedAsAssets() {
        val gradle = File(module, "build.gradle.kts").readText()
        assertTrue(gradle.contains("""sourceSets["main"].assets.srcDir("../../contracts/hypertext")"""))
        val dir = File(module, "../../contracts/hypertext").canonicalFile
        assertTrue(listOf("hypertext-engine.html", "hypertext-engine.js").all { File(dir, it).isFile })
    }

    @Test fun theChatAppliesCardPushesWithoutARefreshAndReadsNoCardAloud() {
        val vm = source("AppViewModel.kt")
        val push = vm.substringAfter("private fun onPush(e: RealtimeEvent) {").substringBefore("\n    }\n")
        val channel = push.indexOf("e.channelId != state.value.channelId) return")
        val cards = push.indexOf("if (hypertext.onPush(e)) return")
        assertTrue("other channels' frames are dropped first", channel in 0 until cards)
        assertTrue("card frames return before a refresh is due", cards < push.indexOf("pushPending = true"))
        assertTrue("read-aloud skips cards", vm.contains("ReadAloud.speaks(it)") && !vm.contains("it.kind!=\"system\""))
        assertTrue("the stream's every subscription asks the cards again", Regex("""resync\(\)\s*\{[^}]*hypertext\.resync\(\)""").containsMatchIn(vm))
        // The engine page goes with the app into the background, and with the view model.
        assertTrue(Regex("""if\(!value\)\s*\{[^}]*hypertextEngine\.dispose\(\)""").containsMatchIn(vm))
        assertTrue(Regex("""onCleared\(\)\s*\{[^}]*hypertext\.reset\(\)[^}]*hypertextEngine\.dispose\(\)""").containsMatchIn(vm))
        // A card has no Re-edit, and no Pin (Pins.canPin, in core).
        assertTrue(vm.contains("m.kind != Hypertext.KIND) update { copy(recallDrafts"))
        val main = source("MainActivity.kt")
        assertTrue(main.contains("Pins.canPin(message)") && main.contains("HypertextBody(message, state, model)"))
    }

    @Test fun everyLineACardPostedCarriesItsPill() {
        // A hidden roll's notice is drawn by the dice row alone, in the default dice display.
        assertTrue(code(source("MainActivity.kt")).contains("message.diceTone == DiceTone.NOTICE -> DiceBotRow(message, model, provenance = true)"))
        assertTrue(Regex("""if \(provenance && HypertextView\.via\(message\)\)[^\n]*HypertextPills\(message\)""").containsMatchIn(code(source("DiceResult.kt"))))
        // Spectators see the pill on a card's lines as well as on the card.
        val spectator = code(source("ServerBrowser.kt")).substringAfter("private fun SpectatorPage(")
        assertTrue(spectator.contains("item.text(\"via_hypertext_id\").isNotEmpty()") && spectator.contains("HypertextPills(line)"))
    }
}
