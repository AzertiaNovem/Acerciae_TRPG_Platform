package app.acerciae.mobile.core

import kotlinx.serialization.json.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit.SECONDS
import java.util.concurrent.atomic.AtomicInteger

class ChatSocketTest {
    private fun fixture(): List<String> {
        val text = javaClass.classLoader!!.getResourceAsStream("realtime-events.json")!!.bufferedReader().use { it.readText() }
        return Json.parseToJsonElement(text).jsonObject["events"]!!.jsonArray.map { it.toString() }
    }

    @Test fun decodesTheServersFramesIncludingARecallTombstone() {
        val events = fixture().map { RealtimeEvent.parse(it)!! }
        assertEquals(listOf("hello", "subscribed", "message.posted", "message.recalled", "window.changed", "hypertext.state", "hypertext.closed"), events.map { it.type })
        val posted = events[2].message!!; val tombstone = events[3].message!!
        assertEquals("I look at teh brass lantern.", posted.displayText)
        assertEquals(120, posted.recallSecondsLeft); assertFalse(posted.recalled)
        assertEquals(posted.id, tombstone.id); assertEquals(posted.seq, tombstone.seq)
        assertTrue(tombstone.recalled); assertEquals("", tombstone.displayText); assertNull(tombstone.recallSecondsLeft)
        assertEquals(events[2].channelId, events[4].channelId); assertNull(events[4].message)
        assertEquals(events[2].channelId, events[5].channelId); assertNull(events[5].message); assertNull(events[6].message)   // a card's frames carry no message
        assertNull(RealtimeEvent.parse("not json")); assertNull(RealtimeEvent.parse("""{"no":"type"}"""))
    }

    @Test fun subscribesWithAFileTokenDeliversEventsAndAfterADropReconnectsAndResyncs() {
        val server = MockWebServer()
        val received = LinkedBlockingQueue<String>()
        val serverSockets = LinkedBlockingQueue<WebSocket>()
        fun upgrade() = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { serverSockets.add(webSocket); webSocket.send("""{"type":"hello","stream":"chat"}""") }
            override fun onMessage(webSocket: WebSocket, text: String) {
                received.add(text)
                val pack = Json.parseToJsonElement(text).jsonObject
                if (pack.text("type") == "subscribe") webSocket.send("""{"type":"subscribed","channel_id":"${pack.text("channel_id")}"}""")   // a typing pack gets no reply
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        })
        repeat(3) { server.enqueue(upgrade()) }
        server.start()
        val events = LinkedBlockingQueue<RealtimeEvent>(); val states = LinkedBlockingQueue<Boolean>(); val resyncs = AtomicInteger()
        val tokens = AtomicInteger()
        val socket = ChatSocket(BackendAddress(server.url("/").toString(), true), { "f1.token${tokens.incrementAndGet()}" }, object : ChatSocket.Listener {
            override fun event(event: RealtimeEvent) { events.add(event) }
            override fun live(live: Boolean) { states.add(live) }
            override fun resync() { resyncs.incrementAndGet() }
        }, pause = { 50L })
        try {
            val typing = TypingTarget("c1", "w1", "ada")
            assertFalse("nothing is sent before the stream is subscribed", socket.send(typing.pack(true)))
            socket.follow("c1")
            assertEquals("/ws/chat?token=f1.token1", server.takeRequest(5, SECONDS)!!.path)   // a file token, never the session's
            assertEquals("""{"type":"subscribe","channel_id":"c1"}""", received.poll(5, SECONDS))
            assertEquals(true, states.poll(5, SECONDS)); assertTrue(socket.live)
            socket.follow("c1")   // the same channel again: nothing new
            val stream = serverSockets.poll(5, SECONDS)!!
            // A typing flag goes up on the same stream, as the pack docs/API.md describes.
            assertTrue(socket.send(typing.pack(true)))
            assertEquals("""{"type":"typing","channel_id":"c1","chat_window_id":"w1","character_id":"ada","active":true}""", received.poll(5, SECONDS))
            stream.send(fixture()[3])
            val recall = events.poll(5, SECONDS)!!
            assertEquals("message.recalled", recall.type); assertTrue(recall.message!!.recalled)
            assertEquals(0, resyncs.get())

            // The server goes away: the socket reconnects with a fresh token, subscribes again and asks for a resync.
            stream.close(1001, "going away")
            assertEquals(false, states.poll(5, SECONDS))
            assertEquals("/ws/chat?token=f1.token2", server.takeRequest(5, SECONDS)!!.path)
            assertEquals("""{"type":"subscribe","channel_id":"c1"}""", received.poll(5, SECONDS))
            assertEquals(true, states.poll(5, SECONDS))
            val start = System.currentTimeMillis(); while (resyncs.get() == 0 && System.currentTimeMillis() - start < 5000) Thread.sleep(10)
            assertEquals(1, resyncs.get())

            // Another channel: a new stream for it; closing stops for good.
            socket.follow("c2")
            assertEquals(false, states.poll(5, SECONDS))
            assertEquals("""{"type":"subscribe","channel_id":"c2"}""", received.poll(5, SECONDS))
            assertEquals(true, states.poll(5, SECONDS))
            assertEquals("a new channel's first subscription is not a resync", 1, resyncs.get())
            socket.close()
            assertEquals(false, states.poll(5, SECONDS)); assertFalse(socket.live)
            assertFalse(socket.send(typing.pack(false)))
            assertNull(received.poll(300, java.util.concurrent.TimeUnit.MILLISECONDS))
        } finally { socket.close(); server.shutdown() }
    }

    @Test fun pausesGrowToFifteenSeconds() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L), (0..5).map(::reconnectPause))
    }
}
