package app.acerciae.mobile.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/** One event the chat stream pushed: `message.posted`, `message.recalled`, `window.changed`, … (docs/API.md). */
data class RealtimeEvent(val type: String, val channelId: String, val message: Message?, val payload: JsonObject) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        /** Null for anything that is not an event object; a message that does not decode leaves [message] null. */
        fun parse(text: String): RealtimeEvent? {
            val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
            val type = obj.text("type").ifEmpty { return null }
            val message = (obj["message"] as? JsonObject)?.let { runCatching { json.decodeFromJsonElement<Message>(it) }.getOrNull() }
            return RealtimeEvent(type, obj.text("channel_id"), message, obj)
        }
    }
}

/** 1 s, doubling to 15 s: the pause before the next attempt after [failures] failed ones. */
fun reconnectPause(failures: Int): Long = minOf(15_000L, 1_000L shl minOf(failures, 4))

/**
 * The chat stream of the channel on screen. It signs in with a short-lived file token (the session token never goes
 * into a URL), subscribes, keeps the connection alive with pings, and after a drop reconnects with growing pauses
 * ([reconnectPause]), fetching a fresh token each time. Each subscription after the first reports [Listener.resync]:
 * the app fetches what it missed while the socket was down. Listener calls arrive on OkHttp's or [scope]'s threads,
 * never while the socket holds its lock.
 */
class ChatSocket(
    private val address: BackendAddress,
    private val fileToken: suspend () -> String,
    private val listener: Listener,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val client: OkHttpClient = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build(),
    private val pause: (Int) -> Long = ::reconnectPause,
) {
    interface Listener {
        fun event(event: RealtimeEvent)
        /** Subscribed and receiving (true), or not (false). */
        fun live(live: Boolean)
        fun resync()
    }
    private val lock = Any()
    private var channel: String? = null
    private var generation = 0
    private var socket: WebSocket? = null
    private var pending: Job? = null
    private var failures = 0
    private var subscribedBefore = false
    @Volatile var live = false
        private set

    /** Follows [channelId]'s stream (null closes it). Following the channel it already follows changes nothing. */
    fun follow(channelId: String?) {
        val wasLive: Boolean
        synchronized(lock) {
            if (channelId == channel && (channelId == null || socket != null || pending?.isActive == true)) return
            channel = channelId; generation++; failures = 0; subscribedBefore = false
            pending?.cancel(); pending = null
            socket?.close(1000, null); socket = null
            wasLive = live; live = false
            if (channelId != null) open(generation, 0)
        }
        if (wasLive) listener.live(false)
    }
    fun close() = follow(null)

    // Under the lock.
    private fun open(gen: Int, after: Long) {
        pending = scope.launch {
            if (after > 0) delay(after)
            val token = try { fileToken() } catch (e: CancellationException) { throw e } catch (_: Exception) {
                synchronized(lock) { if (gen == generation) open(gen, pause(failures++)) }
                return@launch
            }
            synchronized(lock) {
                val target = channel
                if (gen != generation || target == null) return@launch
                socket = client.newWebSocket(Request.Builder().url(address.websocket(RealtimeStream.CHAT, token)).build(), Stream(gen, target))
            }
        }
    }

    private inner class Stream(private val gen: Int, private val channelId: String) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(buildJsonObject { put("type", "subscribe"); put("channel_id", channelId) }.toString())
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            val event = RealtimeEvent.parse(text) ?: return
            var nowLive = false; var resync = false
            synchronized(lock) {
                if (gen != generation || socket !== webSocket) return
                if (event.type == "subscribed") { failures = 0; resync = subscribedBefore; subscribedBefore = true; nowLive = !live; live = true }
            }
            when {
                event.type == "subscribed" -> { if (nowLive) listener.live(true); if (resync) listener.resync() }
                event.type == "hello" || event.type == "pong" -> Unit
                else -> listener.event(event)
            }
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
        private fun dropped(webSocket: WebSocket) {
            val wasLive: Boolean
            synchronized(lock) {
                if (gen != generation || socket !== webSocket) return
                socket = null; wasLive = live; live = false
                open(gen, pause(failures++))
            }
            if (wasLive) listener.live(false)
        }
    }
}
