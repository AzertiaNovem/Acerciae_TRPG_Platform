package app.acerciae.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import app.acerciae.mobile.core.*
import kotlinx.coroutines.CoroutineScope
import java.io.ByteArrayInputStream
import java.io.IOException

// The script engine of interactive messages: the committed bundle (mobile/contracts/hypertext, packaged as assets by
// build.gradle.kts) in a hidden WebView, driven by core/HypertextHost.kt. The page is the sandbox's outer wall, the
// WASM engine inside it the inner one, so this WebView gets nothing it does not need:
// - JavaScript on (the bundle), network loads blocked, no file or content access, no DOM storage or databases;
// - only the page and its script are served (from the APK, through shouldInterceptRequest), everything else is a 403,
//   and no navigation is followed;
// - no addJavascriptInterface: results come back through evaluateJavascript only;
// - when it is stuck or its renderer is gone, only this WebView is destroyed. Never webViewRenderProcess.terminate():
//   the renderer is shared with Open Log Studio and its document viewer.

/** Makes the hidden engine page (on the main thread, as every WebView call). */
class HypertextWebPages(context: Context) : HxPageFactory {
    private val app = context.applicationContext
    override fun create(events: HxPageEvents): HxEnginePage {
        check(Looper.myLooper() == Looper.getMainLooper()) { "the engine page lives on the main thread" }
        return HypertextWebPage(app, events)
    }
}

/** The engine host the app uses: the page is made on the first script run and dropped when idle or in the background. */
fun hypertextEngine(context: Context, scope: CoroutineScope) = HypertextHost(HypertextWebPages(context), scope)

@SuppressLint("SetJavaScriptEnabled")
private class HypertextWebPage(context: Context, private val events: HxPageEvents) : HxEnginePage {
    private val assets = context.assets
    private var web: WebView? = WebView(context)

    init {
        val view = web!!
        view.settings.run {
            javaScriptEnabled = true
            blockNetworkLoads = true
            allowFileAccess = false
            allowContentAccess = false
            domStorageEnabled = false
            @Suppress("DEPRECATION") databaseEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        view.webViewClient = object : WebViewClient() {
            // Called off the main thread: it only reads the APK's assets.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = respond(request.url.toString())
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun onPageFinished(view: WebView, url: String) { if (url == HxPageRoute.PAGE) events.loaded() }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) events.lost("the engine page did not load") }
            // The renderer stopped (it may have been the app's other web views'): this page is dropped, the app stays.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean { destroy(); events.lost("the engine stopped"); return true }
        }
        view.loadUrl(HxPageRoute.PAGE)
    }

    private fun respond(url: String): WebResourceResponse? = when (val answer = HxPageRoute.of(url)) {
        is HxPageRoute.Asset -> try { WebResourceResponse(answer.mime, "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), assets.open(answer.name)) } catch (_: IOException) { refused() }
        HxPageRoute.Pass -> null
        HxPageRoute.Refuse -> refused()
    }
    private fun refused() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    override fun evaluate(script: String, done: (String?) -> Unit) {
        val view = web ?: return done(null)
        view.evaluateJavascript(script) { done(it) }
    }
    override fun destroy() {
        val view = web ?: return
        web = null
        view.destroy()
    }
}
