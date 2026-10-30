package app.acerciae.mobile.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class BackendClientTest {
    @Test fun savedSessionsCannotOverrideCompiledServer() {
        assertTrue(ServiceConfiguration.acceptsSavedEndpoint(ServiceConfiguration.BACKEND_ROOT + "/"))
        assertFalse(ServiceConfiguration.acceptsSavedEndpoint("http://localhost:18083"))
        assertFalse(ServiceConfiguration.acceptsSavedEndpoint("https://another.example"))
    }
    @Test fun registrationUsesPublicEndpointAndReturnsSession() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"token":"test-token","user":{"id":"u","username":"new_user","display_name":"新玩家"}}"""))
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            val session = client.register("new_user", "local-test-password", "新玩家")
            assertEquals("新玩家", session.user.displayName)
            val request = server.takeRequest()
            assertEquals("/api/auth/register", request.path)
            assertEquals("POST", request.method)
            assertNull(request.getHeader("Authorization"))
            val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("new_user", body.text("username"))
            assertEquals("新玩家", body.text("display_name"))
            server.enqueue(MockResponse().setResponseCode(409).setBody("private diagnostic"))
            try { client.register("new_user", "local-test-password", ""); fail("Duplicate must fail") }
            catch (e: BackendException) { assertEquals(409, e.status); assertFalse(e.message!!.contains("private")) }
        }
    }
    @Test fun remoteHttpAndEmbeddedCredentialsAreRejected() {
        listOf("http://example.com", "https://user:secret@example.com", "https://example.com/api", "https://example.com?token=secret").forEach {
            assertThrows(IllegalArgumentException::class.java) { BackendAddress(it, true) }
        }
        assertThrows(IllegalArgumentException::class.java) { BackendAddress("http://localhost:8080", false) }
    }
    @Test fun websocketTokenIsEncodedAndSegmentsCannotEscape() {
        val address = BackendAddress("https://example.com", false)
        assertEquals("https://example.com/api/channels/a%2Fb", address.api("channels", "a/b").toString())
        assertEquals("wss://example.com/ws/context?token=a%26b%3D", address.websocket(RealtimeStream.CONTEXT, "a&b="))
    }
    @Test fun healthAndAuthenticatedCallsFollowExistingContracts() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"status":"ok","llm_mode":"mock","db":"ok","future":true}"""))
            server.enqueue(MockResponse().setBody("""[{"id":"s1","name":"Arkham","owner_id":"u1"}]"""))
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            assertEquals("mock", client.health().llmMode)
            assertEquals("/api/health", server.takeRequest().path)
            assertEquals("Arkham", client.servers("test-token").single().name)
            val request = server.takeRequest()
            assertEquals("/api/servers", request.path)
            assertEquals("Bearer test-token", request.getHeader("Authorization"))
        }
    }
    @Test fun errorsDoNotExposeServerBodies() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401).setBody("private diagnostic"))
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            try { client.servers("invalid"); fail("Expected 401") }
            catch (error: BackendException) { assertEquals(401, error.status); assertFalse(error.message!!.contains("private")) }
        }
    }
    @Test fun sharedFixtureDecodesAndReferencesExistingContent() {
        val text = javaClass.classLoader!!.getResourceAsStream("demo-campaign.json")!!.bufferedReader().use { it.readText() }
        val fixture = Json.decodeFromString<DemoCampaign>(text)
        assertEquals(6, fixture.documents.size)
        assertTrue(fixture.highlights.all { hint -> fixture.documents.any { it.id == hint.documentId } })
        assertTrue(fixture.highlights.flatMap { it.sourceEventIds }.all { id -> fixture.messages.any { it.id == id } })
        assertEquals(fixture.messages.size, fixture.messages.map { it.id }.toSet().size)
    }
    @Test fun dicePayloadAndHiddenNoticeStayIntact() {
        val json = Json { ignoreUnknownKeys = true }
        val message = json.decodeFromString<Message>("""{"id":"m","content":".rh 1d100","author_name":"Alice","author_id":"a","kind":"roll","seq":4,"dice":{"text":"secret result","hidden":true,"future_key":{"raw_rolls":[42]}}}""")
        assertEquals("a", message.authorId)
        assertEquals("secret result", message.displayText)
        assertEquals(42, message.dice!!.obj("future_key")["raw_rolls"]!!.jsonArray.first().jsonPrimitive.int)
        val notice = json.decodeFromString<Message>("""{"id":"n","content":"hidden roll","author_name":"Alice","kind":"roll","seq":5,"dice":{"type":"hidden_notice"}}""")
        assertEquals("", notice.displayText)
    }
    @Test fun writesPaginationAndDownloadsUseBearerAndNoRedirects() = runBlocking {
        MockWebServer().use { server ->
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            server.enqueue(MockResponse().setBody("{}"))
            client.resource(listOf("servers", "s", "settings"), "token", payload("language" to "zh"), "PUT")
            val write = server.takeRequest()
            assertEquals("PUT", write.method)
            assertEquals("Bearer token", write.getHeader("Authorization"))
            assertEquals("zh", Json.parseToJsonElement(write.body.readUtf8()).jsonObject.text("language"))
            server.enqueue(MockResponse().setBody("{}"))
            client.resource(listOf("servers", "s", "invites", "i"), "token", method = "DELETE")
            val revoke = server.takeRequest()
            assertEquals("DELETE", revoke.method)
            assertEquals("Bearer token", revoke.getHeader("Authorization"))
            assertEquals(0L, revoke.bodySize)
            server.enqueue(MockResponse().setBody("[]"))
            client.messages("token", "c", "w", 42)
            assertEquals("42", server.takeRequest().requestUrl!!.queryParameter("before_seq"))
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://example.com/leak"))
            try { client.bytes(listOf("channels", "c", "media", "m"), "token"); fail("Redirect must be rejected") }
            catch (e: BackendException) { assertEquals(302, e.status) }
        }
    }

    @Test fun imageUploadUsesAuthenticatedMultipartAndRejectsRedirects() = runBlocking {
        MockWebServer().use { server ->
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            server.enqueue(MockResponse().setBody("{}"))
            client.uploadCharacterAsset("c", "h", "subtitle", "IDLE", byteArrayOf(1, 2, 3), "token")
            val request = server.takeRequest()
            assertEquals("/api/channels/c/characters/h/assets", request.path)
            assertEquals("Bearer token", request.getHeader("Authorization"))
            assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data;"))
            val body = request.body.readUtf8()
            assertTrue(body.contains("name=\"slot\"")); assertTrue(body.contains("IDLE")); assertTrue(body.contains("filename=\"artwork.png\""))
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://example.com/leak"))
            try { client.uploadCharacterAsset("c", "h", "avatar", "", byteArrayOf(1), "token"); fail("Redirect must be rejected") }
            catch (e: BackendException) { assertEquals(302, e.status) }
        }
    }

    @Test fun pointRuleErrorsAreActionableButOtherBodiesStayPrivate() = runBlocking {
        MockWebServer().use { server ->
            val client = BackendClient(BackendAddress(server.url("/").toString(), true))
            server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"points_rule","message":"Dodge is not one of the career's skills"}"""))
            try { client.resource(listOf("channels", "c", "characters", "h", "card"), "token", payload("name" to "Alice"), "PUT"); fail("Expected validation error") }
            catch (e: PointRuleException) { assertTrue(e.message!!.contains("Dodge")) }
            server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"internal","message":"private diagnostic"}"""))
            try { client.resource(listOf("channels", "c"), "token"); fail("Expected error") }
            catch (e: BackendException) { assertFalse(e.message!!.contains("private")) }
        }
    }

}
