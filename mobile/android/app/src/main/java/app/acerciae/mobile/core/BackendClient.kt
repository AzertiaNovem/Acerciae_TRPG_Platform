package app.acerciae.mobile.core

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class BackendAddress(value: String, allowLocalHttp: Boolean) {
    val url: HttpUrl = value.trim().toHttpUrl().also {
        require(it.username.isEmpty() && it.password.isEmpty()) { "地址不能包含账号或密码" }
        require(it.query == null && it.fragment == null && it.encodedPath == "/") { "请输入服务根地址，不要附加 /api、查询或片段" }
        val local = it.host in setOf("localhost", "127.0.0.1", "10.0.2.2")
        require(it.isHttps || (allowLocalHttp && local)) { "远程服务需要 HTTPS；调试版仅允许本机 HTTP" }
    }
    fun api(vararg segments: String): HttpUrl = url.newBuilder().addPathSegment("api")
        .apply { segments.forEach { addPathSegment(it) } }.build()
    fun websocket(stream: RealtimeStream, token: String): String = url.newBuilder()
        .addPathSegment("ws").addPathSegment(stream.path).addQueryParameter("token", token)
        .build().toString().replaceFirst(if (url.isHttps) "https:" else "http:", if (url.isHttps) "wss:" else "ws:")
}

enum class RealtimeStream(val path: String) { CHAT("chat"), CONTEXT("context") }
class PointRuleException(message: String) : IllegalArgumentException("购点校验未通过：" + message.take(2000))
class BackendException(val status: Int) : IOException(when (status) {
    401 -> "登录已过期，请重新登录"
    403 -> "当前账号没有权限，或管理员已关闭此功能"
    404 -> "内容不可用，或服务版本尚未提供此功能"
    429 -> "请求过多或已达到预算限制，请稍后重试"
    else -> "服务请求失败（HTTP $status）"
})

/** Existing REST contracts only. The app owns secure session persistence; tokens are never logged. */
class BackendClient(
    private val address: BackendAddress,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build(),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private suspend inline fun <reified T> request(path: List<String>, token: String? = null, body: String? = null, method: String? = null, query: Map<String, String> = emptyMap()): T =
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(address.api(*path.toTypedArray()).newBuilder().apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build())
                .apply { if (token != null) header("Authorization", "Bearer $token") }
                .apply { if (body != null || method != null) method(method ?: "POST", body?.toRequestBody("application/json".toMediaType())) }.build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    if (response.code == 400) {
                        val error = runCatching { json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject }.getOrNull()
                        if (error?.text("error") == "points_rule") throw PointRuleException(error.text("message"))
                    }
                    throw BackendException(response.code)
                }
                json.decodeFromString<T>(response.body?.string() ?: throw IOException("服务返回空内容"))
            }
        }
    suspend fun resource(path: List<String>, token: String, body: JsonObject? = null, method: String? = null, query: Map<String, String> = emptyMap()): JsonObject = request(path, token, body?.toString(), method, query)
    suspend fun resources(path: List<String>, token: String, query: Map<String, String> = emptyMap()): List<JsonObject> = request(path, token, query = query)
    suspend fun bytes(path: List<String>, token: String, query: Map<String, String> = emptyMap()): ByteArray = withContext(Dispatchers.IO) {
        val url = address.api(*path.toTypedArray()).newBuilder().apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        client.newCall(Request.Builder().url(url).header("Authorization", "Bearer $token").build()).execute().use {
            if (!it.isSuccessful) throw BackendException(it.code)
            it.body?.bytes() ?: throw IOException("空文件")
        }
    }
    suspend fun uploadCharacterAsset(channel: String, character: String, slot: String, subtitle: String, bytes: ByteArray, token: String): JsonObject = withContext(Dispatchers.IO) {
        require(bytes.size <= 10 * 1024 * 1024) { "请选择小于 10 MB 的图片" }
        val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
            .addFormDataPart("slot", slot).addFormDataPart("subtitle", subtitle)
            .addFormDataPart("file", "artwork.png", bytes.toRequestBody("application/octet-stream".toMediaType())).build()
        client.newCall(Request.Builder().url(address.api("channels", channel, "characters", character, "assets")).header("Authorization", "Bearer $token").post(body).build()).execute().use {
            if (!it.isSuccessful) throw BackendException(it.code)
            json.decodeFromString<JsonObject>(it.body?.string() ?: throw IOException("空响应"))
        }
    }
    suspend fun health(): Health = request(listOf("health"))
    suspend fun register(username: String, password: String, displayName: String): Session = request(
        listOf("auth", "register"), body = json.encodeToString(mapOf("username" to username, "password" to password, "display_name" to displayName)),
    )
    suspend fun login(username: String, password: String): Session = request(
        listOf("auth", "login"), body = json.encodeToString(mapOf("username" to username, "password" to password)),
    )
    suspend fun servers(token: String): List<Server> = request(listOf("servers"), token)
    suspend fun channels(token: String, server: String): List<Channel> = request(listOf("servers", server, "channels"), token)
    suspend fun windows(token: String, channel: String): List<ChatWindow> = request(listOf("channels", channel, "windows"), token)
    suspend fun messages(token: String, channel: String, window: String, before: Long? = null): List<Message> = request(listOf("channels", channel, "windows", window, "messages"), token, query = mapOf("limit" to "50") + (before?.let { mapOf("before_seq" to it.toString()) } ?: emptyMap()))
    suspend fun documents(token: String, channel: String): List<DocumentSummary> = request(listOf("channels", channel, "documents"), token)
    suspend fun document(token: String, channel: String, document: String): DocumentDetail = request(listOf("channels", channel, "documents", document), token)
    suspend fun highlights(token: String, channel: String): List<Highlight> = request(listOf("channels", channel, "highlights"), token)
}
