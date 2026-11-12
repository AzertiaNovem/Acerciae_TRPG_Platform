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
    @Test fun savedCopiesAreNamedLikeTheServersDownloads() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())
        val webp = "RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.US_ASCII)
        assertEquals("illustration-Ada-and-Mo-whisper-on-the-pier-dusk.png", ChatIllustrations.fileName("🖼️ Ada and Mo whisper on the pier: dusk!", png))
        assertEquals("illustration-艾达-莫.jpg", ChatIllustrations.fileName("🖼️ 艾达/莫", jpeg))
        assertEquals("illustration.webp", ChatIllustrations.fileName("🖼️ ", webp))
        assertEquals("illustration-".length + 40 + 4, ChatIllustrations.fileName("x".repeat(100), png).length)
        assertEquals("image/jpeg", ChatIllustrations.mime(jpeg)); assertEquals("image/webp", ChatIllustrations.mime(webp)); assertEquals("image/png", ChatIllustrations.mime(png))
        // A picture a member uploaded: any of the four types, with or without a caption.
        val gif = "GIF89a".toByteArray(Charsets.US_ASCII)
        assertEquals("image/gif", ChatIllustrations.mime(gif)); assertEquals("illustration.gif", ChatIllustrations.fileName("🖼️", gif))
        assertEquals("", ChatIllustrations.caption("🖼️")); assertEquals("A torn page", ChatIllustrations.caption("🖼️ A torn page"))
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
    @Test fun aFinishedDownloadIsNeverHandedToTheNextRequest() = runBlocking {
        // Only a download still under way is shared; one that has finished is not reused, even in the moment before it
        // is cleared away, so a picture the server marks no-store is fetched each time it is asked for.
        val server = MockWebServer(); server.start()
        try {
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            val path = ChatIllustrations.path("channel", "line")
            repeat(300) { server.enqueue(MockResponse().setBody("picture").setHeader("Cache-Control", "private, no-store")) }
            repeat(300) { client.bytes(path, "fixture-session") }
            assertEquals(300, server.requestCount)
        } finally { server.shutdown() }
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
