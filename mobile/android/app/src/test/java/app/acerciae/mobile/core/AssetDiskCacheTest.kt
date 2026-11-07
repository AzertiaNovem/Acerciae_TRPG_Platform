package app.acerciae.mobile.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class AssetDiskCacheTest {
    @Test fun recallDropsPaginatedCopiesAndRejectsInFlightWritesButKeepsOtherCache() {
        val dir = java.nio.file.Files.createTempDirectory("recall-cache").toFile()
        try {
            val cache = AssetDiskCache(dir)
            listOf("recent", "history", "fork").forEach { cache.put(it, """[{"id":"withdrawn","content":"Old text"}]""".toByteArray()) }
            cache.put("catalog", """[{"id":"server"}]""".toByteArray())
            val generation = cache.generation()
            cache.removeMessage("withdrawn")
            cache.put("late", "Old text".toByteArray(), generation)
            val restarted = AssetDiskCache(dir)
            listOf("recent", "history", "fork", "late").forEach { assertNull(restarted.get(it)) }
            assertNotNull(restarted.get("catalog"))
        } finally { dir.deleteRecursively() }
    }
    @Test fun keepsOnlyImmutableResponsesAndServesThemWithoutTheNetwork() = runBlocking {
        val dir = Files.createTempDirectory("assets").toFile()
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Cache-Control", "private, max-age=31536000, immutable").setBody("PIXELS"))
            server.enqueue(MockResponse().setHeader("Cache-Control", "private, max-age=3600").setBody("SECRET"))
            server.enqueue(MockResponse().setHeader("Cache-Control", "private, max-age=3600").setBody("SECRET"))
            val client = BackendClient(BackendAddress(server.url("/").toString(), true), assets = AssetDiskCache(dir))
            val avatar = listOf("channels", "c", "media", "m1")
            assertEquals("PIXELS", String(client.bytes(avatar, "t", mapOf("v" to "2"))))
            assertEquals("PIXELS", String(client.bytes(avatar, "t", mapOf("v" to "2"))))
            assertEquals("a named version is downloaded once", 1, server.requestCount)
            // A new client (the app restarted) reads the same files.
            val again = BackendClient(BackendAddress(server.url("/").toString(), true), assets = AssetDiskCache(dir))
            assertEquals("PIXELS", String(again.bytes(avatar, "t2", mapOf("v" to "2"))))
            assertEquals(1, server.requestCount)
            // Not marked immutable (the GM's copy of GM-private material, the current version): never written.
            val secret = listOf("channels", "c", "media", "gm")
            assertEquals("SECRET", String(client.bytes(secret, "t", mapOf("v" to "1"))))
            assertEquals("SECRET", String(client.bytes(secret, "t", mapOf("v" to "1"))))
            assertEquals(3, server.requestCount)
            assertEquals(1, dir.listFiles()!!.size)
        }
        AssetDiskCache(dir).clear()
        assertFalse(dir.exists())
    }

    @Test fun dropsTheLeastRecentlyUsedBeyondItsCap() {
        val dir = Files.createTempDirectory("assets").toFile()
        val cache = AssetDiskCache(dir, capBytes = 10)
        cache.put("a", ByteArray(4)); Thread.sleep(15)
        cache.put("b", ByteArray(4)); Thread.sleep(15)
        assertNotNull(cache.get("a")); Thread.sleep(15)   // a is used again: b is now the oldest
        cache.put("c", ByteArray(4))
        assertNotNull(cache.get("a")); assertNull(cache.get("b")); assertNotNull(cache.get("c"))
        assertTrue(AssetDiskCache.keepable("private, max-age=31536000, immutable"))
        assertFalse(AssetDiskCache.keepable("private, max-age=3600")); assertFalse(AssetDiskCache.keepable(null))
    }

    @Test fun keysByContentHashSoTheSameBytesAreOneEntryWhateverNamesThem() = runBlocking {
        val dir = Files.createTempDirectory("assets").toFile()
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Cache-Control", "private, max-age=31536000, immutable").setBody("PIXELS"))
            server.enqueue(MockResponse().setHeader("Cache-Control", "private, max-age=31536000, immutable").setBody("OTHER"))
            val client = BackendClient(BackendAddress(server.url("/").toString(), true), assets = AssetDiskCache(dir))
            val h = "a".repeat(64)
            assertEquals("PIXELS", String(client.bytes(listOf("channels", "c", "media", "m1"), "t", mapOf("v" to "2"), h)))
            // Another asset, another user avatar, a new version: the same hash is the same entry, nothing is downloaded.
            assertEquals("PIXELS", String(client.bytes(listOf("channels", "d", "media", "m9"), "t", mapOf("v" to "1"), h)))
            assertEquals("PIXELS", String(client.bytes(listOf("users", "u", "avatar"), "t", mapOf("v" to "3"), h)))
            assertEquals(1, server.requestCount)
            // A changed hash is a new entry.
            assertEquals("OTHER", String(client.bytes(listOf("channels", "c", "media", "m1"), "t", mapOf("v" to "3"), "b".repeat(64))))
            assertEquals(2, server.requestCount)
            assertEquals("sha:$h", AssetDiskCache.key(h, "http://x/")); assertEquals("http://x/", AssetDiskCache.key("", "http://x/")); assertEquals("http://x/", AssetDiskCache.key(null, "http://x/"))
        }
    }

    @Test fun dropsWhatWasNotUsedForThirtyDaysAndEveryUseRenewsTheLifespan() {
        val dir = Files.createTempDirectory("assets").toFile()
        var now = 1_000_000_000_000L
        val day = 24L * 60 * 60 * 1000
        val cache = AssetDiskCache(dir, maxAgeMs = 30 * day, clock = { now })
        cache.put("a", ByteArray(4)); cache.put("b", ByteArray(4))
        now += 20 * day
        assertNotNull("used on day 20: a's lifespan starts over", cache.get("a"))
        now += 15 * day
        assertNotNull("a: 15 days since its last use", cache.get("a"))
        assertNull("b: 35 days without a use", cache.get("b"))
        assertEquals(1, dir.listFiles()!!.count { !it.name.endsWith(".tmp") })
        now += 31 * day
        assertNull(cache.get("a"))
        assertEquals(0, dir.listFiles()!!.count { !it.name.endsWith(".tmp") })
    }
}
