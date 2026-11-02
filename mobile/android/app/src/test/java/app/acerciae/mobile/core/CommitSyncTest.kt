package app.acerciae.mobile.core
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
class CommitSyncTest {
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject
    @Test fun channelSwitchesCannotOverrideServerAndOldChannelsRemainCompatible() {
        val server = obj("""{"features":{"consistency":true,"inspiration":true,"atmosphere":true,"dice":true}}""")
        listOf("consistency", "inspiration", "atmosphere").forEach { f ->
            assertTrue(FeatureAccess.enabled(f, server, obj("{}")))
            assertFalse(FeatureAccess.enabled(f, server, buildJsonObject { put(f + "_enabled", false) }))
            assertFalse(FeatureAccess.enabled(f, obj("{}"), buildJsonObject { put(f + "_enabled", true) }))
        }
        assertTrue(FeatureAccess.enabled("dice", server, obj("""{"ai_enabled":false,"dice_enabled":false}""")))
    }
    @Test fun objectStoreAvatarAndOlderSessionRoundTrip() {
        listOf("""{"id":"u","username":"test","display_name":"Test","has_avatar":true,"avatar_data":"","avatar_version":3}""", """{"id":"u","username":"test","display_name":"Test"}""").forEach { value ->
            val user = Json.decodeFromString<User>(value)
            assertEquals(user.hasAvatar, Json.decodeFromString<Session>(Json.encodeToString(Session("test-only", user))).user.hasAvatar)
        }
    }
    @Test fun asyncImportUsesAuthenticatedMultipartAndAcceptsQueuedReceipt() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"id":"module","status":"uploaded","import_stage":"queued"}"""))
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            val result = client.uploadModule("ch", "Test module", "%PDF-test".toByteArray(), "test-only")
            assertEquals("queued", result.text("import_stage")); assertNotEquals("ready", result.text("status"))
            val request = server.takeRequest(); assertEquals("/api/channels/ch/modules", request.path); assertEquals("POST", request.method)
            assertEquals("Bearer test-only", request.getHeader("Authorization"))
            assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data; boundary="))
            val body = request.body.readUtf8(); assertTrue(body.contains("name=\"file\"; filename=\"module.pdf\"")); assertTrue(body.contains("Test module")); assertTrue(body.contains("%PDF-test"))
        }
    }
}
