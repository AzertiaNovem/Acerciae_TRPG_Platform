package app.acerciae.mobile.core

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PbtaTest {
    private fun fixture() = Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("pbta-mobile.json")!!.bufferedReader().use { it.readText() }).jsonObject
    @Test fun validatesSheetAgainstItsOwnPack() {
        val f=fixture();val pack=f.obj("pack");val sheet=f.obj("sheet")
        assertTrue(Pbta.validSheet(sheet,pack))
        assertFalse(Pbta.validSheet(JsonObject(sheet+("book" to JsonPrimitive("missing"))),pack))
        listOf<JsonElement>(JsonPrimitive(10000),JsonPrimitive(1.5),JsonPrimitive("2"),JsonPrimitive(true)).forEach { bad ->
            assertFalse(Pbta.validSheet(JsonObject(sheet+("stats" to buildJsonObject { put("wit",bad) })),pack))
        }
        assertFalse(Pbta.validSheet(JsonObject(sheet+("stats" to JsonArray(emptyList()))),pack))
        assertFalse(Pbta.validSheet(JsonObject(sheet+("stats" to buildJsonObject {put("foreign",1)})),pack))
    }
    @Test fun onlyOffersCurrentPlaybookMovesAndUsesServerDice() {
        val f=fixture();val moves=Pbta.moves(f.obj("pack"),f.obj("sheet"))
        assertEquals(listOf("search","prepare"),moves.map{it.id})
        val body=Pbta.moveBody("pc",moves[0],-3)
        assertEquals(".move search -3",body.text("content"));assertEquals("ic",body.text("kind"));assertEquals("window",body.text("visibility"));assertEquals("pc",body.text("character_id"))
        assertEquals(".move prepare",Pbta.moveBody("pc",moves[1],5).text("content"))
        try{Pbta.moveBody("pc",moves[0],100);fail()}catch(_:IllegalArgumentException){}
        try{Pbta.moveBody("pc",payload("id" to "search\n"),0);fail()}catch(_:IllegalArgumentException){}
        val legacy=Message(id="old",content=".move search",authorName="Reader",kind="roll",seq=1,dice=payload("type" to "pbta_move","text" to "Frozen legacy outcome"))
        assertFalse(legacy.hasStructuredPbtaResult);assertEquals("Frozen legacy outcome",legacy.displayText)
    }
    @Test fun completeWindowHistorySurvivesRestartAndDoesNotCrossAccounts() = runBlocking {
        val dir=Files.createTempDirectory("chat-history").toFile()
        try {
            val address=BackendAddress("https://history.test",false);val disk=AssetDiskCache(File(dir,"one"))
            val client=BackendClient(address,reads=disk)
            val history=ChatHistory((1..150).map{Message(id=it.toString(),content="Line $it",authorName="Reader",kind="ic",seq=it.toLong())},false)
            client.keepHistory(history,"c","w").join()
            assertEquals(history,BackendClient(address,reads=AssetDiskCache(File(dir,"one"))).cachedHistory("c","w"))
            assertNull(BackendClient(address,reads=AssetDiskCache(File(dir,"two"))).cachedHistory("c","w"))
            val late=client.keepHistory(history,"c","w");disk.clear();late.join();assertNull(client.cachedHistory("c","w"))
        } finally { dir.deleteRecursively() }
    }
}
