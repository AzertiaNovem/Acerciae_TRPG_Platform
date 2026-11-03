package app.acerciae.mobile

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.MediaType.Companion.toMediaType
import org.junit.Assert.*
import org.junit.Test

class StudioAITest {
    @Test fun credentialsStayInNativeHeadersAndErrorsStayStructured() = runBlocking {
        val config=StudioAIConfig(endpoint="https://fixture.invalid/v1",model="fixture",key="fixture-key")
        val client=OkHttpClient.Builder().addInterceptor { chain ->
            val request=chain.request();assertEquals("https://fixture.invalid/v1/chat/completions",request.url.toString());assertEquals("Bearer fixture-key",request.header("Authorization"))
            val buffer=okio.Buffer();request.body!!.writeTo(buffer);assertFalse(buffer.readUtf8().contains("fixture-key"))
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(429).message("Limited").body("{\"error\":\"retry later\"}".toResponseBody("application/json".toMediaType())).build()
        }.build()
        val result=StudioAITransport(client).send(buildJsonObject {put("model","fixture")},config)
        assertEquals(429,result["status"]!!.jsonPrimitive.int);assertEquals("retry later",result["body"]!!.jsonObject["error"]!!.jsonPrimitive.content)
        assertFalse(config.publicValue().toString().contains("fixture-key"))
    }
    @Test fun rejectsCredentialsInUrlsAndInsecureServices() {
        listOf("http://fixture.invalid/v1","https://user:password@fixture.invalid/v1","https://fixture.invalid/v1?key=secret","https://fixture.invalid/v1#fragment").forEach { endpoint ->
            try {StudioAIConfig(endpoint=endpoint,model="m",key="key").url();fail(endpoint)} catch(_:IllegalArgumentException) {}
        }
        assertEquals("https://fixture.invalid/v1/messages",StudioAIConfig("anthropic","https://fixture.invalid/v1","m","key").url())
    }
}
