package app.acerciae.mobile

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.print.PrintManager
import android.webkit.*
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

internal class LocalStudioStore(private val root: File) {
    private val mutex = Mutex()
    private fun folder(id: String): File { UUID.fromString(id); require(!id.contains('/') && !id.contains('\\')); return File(root,id) }
    private fun asset(id:String,path:String): File { require(Regex("assets/[A-Za-z0-9-]+\\.(png|jpg|jpeg|webp)").matches(path)); return File(folder(id),path) }
    private fun atomic(file:File,text:String) { file.parentFile?.mkdirs(); val tmp=File(file.parentFile,file.name+".tmp"); tmp.writeText(text); check(tmp.renameTo(file)) }
    suspend fun list(): List<JsonObject> = withContext(Dispatchers.IO) { mutex.withLock {
        root.listFiles().orEmpty().mapNotNull { dir -> runCatching { UUID.fromString(dir.name); Json.parseToJsonElement(File(dir,"meta.json").readText()).jsonObject }.getOrNull() }.sortedByDescending { it.text("updated_at") }
    } }
    suspend fun load(id:String): JsonObject = withContext(Dispatchers.IO) { mutex.withLock { Json.parseToJsonElement(File(folder(id),"project.json").readText()).jsonObject } }
    suspend fun save(p:JsonObject) = withContext(Dispatchers.IO) { mutex.withLock {
        ensureActive(); val dir=folder(p.id); val text=p.toString(); require(text.toByteArray().size<=16*1024*1024)
        atomic(File(dir,"project.json"),text)
        atomic(File(dir,"meta.json"),buildJsonObject { put("id",p.id); put("title",p.text("title")); put("events",p.rows("events").size); put("updated_at",java.time.Instant.now().toString()) }.toString())
    } }
    suspend fun delete(id:String) = withContext(Dispatchers.IO) { mutex.withLock { check(folder(id).deleteRecursively()) } }
    private fun readAssets(id:String): JsonObject {
        var total=0L
        return buildJsonObject {
            File(folder(id),"assets").listFiles().orEmpty().forEach { file ->
                val path="assets/"+file.name; asset(id,path); total+=file.length(); require(total<=20L*1024*1024)
                val mime=if(file.extension=="png") "png" else if(file.extension=="webp") "webp" else "jpeg"
                put(path,"data:image/$mime;base64,"+java.util.Base64.getEncoder().encodeToString(file.readBytes()))
            }
        }
    }
    suspend fun assets(id:String): JsonObject = withContext(Dispatchers.IO) { mutex.withLock { readAssets(id) } }
    suspend fun readAsset(id:String,path:String): ByteArray = withContext(Dispatchers.IO) { mutex.withLock { asset(id,path).readBytes() } }
    suspend fun addAssets(id:String,values:JsonObject) = withContext(Dispatchers.IO) { mutex.withLock {
        if(values.isEmpty()) return@withLock
        val combined=readAssets(id)+values; require(combined.values.sumOf { it.jsonPrimitive.content.length.toLong() }<=28L*1024*1024)
        val decoded=combined.map { (path,v) ->
            asset(id,path); val text=v.jsonPrimitive.content
            require(Regex("^data:image/(png|jpeg|webp);base64,").containsMatchIn(text))
            val bytes=java.util.Base64.getDecoder().decode(text.substringAfter(',')); require(bytes.size<=10*1024*1024)
            path to bytes
        }
        require(decoded.sumOf { it.second.size.toLong() }<=20L*1024*1024)
        decoded.filter { values.containsKey(it.first) }.forEach { (path,bytes) ->
            val file=asset(id,path); file.parentFile?.mkdirs(); val tmp=File(file.parentFile,file.name+".tmp"); tmp.writeBytes(bytes); check(tmp.renameTo(file))
        }
    } }
    suspend fun removeUnusedAsset(id:String,path:String,project:JsonObject) = withContext(Dispatchers.IO) { mutex.withLock {
        if(!path.startsWith("assets/")) return@withLock
        fun references(value:JsonElement): Boolean = when(value) { is JsonObject -> value.values.any { references(it) }; is JsonArray -> value.any { references(it) }; is JsonPrimitive -> value.content==path }
        if(!references(project)) { val file=asset(id,path); if(file.exists()) check(file.delete()) }
    } }

}
@android.annotation.SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
private class StudioEngine(context:Context) {
    private val web=WebView(context)
    private val ready=CompletableDeferred<Unit>()
    private var failure:Throwable?=null
    private var destroyed=false
    private val pending=mutableMapOf<String,CompletableDeferred<String>>()
    private val main=Handler(Looper.getMainLooper())
    init {
        web.settings.javaScriptEnabled=true; web.settings.blockNetworkLoads=true; web.settings.allowFileAccess=false; web.settings.allowContentAccess=false
        web.addJavascriptInterface(object {
            @JavascriptInterface fun complete(id:String,value:String) { main.post { pending.remove(id)?.complete(value) } }
        },"StudioNative")
        web.webViewClient=object:WebViewClient() {
            override fun onRenderProcessGone(view:WebView,detail:android.webkit.RenderProcessGoneDetail):Boolean { val error=IllegalStateException("AI runtime stopped; resume the saved task");failure=error;ready.completeExceptionally(error);pending.values.forEach {it.completeExceptionally(error)};pending.clear();web.destroy();destroyed=true;return true }
            override fun onPageFinished(view:WebView,url:String) { ready.complete(Unit) }
            override fun onReceivedError(view:WebView,request:WebResourceRequest,error:WebResourceError) { ready.completeExceptionally(IllegalStateException(error.description.toString())) }
        }
        web.loadUrl("file:///android_asset/studio-engine.html")
    }
    suspend fun call(input:JsonObject): JsonObject = withTimeout(60_000) {
        failure?.let {throw it};ready.await(); val id=UUID.randomUUID().toString(); val result=CompletableDeferred<String>(); pending[id]=result
        try {
            web.evaluateJavascript("MobileStudio.run(${JsonPrimitive(input.toString())}).then(function(value){StudioNative.complete('$id',value)})",null)
            val envelope=Json.parseToJsonElement(result.await()).jsonObject
            check(envelope.flag("ok")) { envelope.text("error") }; envelope.obj("value")
        } finally { pending.remove(id) }
    }
    fun close() { if(!destroyed) {web.removeJavascriptInterface("StudioNative"); web.destroy();destroyed=true}; pending.values.forEach { it.cancel() }; pending.clear() }
}
// The only JS bridge lives in this packaged, network-disabled engine; document viewers have no bridge.


data class StudioDocument(val file:File,val title:String,val kind:String)
class LocalStudioViewModel(application:Application): AndroidViewModel(application) {
    var projects by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var project by mutableStateOf<JsonObject?>(null); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)
    var document by mutableStateOf<StudioDocument?>(null)
    var aiRunning by mutableStateOf(false); private set
    var aiProgress by mutableStateOf(""); private set
    private var aiTask:Job?=null
    val aiSecrets=StudioAISecrets(application)
    fun startAI(mode:String) {
        if(busy) return
        busy=true;aiRunning=true
        aiTask=viewModelScope.launch {
            var id=""
            try {
                flush();val parts=project!!.obj("vn_draft").rows("pending");val offline=mode=="resume" && parts.isNotEmpty() && parts.all {it.flag("skip")}
                val config=if(offline) StudioAIConfig(model="offline") else aiSecrets.read();if(!offline) config.url()
                engine.close();engine=StudioEngine(getApplication())
                var state=engine.call(buildJsonObject {put("action","aiStart");put("mode",mode);put("project",project!!);put("config",config.publicValue());put("language",MobileLocale.language);put("instructions",project!!.text("mobile_ai_instructions"))})
                id=state.text("id")
                while(true) {
                    ensureActive()
                    if(state.text("state")=="done") {project=state.obj("project");store.save(project!!);projects=store.list();break}
                    project=JsonObject(project!!+mapOf("mobile_ai_job" to state.obj("checkpoint")));store.save(project!!)
                    aiProgress="${state.number("done")} / ${state.number("total") }"
                    if(state.text("state")=="failed") kotlin.error(state.text("error"))
                    state=if(state["request"] is JsonObject) {
                        val response=StudioAITransport().send(state.obj("request").obj("body"),config)
                        engine.call(buildJsonObject {put("action","aiAnswer");put("id",id);put("response",response)})
                    } else {delay(50);engine.call(buildJsonObject {put("action","aiPoll");put("id",id)})}
                }
            } catch(e:Exception) {if(e !is CancellationException) error=tr(e.message?:"Invalid AI response")}
            finally {if(id.isNotEmpty()) withContext(NonCancellable) {runCatching {engine.call(buildJsonObject {put("action","aiCancel");put("id",id)})}};busy=false;aiRunning=false;aiProgress="";aiTask=null}
        }
    }
    fun pauseAI() {aiTask?.cancel()}
    fun discardAI(key:String) {project=JsonObject(project!!.filterKeys {it!=key});saveNow()}
    fun answerAI(index:Int,question:String?,value:String="",skip:Boolean?=null) {
        val draft=project!!.obj("vn_draft");val rows=draft.rows("pending").toMutableList();if(index !in rows.indices) return;val row=rows[index].toMutableMap()
        if(question!=null) row["answers"]=JsonObject(rows[index].obj("answers")+mapOf(question to JsonPrimitive(value.take(2000))))
        if(skip!=null) row["skip"]=JsonPrimitive(skip)
        rows[index]=JsonObject(row);update("vn_draft",JsonObject(draft+mapOf("pending" to JsonArray(rows))))
    }
    private val store=LocalStudioStore(File(application.filesDir,"OpenLogStudio/projects"))
    private var engine=StudioEngine(application)
    private var saveJob:Job?=null
    init { viewModelScope.launch { runCatching { store.list() }.onSuccess { projects=it }.onFailure { error=it.message } } }
    override fun onCleared() { engine.close(); super.onCleared() }
    fun perform(work:suspend ()->Unit) { if(busy) return; busy=true; viewModelScope.launch { try { work() } catch(e:CancellationException) { throw e } catch(e:Exception) { error=e.message ?: tr("Something went wrong in this view.") } finally { busy=false } } }
    suspend fun flush() { saveJob?.cancel(); project?.let { store.save(it) } }
    fun open(id:String) = perform { flush(); project=store.load(id) }
    fun back() = perform { flush(); project=null; projects=store.list() }
    fun delete(id:String) = perform { store.delete(id); projects=store.list() }
    fun update(key:String,value:JsonElement) { val current=project ?: return; val fields=current.toMutableMap(); fields[key]=value; if(key=="title") fields["background"]=JsonObject(current.obj("background")+mapOf("title" to value)); project=JsonObject(fields); saveJob?.cancel(); val snapshot=project!!; saveJob=viewModelScope.launch { try { delay(500); store.save(snapshot) } catch(e:CancellationException) { throw e } catch(e:Exception) { error=e.message } } }
    fun background(key:String,value:String) = update("background",JsonObject(project!!.obj("background")+mapOf(key to JsonPrimitive(value))))
    fun character(index:Int,key:String,value:JsonElement) { val rows=project!!.rows("characters").toMutableList(); rows[index]=JsonObject(rows[index]+mapOf(key to value)); update("characters",JsonArray(rows)) }
    private suspend fun read(uri:Uri): Pair<String,ByteArray> = withContext(Dispatchers.IO) {
        val resolver=getApplication<Application>().contentResolver
        val name=resolver.query(uri,arrayOf(android.provider.OpenableColumns.DISPLAY_NAME),null,null,null)?.use { if(it.moveToFirst()) it.getString(0) else null } ?: "log.txt"
        val bytes=resolver.openInputStream(uri)?.use { stream -> val out=java.io.ByteArrayOutputStream(); val buffer=ByteArray(8192); while(true) { val n=stream.read(buffer); if(n<0) break; require(out.size()+n<=32*1024*1024) { "File is too large" }; out.write(buffer,0,n) }; out.toByteArray() } ?: kotlin.error("Cannot read file")
        name to bytes
    }
    fun importFiles(uris:List<Uri>,append:Boolean) = perform {
        flush(); var total=0L
        val files=uris.map { uri -> val (name,bytes)=read(uri); total+=bytes.size; require(total<=32L*1024*1024) { "Files are too large" }; buildJsonObject { put("name",name); put("data",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)) } }
        val input=buildJsonObject { put("action","import"); put("files",JsonArray(files)); if(append) project?.let { put("project",it) } }
        val result=engine.call(input); val next=result.obj("project")
        store.addAssets(next.id,result.obj("assets")); store.save(next); project=next; projects=store.list()
    }
    fun picture(uri:Uri,index:Int?,slot:String) = perform {
        val (_,bytes)=read(uri); require(bytes.size<=10*1024*1024)
        val jpeg=withContext(Dispatchers.Default) {
            val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }; BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
            val options=BitmapFactory.Options().apply { inSampleSize=1; while(maxOf(bounds.outWidth,bounds.outHeight)/inSampleSize>1920) inSampleSize*=2 }
            val bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.size,options) ?: kotlin.error("Invalid image")
            val out=java.io.ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG,85,out); bitmap.recycle(); out.toByteArray()
        }
        val previous=if(index==null) project!!.text("mobile_background") else project!!.rows("characters")[index].text(slot)
        val path="assets/"+UUID.randomUUID()+".jpg"
        store.addAssets(project!!.id,buildJsonObject { put(path,"data:image/jpeg;base64,"+android.util.Base64.encodeToString(jpeg,android.util.Base64.NO_WRAP)) })
        if(index==null) update("mobile_background",JsonPrimitive(path)) else character(index,slot,JsonPrimitive(path)); flush(); store.removeUnusedAsset(project!!.id,previous,project!!)
    }
    fun export(action:String,ooc:Boolean,secret:Boolean) = perform {
        flush(); val p=project ?: return@perform
        val result=engine.call(buildJsonObject { put("action",action); put("project",p); put("assets",store.assets(p.id)); put("ooc",ooc); put("secret",secret); put("language",MobileLocale.language) })
        val html=result.text("html"); val ext=if(html.isEmpty()) result.text("ext") else "html"
        val file=withContext(Dispatchers.IO) { File.createTempFile("OpenLogStudio-",".$ext",getApplication<Application>().cacheDir).apply { writeText(if(html.isEmpty()) result.text("text") else html) } }
        document=StudioDocument(file,p.text("title"),action)
    }
    suspend fun image(path:String): Bitmap? {
        val bytes = store.readAsset(project!!.id,path)
        return withContext(Dispatchers.Default) {
            val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }; BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
            val options=BitmapFactory.Options().apply { inSampleSize=1; while(maxOf(bounds.outWidth,bounds.outHeight)/inSampleSize>512) inSampleSize*=2 }
            BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
        }
    }
    fun saveNow() { viewModelScope.launch { try { flush() } catch(e:Exception) { if(e !is CancellationException) error=e.message } } }
    fun finish(close:()->Unit) = perform { flush(); close() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun LocalStudioScreen(close:()->Unit, model:LocalStudioViewModel=viewModel()) {
    val context=LocalContext.current
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) { val observer=LifecycleEventObserver { _,event -> if(event==Lifecycle.Event.ON_STOP) { model.pauseAI(); model.saveNow() } }; lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); model.saveNow() } }
    var deleting by remember { mutableStateOf<JsonObject?>(null) }
    var imageIndex by remember { mutableStateOf<Int?>(null) }; var imageSlot by remember { mutableStateOf("portrait") }
    var ooc by remember { mutableStateOf(false) }; var secret by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf<Int?>(null) }
    val import=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { if(it.isNotEmpty()) model.importFiles(it,model.project!=null) }
    val picture=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let { model.picture(it,imageIndex,imageSlot) } }
    val document=model.document
    BackHandler { if(!model.busy) { if(document!=null) model.document=null else if(model.project!=null) model.back() else model.finish(close) } }
    if(document!=null) { StudioDocumentScreen(document,{model.document=null}); return }
    Scaffold(topBar={ TopAppBar(title={Text(model.project?.text("title") ?: tr("Open Log Studio"),maxLines=1)},navigationIcon={ if(model.project!=null) TextButton(onClick=model::back,enabled=!model.busy) { Text(tr("Projects")) } },actions={TextButton(onClick={model.finish(close)},enabled=!model.busy) { Text(tr("完成")) }}) }) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize().padding(horizontal=20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                val p=model.project
                if(p==null) {
                    item { Text(tr("Local projects stay on this device, including after sign-out."),style=MaterialTheme.typography.bodySmall) }
                    item { Button(onClick={import.launch(arrayOf("application/json","text/*","application/octet-stream"))},enabled=!model.busy) { Text(tr("Import logs")) } }
                    if(model.projects.isEmpty()) item { Text(tr("No local projects yet")) }
                    itemsIndexed(model.projects,key={_,row->row.id}) { _,row ->
                        Card { Row(Modifier.fillMaxWidth().padding(12.dp)) {
                            TextButton(onClick={model.open(row.id)},enabled=!model.busy,modifier=Modifier.weight(1f)) { Column(Modifier.fillMaxWidth()) { Text(row.text("title")); Text("${row.number("events")} · "+tr("Lines"),style=MaterialTheme.typography.bodySmall) } }
                            TextButton(onClick={deleting=row},enabled=!model.busy) { Text(tr("Delete")) }
                        } }
                    }
                } else {
                    item { OutlinedTextField(p.text("title"),{model.update("title",JsonPrimitive(it))},label={Text(tr("Title"))},enabled=!model.busy,modifier=Modifier.fillMaxWidth()) }
                    listOf("era" to "Era","setting" to "Special settings","summary" to "Summary").forEach { (key,label) -> item { OutlinedTextField(p.obj("background").text(key),{model.background(key,it)},label={Text(tr(label))},enabled=!model.busy,modifier=Modifier.fillMaxWidth()) } }
                    item { Text("${p.rows("events").size} · "+tr("Lines")); TextButton(onClick={import.launch(arrayOf("application/json","text/*","application/octet-stream"))},enabled=!model.busy) { Text(tr("Add more logs…")) } }
                    item { TextButton(onClick={imageIndex=null; picture.launch(arrayOf("image/png","image/jpeg","image/webp"))},enabled=!model.busy) { Text(tr("Choose background image")) }; if(p.text("mobile_background").isNotEmpty()) StudioLocalImage(model,p.text("mobile_background")) }
                    item { Text(tr("Characters"),style=MaterialTheme.typography.titleLarge) }
                    itemsIndexed(p.rows("characters")) { index,character ->
                        Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick={expanded=if(expanded==index) null else index}) { Text(character.text("name")) }
                            if(expanded==index) {
                                listOf("name" to "Name","player" to "Player","appearance" to "Appearance prompt").forEach { (key,label) -> OutlinedTextField(character.text(key),{model.character(index,key,JsonPrimitive(it))},label={Text(tr(label))},enabled=!model.busy,modifier=Modifier.fillMaxWidth()) }
                                Row { listOf("pc","npc","gm").forEach { kind -> FilterChip(character.text("kind")==kind,{model.character(index,"kind",JsonPrimitive(kind))},label={Text(kind.uppercase())},enabled=!model.busy) } }
                                listOf("avatar" to "Upload avatar","portrait" to "Upload portrait").forEach { (key,label) -> TextButton(onClick={imageIndex=index;imageSlot=key;picture.launch(arrayOf("image/png","image/jpeg","image/webp"))},enabled=!model.busy) { Text(tr(label)) }; if(character.text(key).isNotEmpty()) StudioLocalImage(model,character.text(key)) }
                            }
                        }
                    }
                    item { StudioAIEditor(model) }
                    item { Text(tr("Export"),style=MaterialTheme.typography.titleLarge) }
                    item { Row { Checkbox(ooc,{ooc=it}); Text(tr("Include OOC")) }; Row { Checkbox(secret,{secret=it}); Text(tr("Include secret messages")) } }
                    listOf("html" to "Preview log","pdf" to "PDF","vn" to "Play visual novel","archive" to "Export project backup","native" to "Export native JSON","text" to "Plain text").forEach { (action,label) -> item { OutlinedButton(onClick={model.export(action,ooc,secret)},enabled=!model.busy,modifier=Modifier.fillMaxWidth()) { Text(tr(label)) } } }
                    item { Text(tr("Project backups include all messages and local images."),style=MaterialTheme.typography.bodySmall) }
                    itemsIndexed(p.rows("issues").take(30)) { _,issue -> Text(issue.text("reason"),style=MaterialTheme.typography.bodySmall) }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
            if(model.busy) Column { LinearProgressIndicator(Modifier.fillMaxWidth()); if(model.aiRunning) Surface { Row { Text(model.aiProgress); TextButton(onClick=model::pauseAI) { Text(tr("Pause")) } } } }
        }
    }
    deleting?.let { item -> AlertDialog(onDismissRequest={deleting=null},title={Text(tr("Delete local project?"))},text={Text(item.text("title"))},confirmButton={TextButton(onClick={model.delete(item.id);deleting=null}) { Text(tr("Delete")) }},dismissButton={TextButton(onClick={deleting=null}) { Text(tr("取消")) }}) }
    model.error?.let { message -> AlertDialog(onDismissRequest={model.error=null},title={Text(tr("提示"))},text={Text(message)},confirmButton={TextButton(onClick={model.error=null}) { Text(tr("知道了")) }}) }
}
@Composable private fun StudioLocalImage(model:LocalStudioViewModel,path:String) {
    var image by remember(path) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(path) { try { image=model.image(path) } catch(e:CancellationException) { throw e } catch(_:Exception) {} }
    image?.let { Image(it.asImageBitmap(),tr("演出素材"),Modifier.fillMaxWidth().heightIn(max=220.dp)) }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun StudioDocumentScreen(document:StudioDocument,close:()->Unit) {
    val context=LocalContext.current
    val scope=rememberCoroutineScope(); var error by remember { mutableStateOf<String?>(null) }
    var web by remember { mutableStateOf<WebView?>(null) }; var ready by remember { mutableStateOf(false) }
    // The renderer is shared by every WebView of the app: when it stops, this viewer closes its page, the app stays.
    var stopped by remember { mutableStateOf(false) }
    val save=rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(if(document.file.extension=="html") "text/html" else if(document.file.extension=="json") "application/json" else "text/plain")) { uri -> if(uri!=null) scope.launch { try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { out -> document.file.inputStream().use { it.copyTo(out) } } ?: kotlin.error("Cannot save file") } } catch(e:Exception) { error=e.message } } }
    DisposableEffect(Unit) { onDispose { web?.destroy() } }
    Scaffold(topBar={TopAppBar(title={Text(document.title,maxLines=1)},navigationIcon={TextButton(onClick=close) { Text(tr("完成")) }},actions={
        if(document.kind=="pdf") TextButton(onClick={ web?.let { (context.getSystemService(Context.PRINT_SERVICE) as PrintManager).print(document.title,it.createPrintDocumentAdapter(document.title),null) } },enabled=ready) { Text(tr("Print / Save PDF")) }
        else TextButton(onClick={save.launch("OpenLogStudio."+document.file.extension)}) { Text(tr("Export")) }
    })}) { padding ->
        if(document.file.extension=="html" && stopped) Column(Modifier.padding(padding).padding(24.dp)) { Text(tr("Something went wrong in this view.")) }
        else if(document.file.extension=="html") AndroidView(factory={ctx -> WebView(ctx).apply {
            settings.javaScriptEnabled=document.kind=="vn"; settings.allowFileAccess=false;settings.allowContentAccess=false;settings.blockNetworkLoads=true
            webViewClient=object:WebViewClient() {
                override fun onPageFinished(view:WebView,url:String) { ready=true }
                override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest)= !(request.url.scheme=="https" && request.url.host=="appassets.androidplatform.net" && request.url.path=="/")
                // The view leaves the screen (and is destroyed on release); nothing may use it any more.
                override fun onRenderProcessGone(view:WebView,detail:RenderProcessGoneDetail):Boolean { if(web===view) web=null; ready=false; stopped=true; return true }
            }
            web=this
            scope.launch { val html=withContext(Dispatchers.IO) { document.file.readText() }; if(!stopped) loadDataWithBaseURL("https://appassets.androidplatform.net/",html,"text/html","UTF-8",null) }
        } },onRelease={ it.destroy() },modifier=Modifier.padding(padding).fillMaxSize())
        else Column(Modifier.padding(padding).padding(24.dp)) { Text(tr("Export ready")); if(document.kind=="archive") Text(tr("Project backups include all messages and local images.")) }
    }
    error?.let { Text(it) }
}
