package app.acerciae.mobile.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class AssetDiskCacheTest {
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
            // Not marked immutable (the Keeper's copy of GM-private material, the current version): never written.
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
}
