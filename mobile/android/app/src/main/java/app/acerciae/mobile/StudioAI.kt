package app.acerciae.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@Serializable data class StudioAIConfig(val provider:String="openai",val endpoint:String="",val model:String="",val key:String="") {
    fun url():String {
        val uri=URI(endpoint)
        require(provider in listOf("openai","anthropic") && model.isNotBlank() && key.isNotBlank() && uri.scheme=="https" && !uri.host.isNullOrBlank() && uri.userInfo==null && uri.query==null && uri.fragment==null) { "Enter an HTTPS service address, model and API key" }
        return endpoint.trimEnd('/')+if(provider=="anthropic") "/messages" else "/chat/completions"
    }
    fun publicValue()=buildJsonObject { put("provider",provider);put("endpoint",endpoint);put("model",model) }
}
class StudioAISecrets(context:Context) {
    private val preferences=context.getSharedPreferences("studio_ai_secrets",Context.MODE_PRIVATE)
    private fun key():SecretKey {
        val alias="acerciae.studio.ai.v1"; val store=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias,null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply { init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()) }.generateKey()
    }
    fun read():StudioAIConfig {
        val encoded=preferences.getString("ciphertext",null) ?: return StudioAIConfig()
        val bytes=Base64.decode(encoded,Base64.NO_WRAP); require(bytes.size>28)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(0,12)))
        return Json.decodeFromString(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8))
    }
    fun save(config:StudioAIConfig) {
        config.url();val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key())
        val bytes=cipher.iv+cipher.doFinal(Json.encodeToString(config).toByteArray(Charsets.UTF_8))
        check(preferences.edit().putString("ciphertext",Base64.encodeToString(bytes,Base64.NO_WRAP)).commit())
    }
    fun clear() { check(preferences.edit().clear().commit()) }
}
class StudioAITransport(private val client:OkHttpClient=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(300,TimeUnit.SECONDS).readTimeout(300,TimeUnit.SECONDS).build()) {
    suspend fun send(body:JsonObject,config:StudioAIConfig):JsonObject = suspendCancellableCoroutine { cont ->
        val request=Request.Builder().url(config.url()).post(body.toString().toRequestBody("application/json".toMediaType()))
        if(config.provider=="anthropic") {request.header("x-api-key",config.key);request.header("anthropic-version","2023-06-01")} else request.header("Authorization","Bearer "+config.key)
        val call=client.newCall(request.build());cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object:Callback {
            override fun onFailure(call:Call,e:IOException) { if(cont.isActive) cont.resumeWithException(e) }
            override fun onResponse(call:Call,response:Response) {
                try { response.use {
                    val out=java.io.ByteArrayOutputStream();response.body?.byteStream()?.use { stream -> val buffer=ByteArray(8192);while(true) {val n=stream.read(buffer);if(n<0) break;require(out.size()+n<=8*1024*1024) { "AI response is too large" };out.write(buffer,0,n)} }
                    val json=runCatching { Json.parseToJsonElement(out.toString("UTF-8")) }.getOrDefault(JsonNull)
                    val result=buildJsonObject { put("status",response.code);put("body",json) };if(cont.isActive) cont.resume(result)
                } } catch(e:Exception) { if(cont.isActive) cont.resumeWithException(e) }
            }
        })
    }
}
@Composable fun StudioAIEditor(model:LocalStudioViewModel) {
    var expanded by remember { mutableStateOf(false) };var config by remember { mutableStateOf(StudioAIConfig()) };var saved by remember { mutableStateOf(false) };var recompose by remember { mutableStateOf(false) };var review by remember { mutableStateOf(false) };var limit by remember { mutableIntStateOf(40) }
    val p=model.project ?: return;val draft=p.obj("vn_draft");val pending=draft.rows("pending")
    val last=p.obj("vn").obj("script").rows("scenes").flatMap {it.rows("lines")}.maxOfOrNull {it.number("seq")} ?: 0
    val hasNewLines=p.rows("events").any {it.number("seq")>last}
    fun begin(mode:String) { try { if(!(mode=="resume" && pending.isNotEmpty() && pending.all {it.flag("skip")})) {model.aiSecrets.save(config);saved=true};model.startAI(mode) } catch(e:Exception) {model.error=tr(e.message?:"Invalid AI response")} }
    LaunchedEffect(config) { saved=false }
    val edits=p.obj("vn").obj("script").rows("scenes").flatMap { it.rows("lines") }.filter { it.flag("hidden") || it.text("text").isNotEmpty() }
    LaunchedEffect(Unit) { try { config=model.aiSecrets.read() } catch(e:Exception) { model.error=e.message } }
    Column(verticalArrangement=Arrangement.spacedBy(10.dp)) {
        Text(tr("AI script editor"),style=MaterialTheme.typography.titleLarge)
        TextButton(onClick={expanded=!expanded},enabled=!model.busy) { Text(tr("AI service")) }
        if(expanded) {
            Row { listOf("openai" to "OpenAI compatible","anthropic" to "Anthropic").forEach { (kind,label) -> FilterChip(config.provider==kind,{config=config.copy(provider=kind)},label={Text(label)},enabled=!model.busy) } }
            OutlinedTextField(config.endpoint,{config=config.copy(endpoint=it)},label={Text(tr("Service address"))},singleLine=true,enabled=!model.busy,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(config.model,{config=config.copy(model=it)},label={Text(tr("Model"))},singleLine=true,enabled=!model.busy,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(config.key,{config=config.copy(key=it)},label={Text("API key")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password,autoCorrectEnabled=false),singleLine=true,enabled=!model.busy,modifier=Modifier.fillMaxWidth())
            TextButton(onClick={try {model.aiSecrets.save(config);saved=true} catch(e:Exception) {model.error=e.message}},enabled=!model.busy) {Text(tr("Save"))}
            TextButton(onClick={try {model.aiSecrets.clear();config=StudioAIConfig();saved=false} catch(e:Exception) {model.error=e.message}},enabled=!model.busy) {Text(tr("Remove saved AI key"))}
            if(saved) Text(tr("Saved"))
        }
        Text(tr("AI receives this project's logs and character context. Keys stay on this device and are excluded from backups."),style=MaterialTheme.typography.bodySmall)
        OutlinedTextField(p.text("mobile_ai_instructions"),{model.update("mobile_ai_instructions",JsonPrimitive(it))},label={Text(tr("Editing directions"))},enabled=!model.busy,modifier=Modifier.fillMaxWidth())
        if(p["mobile_ai_job"] is JsonObject) {
            TextButton(onClick={begin("retry")},enabled=!model.busy) {Text(tr("Resume unfinished task"))}
            TextButton(onClick={model.discardAI("mobile_ai_job")},enabled=!model.busy) {Text(tr("Discard unfinished task"))}
        } else if(pending.isNotEmpty()) {
            val events=p.rows("events").filter {it.number("seq")>draft.number("from_seq")}
            pending.forEachIndexed {index,part ->
                Text("L${part.number("first_line")}–L${part.number("last_line")}")
                part.rows("questions").forEach {question ->
                    Text(question.text("question"))
                    (question["refs"] as? JsonArray).orEmpty().forEach {ref -> val label=ref.jsonPrimitive.content;val line=label.drop(1).toIntOrNull()?.let {events.getOrNull(it-1)};Text(label+" · "+(line?.text("content")?:""),style=MaterialTheme.typography.bodySmall) }
                    (question["options"] as? JsonArray).orEmpty().forEach {option -> TextButton(onClick={model.answerAI(index,question.text("id"),option.jsonPrimitive.content)},enabled=!model.busy) {Text(option.jsonPrimitive.content)} }
                    OutlinedTextField(part.obj("answers").text(question.text("id")),{model.answerAI(index,question.text("id"),it)},label={Text(tr("Your answer"))},enabled=!model.busy,modifier=Modifier.fillMaxWidth())
                }
                Row {Checkbox(part.flag("skip"),{model.answerAI(index,null,skip=it)},enabled=!model.busy);Text(tr("Keep this part's draft"))}
            }
            val ready=pending.all {it.flag("skip") || it.obj("answers").values.any {v->v.jsonPrimitive.content.isNotBlank()}}
            TextButton(onClick={begin("resume")},enabled=!model.busy && ready) {Text(tr("Submit answers and continue"))}
            TextButton(onClick={model.discardAI("vn_draft")},enabled=!model.busy) {Text(tr("Discard questions"))}
        } else {
            TextButton(onClick={if(p["vn"] is JsonObject) recompose=true else begin("compose")},enabled=!model.busy) {Text(tr("Compose / rewrite with AI"))}
            if(p["vn"] is JsonObject) TextButton(onClick={begin("continue")},enabled=!model.busy && hasNewLines) {Text(tr("Continue from added logs"))}
        }
        Text(tr("Backgrounding pauses AI work. Resume it here; saved responses are reused."),style=MaterialTheme.typography.bodySmall)
        if(edits.isNotEmpty()) {
            TextButton(onClick={review=!review}) {Text(tr("Rewrites and exclusions"))}
            if(review) {edits.take(limit).forEach {line -> Text("#${line.number("seq")} · "+(p.rows("events").firstOrNull {it.number("seq")==line.number("seq")}?.text("content")?:""),style=MaterialTheme.typography.bodySmall);Text(if(line.flag("hidden")) line.text("exclusion_reason") else line.text("text"))};if(edits.size>limit) TextButton(onClick={limit+=40}) {Text(tr("Show more"))}}
        }
        (p.obj("vn").obj("script")["notes"] as? JsonArray).orEmpty().forEach {Text(it.jsonPrimitive.content,style=MaterialTheme.typography.bodySmall)}
    }
    if(recompose) AlertDialog(onDismissRequest={recompose=false},title={Text(tr("Replace the existing script?"))},text={Text(tr("The original logs stay unchanged. The existing script is kept until generation succeeds."))},confirmButton={TextButton(onClick={recompose=false;begin("compose")}) {Text(tr("Compose / rewrite with AI"))}},dismissButton={TextButton(onClick={recompose=false}) {Text(tr("取消"))}})
}
