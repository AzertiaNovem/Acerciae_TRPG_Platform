package app.acerciae.mobile.core

import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
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
class InvalidBackendResponse : IOException("服务返回的数据格式不兼容，请更新客户端或联系管理员")
class BackendException(val status: Int, val apiResponse: Boolean = true) : IOException(if (!apiResponse) "服务入口暂时不可用（HTTP $status），请稍后重试" else when (status) {
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
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS)
        .callTimeout(150, TimeUnit.SECONDS).retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).build(),
    /** Downloaded media kept on disk for the signed-in account (see [AssetDiskCache]); null keeps nothing. */
    var assets: AssetDiskCache? = null,
    var reads: AssetDiskCache? = null,
) {
    private val transfers = mutableMapOf<String, Deferred<ByteArray>>()
    private val transferLock = Mutex()
    private val transferScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private fun cacheKey(path: List<String>, query: Map<String, String>) = address.api(*path.toTypedArray()).newBuilder().apply { query.toSortedMap().forEach { (k, v) -> addQueryParameter(k, v) } }.build().toString()
    suspend fun cachedValue(path: List<String>, query: Map<String, String> = emptyMap()): JsonElement? = withContext(Dispatchers.IO) {
        reads?.get(cacheKey(path, query))?.let { runCatching { json.parseToJsonElement(it.toString(Charsets.UTF_8)) }.getOrNull() }
    }
    private val json = Json { ignoreUnknownKeys = true }
    private suspend inline fun <reified T> request(path: List<String>, token: String? = null, body: String? = null, method: String? = null, query: Map<String, String> = emptyMap()): T =
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(address.api(*path.toTypedArray()).newBuilder().apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build())
                .apply { if (token != null) header("Authorization", "Bearer $token") }
                .apply { if (body != null || method != null) method(method ?: "POST", body?.toRequestBody("application/json".toMediaType())) }.build()
            val cache = reads; val generation = cache?.generation()
            val ticket = if(request.method == "GET" && ReadCachePolicy.keep(path)) cache?.reserve(cacheKey(path,query)) else null
            val bytes = try { send(request.newBuilder().header("Accept","application/json").build()) }
                catch (e: BackendException) { if(e.apiResponse && e.status in listOf(401,403,404)) cache?.remove(cacheKey(path,query)); throw e }
            val value = decode<T>(bytes.toString(Charsets.UTF_8))
            if (request.method == "GET" && ReadCachePolicy.keep(path)) cache?.put(cacheKey(path, query), bytes, generation, ticket)
            value
        }
    suspend fun resource(path: List<String>, token: String, body: JsonObject? = null, method: String? = null, query: Map<String, String> = emptyMap()): JsonObject = request(path, token, body?.toString(), method, query)
    suspend fun resources(path: List<String>, token: String, query: Map<String, String> = emptyMap()): List<JsonObject> = request(path, token, query = query)
    /** Media bytes; with the picture's content [hash] the disk cache serves them by content (see [AssetDiskCache.key]). */
    suspend fun bytes(path: List<String>, token: String, query: Map<String, String> = emptyMap(), hash: String? = null): ByteArray = withContext(Dispatchers.IO) {
        val url = cacheKey(path, query)
        val key = AssetDiskCache.key(hash, url)
        val task = transferLock.withLock {
            transfers[key] ?: transferScope.async(start = CoroutineStart.LAZY) {
                val cache = assets; val generation = cache?.generation()
                cache?.get(key)?.let { return@async it }
                val fetched = sendFetched(Request.Builder().url(url).header("Authorization", "Bearer $token").build())
                if (cache != null && AssetDiskCache.keepable(fetched.cacheControl)) cache.put(key, fetched.bytes, generation)
                fetched.bytes
            }.also { pending ->
                transfers[key] = pending
                pending.invokeOnCompletion { transferScope.launch { transferLock.withLock { if (transfers[key] === pending) transfers.remove(key) } } }
                pending.start()
            }
        }
        task.await()
    }

    suspend fun uploadCharacterAsset(channel: String, character: String, slot: String, subtitle: String, bytes: ByteArray, token: String): JsonObject = withContext(Dispatchers.IO) {
        require(bytes.size <= 10 * 1024 * 1024) { "请选择小于 10 MB 的图片" }
        val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
            .addFormDataPart("slot", slot).addFormDataPart("subtitle", subtitle)
            .addFormDataPart("file", "artwork.png", bytes.toRequestBody("application/octet-stream".toMediaType())).build()
        decode<JsonObject>(send(Request.Builder().url(address.api("channels",channel,"characters",character,"assets")).header("Authorization","Bearer $token").post(body).build()).toString(Charsets.UTF_8))
    }
    suspend fun uploadModule(channel: String, title: String, bytes: ByteArray, token: String): JsonObject = withContext(Dispatchers.IO) {
        require(bytes.size <= 25 * 1024 * 1024)
        val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM).addFormDataPart("title", title)
            .addFormDataPart("file", "module.pdf", bytes.toRequestBody("application/pdf".toMediaType())).build()
        decode<JsonObject>(send(Request.Builder().url(address.api("channels",channel,"modules")).header("Authorization","Bearer $token").post(body).build()).toString(Charsets.UTF_8))
    }
    private inline fun <reified T> decode(text: String): T = try { json.decodeFromString<T>(text) } catch(e:kotlinx.serialization.SerializationException) { throw InvalidBackendResponse() }
    /** A response's bytes and its Cache-Control header (the disk cache keeps only what the server marks immutable). */
    class Fetched(val bytes: ByteArray, val cacheControl: String?)
    private suspend fun send(original: Request): ByteArray = sendFetched(original).bytes
    private suspend fun sendFetched(original: Request): Fetched {
        val request=original.newBuilder().header("User-Agent","AcerciaeMobile/0.1 (Android)").build()
        for(attempt in 0..2) {
            try { return execute(request) } catch(e:IOException) {
                if(request.method !in listOf("GET","HEAD") || attempt==2 || !ConnectionPolicy.retry(e)) throw e
                delay(400L shl attempt)
            }
        }
        throw InvalidBackendResponse()
    }
    private suspend fun execute(request: Request): Fetched = suspendCancellableCoroutine { continuation ->
        val call=client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object:okhttp3.Callback {
            override fun onFailure(call:okhttp3.Call,e:IOException) { if(continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call:okhttp3.Call,response:okhttp3.Response) {
                try {
                    val data=response.use {
                        val bytes=it.body?.bytes() ?: throw InvalidBackendResponse()
                        if(!it.isSuccessful) {
                            val error=runCatching { json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject }.getOrNull()
                            if(it.code==400 && error?.text("error")=="points_rule") throw PointRuleException(error.text("message"))
                            throw BackendException(it.code,!error?.text("error").isNullOrEmpty())
                        }
                        Fetched(bytes, it.header("Cache-Control"))
                    }
                    if(continuation.isActive) continuation.resume(data)
                } catch(e:Exception) { if(continuation.isActive) continuation.resumeWithException(e) }
            }
        })
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
