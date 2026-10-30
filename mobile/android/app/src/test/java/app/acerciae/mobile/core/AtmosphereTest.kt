package app.acerciae.mobile.core
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
class AtmosphereTest {
    @Test fun fourVariantsOnlyFromCompleteEnabledSet() {
        val assets = buildJsonObject { Atmosphere.variants.forEach { put(it, "$it-asset") } }
        val current = buildJsonObject { put("enabled", true); put("assets", assets) }
        for (dark in listOf(false,true)) for (portrait in listOf(false,true)) assertEquals((if (dark) "night" else "day") + (if (portrait) "_portrait-asset" else "_landscape-asset"), Atmosphere.asset(current,dark,portrait))
        Atmosphere.variants.forEach { key -> assertNull(Atmosphere.asset(buildJsonObject { put("enabled",true);put("assets",JsonObject(assets-key)) },true,true)) }
        assertNull(Atmosphere.asset(JsonObject(current + ("enabled" to JsonPrimitive(false))),true,true))
        assertNull(Atmosphere.asset(buildJsonObject { put("enabled",true) },true,true))
    }
    @Test fun oldAccountsDefaultOffAndPreferenceSurvivesSessionStorage() {
        assertFalse(Json.decodeFromString<User>("""{"id":"u","username":"user","display_name":"User"}""").atmosphereEnabled)
        val user=Json.decodeFromString<User>("""{"id":"u","username":"user","display_name":"User","atmosphere_enabled":true}""")
        assertTrue(Json.decodeFromString<Session>(Json.encodeToString(Session("test-only",user))).user.atmosphereEnabled)
    }
    @Test fun authenticatedPreviewAndBooleanPreference() = runBlocking {
        MockWebServer().use { server ->
            val client=BackendClient(BackendAddress(server.url("/").toString(),true))
            server.enqueue(MockResponse().setBody("{}"))
            client.resource(listOf("auth","me"),"test", buildJsonObject { put("atmosphere_enabled",true) },"PUT")
            val write=server.takeRequest();assertEquals("PUT",write.method);assertTrue(Json.parseToJsonElement(write.body.readUtf8()).jsonObject.flag("atmosphere_enabled"))
            server.enqueue(MockResponse().setBody("image"))
            client.bytes(listOf("channels","c","atmosphere","assets","a"),"test")
            val preview=server.takeRequest();assertEquals("/api/channels/c/atmosphere/assets/a",preview.path);assertEquals("Bearer test",preview.getHeader("Authorization"));assertFalse(preview.path!!.contains("token="))
        }
    }
}
