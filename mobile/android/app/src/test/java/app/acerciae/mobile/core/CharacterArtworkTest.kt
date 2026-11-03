package app.acerciae.mobile.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.TimeUnit

class CharacterArtworkTest {
    private val character = Json.parseToJsonElement("""{"id":"hero","updated_at":"2026-11-03T12:00:00Z","avatar_asset_id":"avatar","avatar_asset_version":7,"avatar_asset_hash":"avatar-hash"}""").jsonObject
    private val space = """{"avatar":{"id":"avatar","version":7,"hash":"avatar-hash"},"portrait":{"id":"portrait","version":3,"hash":"portrait-hash"},"subtitles":[{"id":"smile","version":4,"hash":"smile-hash"},{"id":"same-portrait","version":1,"hash":"portrait-hash"}]}"""

    @Test fun selectsActualImageVersionWithoutMixingOldMessageMetadata() {
        val message = Message("m", "hello", "Player", kind="ic", seq=1, characterAvatarAssetId="old", characterAvatarVersion=2, characterAvatarHash="old-hash")
        val avatar = CharacterArtwork.avatar(character, message)!!
        assertEquals("avatar", avatar.id); assertEquals(mapOf("v" to "7"), avatar.query); assertEquals("avatar-hash", avatar.hash)
        assertEquals(mapOf("v" to "2"), CharacterArtwork.avatar(null, message)!!.query)
    }

    @Test fun preloadsAllSlotsOnceAndSurvivesRestartAndChangedHash() = runBlocking {
        val dir = Files.createTempDirectory("artwork").toFile()
        try { MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = MockResponse().setHeader("Cache-Control", "private, immutable")
                    .setBody(if (request.requestUrl!!.pathSegments.last() == "space") space else "pixels:" + request.requestUrl!!.pathSegments.last())
            }
            fun client() = BackendClient(BackendAddress(server.url("/").toString(), true), assets=AssetDiskCache(dir))
            val api = client(); val worker = CharacterArtworkPrefetcher()
            worker.warm("c", listOf(character), api, "fixture")
            assertEquals(listOf("/api/channels/c/media/avatar?v=7", "/api/channels/c/characters/hero/space", "/api/channels/c/media/portrait?v=3", "/api/channels/c/media/smile?v=4"), (1..4).map { server.takeRequest(1, TimeUnit.SECONDS)!!.path })
            worker.warm("c", listOf(character), api, "fixture"); assertEquals(4, server.requestCount)
            val restarted = client()
            CharacterArtworkPrefetcher().warm("c", listOf(character), restarted, "fixture"); assertEquals(5, server.requestCount)
            assertEquals("pixels:portrait", String(restarted.bytes(listOf("channels","c","media","another"), "fixture", mapOf("v" to "10"), "portrait-hash")))
            assertEquals(5, server.requestCount)
            val changed = JsonObject(character + mapOf("avatar_asset_version" to JsonPrimitive(8), "avatar_asset_hash" to JsonPrimitive("new-hash")))
            worker.warm("c", listOf(changed), api, "fixture")
            assertEquals("/api/channels/c/characters/hero/space", server.takeRequest().path)
            assertEquals("/api/channels/c/media/avatar?v=8", server.takeRequest().path)
        } } finally { dir.deleteRecursively() }
    }

    @Test fun cancellationStopsQueueAndPrivateResponsesStayOffDisk() = runBlocking {
        val dir = Files.createTempDirectory("artwork").toFile()
        try { MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = MockResponse().setHeader("Cache-Control", "private, max-age=600")
                    .setBody(if (request.requestUrl!!.pathSegments.last() == "space") space else "private-pixels").setBodyDelay(100, TimeUnit.MILLISECONDS)
            }
            val cache = AssetDiskCache(dir)
            val api = BackendClient(BackendAddress(server.url("/").toString(), true), assets=cache)
            val task = launch { CharacterArtworkPrefetcher().warm("c", listOf(character), api, "fixture") }
            withTimeout(3000) { while (server.requestCount == 0) delay(5) }
            task.cancelAndJoin(); delay(150)
            assertEquals(1, server.requestCount)
            CharacterArtworkPrefetcher().warm("c", listOf(character), api, "fixture")
            assertNull(cache.get("sha:avatar-hash")); assertNull(cache.get("sha:portrait-hash"))
        } } finally { dir.deleteRecursively() }
    }
}
