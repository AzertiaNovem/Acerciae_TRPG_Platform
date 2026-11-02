package app.acerciae.mobile
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
@Composable fun NovelTools(state:AppState,model:AppViewModel,presentation:String,canContinue:Boolean,download:(ByteArray,String)->Unit) {
    var bundles by remember { mutableStateOf(emptyList<JsonObject>()) }; var status by remember { mutableStateOf(JsonObject(emptyMap())) }; var cloud by remember { mutableStateOf(false) }; var art by remember { mutableStateOf(false) }; var continuing by remember { mutableStateOf(false) }; var queued by remember { mutableStateOf(false) }
    val base=listOf("channels",state.channelId,"studio"); val lifecycle=LocalLifecycleOwner.current.lifecycle
    suspend fun reload() { bundles=model.rows(base+listOf("presentations",presentation,"bundles")) }
    LaunchedEffect(presentation,lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { try { status=model.get(base+listOf("vn-scripts","status")); while(true) { reload(); delay(4000) } } catch(e:CancellationException) { throw e } catch(e:Exception) { model.notice(e.message) } } }
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        TextButton(onClick={model.launch { model.get(base+listOf("presentations",presentation,"bundle"),JsonObject(emptyMap())); reload() }},enabled=!state.busy) { Text(tr("Prepare download")) }
        bundles.forEach { j ->
            Text(tr(j.text("status"))+" · ${j.obj("progress").number("files_done")}/${j.obj("progress").number("files_total")}",style=MaterialTheme.typography.bodySmall)
            if(j.text("error").isNotEmpty()) Text(j.text("error"),color=MaterialTheme.colorScheme.error)
            if(j.text("status")=="ready") TextButton(onClick={model.launch { download(model.bytes(base+listOf("bundles",j.id,"download")),"novel-${j.id}.zip") }},enabled=!state.busy) { Text(tr("Download")+" ZIP") }
        }
        if(canContinue) TextButton(onClick={continuing=!continuing}) { Text(tr("Continue the story")) }
        if(continuing) {
            Text(tr("The lines posted since this visual novel ends are written as new scenes after it, in the same point of view. The AI is told where the story stopped and reuses its backgrounds and portraits; it asks only for the places and poses that are new. The direction above applies."))
            if(!status.flag("mock")) Row { Checkbox(cloud,{cloud=it},enabled=status.flag("cloud_allowed")); Text(tr("同意将选定日志发送至配置的云端服务")) }
            Row { Checkbox(art,{art=it},enabled=status.flag("images")); Text(tr("同时生成缺失的背景与立绘")) }
            TextButton(onClick={model.launch { model.get(base+"vn-scripts",buildJsonObject { put("continue_presentation_id",presentation); put("allow_cloud",cloud); put("generate_art",art) }); queued=true }},enabled=!state.busy && status.isNotEmpty() && (status.flag("mock") || (cloud && status.flag("cloud_allowed")))) { Text(tr("Continue the story")) }
            if(queued) Text(tr("Continuation queued. Follow progress in visual novel tasks."))
        }
    }
}
@Composable fun NovelRecovery(state:AppState,model:AppViewModel,id:String) {
    var job by remember { mutableStateOf(JsonObject(emptyMap())) }; var retry by remember { mutableStateOf(true) }
    val base=listOf("channels",state.channelId,"studio","vn-scripts",id); val lifecycle=LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(id,lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { try { while(true) { job=model.get(base); delay(4000) } } catch(e:CancellationException) { throw e } catch(e:Exception) { model.notice(e.message) } } }
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        if(job.text("status")=="failed") {
            Row { Checkbox(retry,{retry=it}); Text(tr("Retry failed chunks")) }
            TextButton(onClick={model.launch { job=model.get(base+"retry",buildJsonObject { put("retry_failed_chunks",retry) }) }},enabled=!state.busy) { Text(tr("Retry script")) }
        }
        job.rows("background_jobs").forEach { bg ->
            Text(bg.text("scene_key")+" · "+tr(bg.text("status")),style=MaterialTheme.typography.bodySmall)
            if(bg.text("error").isNotEmpty()) Text(bg.text("error"),color=MaterialTheme.colorScheme.error)
            if(bg.text("status") in listOf("missing","failed","cancelled")) TextButton(onClick={model.launch { model.get(base+listOf("backgrounds","retry"),payload("scene_key" to bg.text("scene_key"))); job=model.get(base) }},enabled=!state.busy) { Text(tr("Retry background")) }
        }
    }
}
