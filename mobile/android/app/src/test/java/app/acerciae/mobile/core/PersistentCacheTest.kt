package app.acerciae.mobile.core

import java.nio.file.Files
import java.io.File
import kotlinx.coroutines.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class PersistentCacheTest {
    @Test fun restartIsolationAndExplicitRevalidation() = runBlocking {
        val root = Files.createTempDirectory("pages").toFile(); val server = MockWebServer(); server.start()
        try {
            fun client(account: String) = BackendClient(BackendAddress(server.url("/").toString(), true), reads=AssetDiskCache(File(root,account)))
            server.enqueue(MockResponse().setBody("[{\"id\":\"server\",\"name\":\"Cached\"}]"))
            client("one").resources(listOf("servers"),"not-stored")
            assertNotNull(client("one").cachedValue(listOf("servers")))
            assertNull(client("two").cachedValue(listOf("servers"))); assertEquals(1,server.requestCount)
            server.enqueue(MockResponse().setResponseCode(403).setBody("{\"error\":\"forbidden\"}"))
            val restarted = client("one")
            try { restarted.resources(listOf("servers"),"test"); fail() } catch (_: BackendException) {}
            assertNull(restarted.cachedValue(listOf("servers")))
        } finally { server.shutdown(); root.deleteRecursively() }
    }
    @Test fun coalescesDownloadsAndPersistsEachVersion() = runBlocking {
        val root = Files.createTempDirectory("images").toFile(); val server = MockWebServer(); server.start()
        try {
            fun client() = BackendClient(BackendAddress(server.url("/").toString(),true),assets=AssetDiskCache(root))
            val c = client(); val path = listOf("channels","channel","media","portrait")
            server.enqueue(MockResponse().setBody("image").setBodyDelay(150,TimeUnit.MILLISECONDS).setHeader("Cache-Control","private, immutable"))
            (1..8).map { async { c.bytes(path,"test",mapOf("v" to "1")) } }.awaitAll().forEach { assertArrayEquals("image".toByteArray(),it) }
            assertEquals(1,server.requestCount)
            client().bytes(path,"test",mapOf("v" to "1")); assertEquals(1,server.requestCount)
            server.enqueue(MockResponse().setBody("new").setHeader("Cache-Control","private, immutable"))
            c.bytes(path,"test",mapOf("v" to "2")); assertEquals(2,server.requestCount)
        } finally { server.shutdown(); root.deleteRecursively() }
    }
    @Test fun migrationAndInvalidationDoNotResurrectOldData() {
        val root=Files.createTempDirectory("migration").toFile()
        try {
            val old=File(root,"old"); val fresh=File(root,"new")
            AssetDiskCache(old).put("image",byteArrayOf(1,2))
            val cache=AssetDiskCache(fresh,legacyDir=old)
            assertArrayEquals(byteArrayOf(1,2),cache.get("image")); assertFalse(old.exists())
            val earlier=cache.reserve("ordered"); val later=cache.reserve("ordered")
            cache.put("ordered",byteArrayOf(2),ticket=later); cache.put("ordered",byteArrayOf(1),ticket=earlier)
            assertArrayEquals(byteArrayOf(2),cache.get("ordered"))
            val generation=cache.generation(); cache.clear(); cache.put("late",byteArrayOf(3),generation)
            assertNull(cache.get("late"))
            cache.invalidate(); cache.put("late",byteArrayOf(3)); assertNull(cache.get("late"))
            assertFalse(ReadCachePolicy.keep(listOf("auth","me")))
            assertFalse(AssetDiskCache.keepable("immutable, no-store"))
        } finally { root.deleteRecursively() }
    }
}
