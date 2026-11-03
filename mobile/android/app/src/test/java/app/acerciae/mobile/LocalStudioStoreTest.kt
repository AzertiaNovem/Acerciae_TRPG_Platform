package app.acerciae.mobile

import app.acerciae.mobile.core.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class LocalStudioStoreTest {
    @Test fun durableProjectsAreIndependentOfCacheAndRejectTraversal() = runBlocking {
        val root=Files.createTempDirectory("local-studio").toFile()
        try {
            val folder=File(root,"projects"); val store=LocalStudioStore(folder); val id=UUID.randomUUID().toString()
            val project=buildJsonObject { put("id",id); put("title","Night"); put("events",JsonArray(emptyList())); put("characters",JsonArray(emptyList())) }
            store.save(project); store.addAssets(id,buildJsonObject { put("assets/a.jpg","data:image/jpeg;base64,YQ==") })
            AssetDiskCache(File(root,"cache")).clear()
            val restarted=LocalStudioStore(folder)
            assertEquals(project,restarted.load(id)); assertEquals(1,restarted.list().size)
            assertEquals("data:image/jpeg;base64,YQ==",restarted.assets(id).text("assets/a.jpg"))
            try { restarted.addAssets(id,buildJsonObject { put("../../escape.jpg","data:image/jpeg;base64,YQ==") }); fail() } catch(_:IllegalArgumentException) {}
            try { restarted.load("../escape"); fail() } catch(_:IllegalArgumentException) {}
            val large="data:image/jpeg;base64,"+java.util.Base64.getEncoder().encodeToString(ByteArray(7*1024*1024))
            val smaller="data:image/jpeg;base64,"+java.util.Base64.getEncoder().encodeToString(ByteArray(13*512*1024))
            try { store.addAssets(id,buildJsonObject { put("assets/b.jpg",large); put("assets/c.jpg",large); put("assets/d.jpg",smaller) }); fail("Oversized imports must leave existing assets usable") } catch(_:IllegalArgumentException) {}
            assertEquals(1,store.assets(id).size)
            store.removeUnusedAsset(id,"assets/a.jpg",buildJsonObject { put("portrait","assets/a.jpg") }); assertEquals(1,store.assets(id).size)
            store.removeUnusedAsset(id,"assets/a.jpg",project); assertTrue(store.assets(id).isEmpty())
            restarted.delete(id); assertTrue(restarted.list().isEmpty())
        } finally { root.deleteRecursively() }
    }
}
