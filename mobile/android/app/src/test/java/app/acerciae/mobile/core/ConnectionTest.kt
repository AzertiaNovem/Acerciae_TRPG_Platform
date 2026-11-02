package app.acerciae.mobile.core
import kotlinx.coroutines.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.JsonObject
class ConnectionTest {
    @Test fun safeReadsRecoverFromGatewayAndKeepAuthentication() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503));server.enqueue(MockResponse().setBody("[]"))
            val c=BackendClient(BackendAddress(server.url("/").toString(),true))
            assertTrue(c.servers("test-only").isEmpty()); assertEquals(2,server.requestCount)
            repeat(2) { val r=server.takeRequest(); assertEquals("Bearer test-only",r.getHeader("Authorization")); assertEquals("AcerciaeMobile/0.1 (Android)",r.getHeader("User-Agent")); assertEquals("application/json",r.getHeader("Accept")) }
        }
    }
    @Test fun writesAreNotReplayedAfterGatewayFailure() = runBlocking {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(503));s.enqueue(MockResponse().setBody("{}"))
            val c=BackendClient(BackendAddress(s.url("/").toString(),true))
            try { c.resource(listOf("messages"),"test-only",JsonObject(emptyMap())); fail("Expected failure") } catch(e:BackendException) { assertEquals(503,e.status) }
            assertEquals(1,s.requestCount)
        }
    }
    @Test fun edgeDenialDoesNotBecomeAnApplicationAuthDecision() = runBlocking {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(401).setBody("<html>Access denied</html>"))
            s.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))
            val c=BackendClient(BackendAddress(s.url("/").toString(),true))
            try { c.servers("test-only"); fail() } catch(e:BackendException) { assertFalse(e.apiResponse) }
            try { c.servers("test-only"); fail() } catch(e:BackendException) { assertTrue(e.apiResponse) }
            assertEquals(2,s.requestCount)
        }
    }
    @Test fun malformedDataIsNotReportedAsLostConnection() = runBlocking {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("<html>Proxy login</html>"))
            val c=BackendClient(BackendAddress(s.url("/").toString(),true))
            try { c.servers("test-only"); fail() } catch(e:InvalidBackendResponse) { assertTrue(e.message!!.contains("数据格式")) }
            assertEquals(1,s.requestCount)
        }
    }
    @Test fun retriesAreBounded() = runBlocking {
        MockWebServer().use { s ->
            repeat(3) { s.enqueue(MockResponse().setResponseCode(502)) }
            val c=BackendClient(BackendAddress(s.url("/").toString(),true))
            try { c.health(); fail() } catch(e:BackendException) { assertEquals(502,e.status) }
            assertEquals(3,s.requestCount)
        }
    }
    @Test fun cancellationStopsPendingNetworkRequest() = runBlocking {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val c=BackendClient(BackendAddress(s.url("/").toString(),true))
            val job=launch { c.health() }
            withContext(Dispatchers.IO) { assertNotNull(s.takeRequest(2,java.util.concurrent.TimeUnit.SECONDS)) }
            withTimeout(1000) { job.cancelAndJoin() }
            assertEquals(1,s.requestCount)
        }
    }
}
