package app.acerciae.mobile.core

import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class ChatIllustrationsTest {
    private val json = Json { ignoreUnknownKeys = true }
    @Test fun attachmentsSurviveOfflineRoundTripAndRecallHidesThem() {
        val message = json.decodeFromString<Message>("""{"id":"line","channel_id":"channel","media_asset_id":"picture","content":"🖼️ 雨中的街道","author_name":"GM","kind":"ooc","seq":1}""")
        assertTrue(message.hasIllustration); assertEquals("channel", message.channelId)
        assertEquals("雨中的街道", message.illustrationCaption)
        val restored = json.decodeFromString<Message>(json.encodeToString(message))
        assertEquals("picture", restored.mediaAssetId); assertTrue(restored.hasIllustration)
        assertFalse(restored.copy(recalledAt = "2026-11-07T00:00:00Z").hasIllustration)
        assertFalse(message.copy(mediaAssetId = null).hasIllustration)
        assertEquals("A room", ChatIllustrations.caption("🖼 A room"))
        assertEquals("A room", ChatIllustrations.caption("🖼️\nA room"))
        assertEquals("Text 🖼️ stays", ChatIllustrations.caption("Text 🖼️ stays"))
    }
    @Test fun authenticatedMessageEndpointPersistsAndSeparatesAccounts() = runBlocking {
        val root = Files.createTempDirectory("chat-images").toFile(); val server = MockWebServer(); server.start()
        try {
            fun client(account: String = "one") = BackendClient(BackendAddress(server.url("/").toString(), true), assets = AssetDiskCache(File(root, account)))
            val path = ChatIllustrations.path("channel", "line")
            server.enqueue(MockResponse().setBody("picture").setHeader("Cache-Control", "private, max-age=86400"))
            val first = client()
            assertArrayEquals("picture".toByteArray(), first.bytes(path, "fixture-session"))
            val request = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("/api/channels/channel/messages/line/image", request.path)
            assertEquals("Bearer fixture-session", request.getHeader("Authorization"))
            client().bytes(path, "fixture-session"); assertEquals(1, server.requestCount)
            server.enqueue(MockResponse().setBody("other-picture").setHeader("Cache-Control", "private, max-age=86400"))
            client("two").bytes(path, "other-session"); assertEquals(2, server.requestCount)
            first.forgetMessageImage("channel", "line")
            assertNull(AssetDiskCache(File(root, "one")).get(server.url("/api/channels/channel/messages/line/image").toString()))
        } finally { server.shutdown(); root.deleteRecursively() }
    }
    @Test fun aRecallRejectsLateCacheWrites() = runBlocking {
        val root = Files.createTempDirectory("chat-recall").toFile(); val server = MockWebServer(); server.start()
        try {
            val cache = AssetDiskCache(root)
            val client = BackendClient(BackendAddress(server.url("/").toString(), true), assets = cache)
            server.enqueue(MockResponse().setBody("picture").setBodyDelay(200, TimeUnit.MILLISECONDS).setHeader("Cache-Control", "private, max-age=86400"))
            val task = async(Dispatchers.IO) { client.bytes(ChatIllustrations.path("channel", "line"), "fixture-session") }
            assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            client.forgetMessageImage("channel", "line"); task.await()
            assertNull(cache.get(server.url("/api/channels/channel/messages/line/image").toString()))
        } finally { server.shutdown(); root.deleteRecursively() }
    }
    @Test fun onlyExplicitlyCacheableMessagePicturesUseTheException() = runBlocking {
        val root = Files.createTempDirectory("chat-private").toFile(); val server = MockWebServer(); server.start()
        try {
            val client = BackendClient(BackendAddress(server.url("/").toString(), true), assets = AssetDiskCache(root))
            val path = ChatIllustrations.path("channel", "line")
            repeat(2) { server.enqueue(MockResponse().setBody("picture").setHeader("Cache-Control", "private, max-age=86400, no-store")) }
            repeat(2) { client.bytes(path, "fixture-session") }; assertEquals(2, server.requestCount)
            assertFalse(ChatIllustrations.keepable("private, max-age=86400", listOf("channels", "channel", "media", "picture")))
            assertFalse(ChatIllustrations.keepable("private, max-age=0", path))
            assertFalse(ChatIllustrations.keepable("private, max-age=86400, no-cache", path))
        } finally { server.shutdown(); root.deleteRecursively() }
    }
}
