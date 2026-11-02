package app.acerciae.mobile
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun ModuleImports(state: AppState, model: AppViewModel, close: () -> Unit) {
    var modules by remember { mutableStateOf(emptyList<JsonObject>()) }; var builds by remember { mutableStateOf(emptyList<JsonObject>()) }
    var title by remember { mutableStateOf("") }; var text by remember { mutableStateOf("") }
    val base = listOf("channels", state.channelId)
    suspend fun refresh() { modules = model.rows(base + "modules"); builds = model.rows(base + listOf("script-knowledge", "builds")) }
    val context = LocalContext.current
    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if(uri != null) model.launch {
        val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use { stream ->
            val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
            while(true) { val count = stream.read(buffer); if(count < 0) break; require(output.size() + count <= 25 * 1024 * 1024) { tr("Choose a PDF smaller than 25 MB") }; output.write(buffer, 0, count) }; output.toByteArray()
        } ?: error(tr("Unable to read file")) }
        val value = model.uploadModule(bytes, title)
        if(value.flag("deduplicated")) model.notice(tr("This module already exists. Showing its current task."))
        refresh()
    } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(state.channelId, lifecycle, state.gm) { if(state.gm) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        try { while(true) { if(!model.state.value.busy) refresh(); delay(5000) } }
        catch(e: CancellationException) { throw e } catch(e: Exception) { model.notice(e.message) }
    } }
    if(!state.gm) return
    LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton(onClick = close) { Text(tr("Back")) }; Text(tr("Module imports"), style = MaterialTheme.typography.titleLarge) }
        item { OutlinedTextField(title, { title = it }, label = { Text(tr("Title")) }); OutlinedTextField(text, { text = it }, label = { Text(tr("Module text")) }, minLines = 4, maxLines = 12) }
        item { Button(onClick = { model.launch {
            val result = model.get(base + listOf("modules", "text"), buildJsonObject { put("title", title); put("text", text); put("async", true) })
            if(result.flag("deduplicated")) model.notice(tr("This module already exists. Showing its current task."))
            refresh(); text = ""
        } }, enabled = !state.busy && text.isNotBlank()) { Text(tr("Import text")) }
            TextButton(onClick = { upload.launch(arrayOf("application/pdf")) }, enabled = !state.busy) { Text(tr("Import PDF")) }
            Text(tr("Imports continue on the server when you leave this page. Ready with a warning means the module graph is usable."), style = MaterialTheme.typography.bodySmall)
        }
        items(modules, key = { it.id }) { module -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(module.name, style = MaterialTheme.typography.titleMedium); Text(moduleStageLabel(module.text("import_stage").ifEmpty { module.text("status") }))
            if(module.text("import_stage") == "structuring" && module.number("total_chunks") > 0) {
                LinearProgressIndicator(progress = { (module.number("completed_chunks").toFloat() / module.number("total_chunks")).coerceIn(0f, 1f) })
                Text("${module.number("completed_chunks")} / ${module.number("total_chunks")} " + tr("chunks"))
            } else if(module.text("status") !in listOf("ready", "failed")) LinearProgressIndicator()
            if(module.text("error").isNotEmpty()) Text(module.text("error"), color = MaterialTheme.colorScheme.error)
            if(module.text("import_warning").isNotEmpty()) Text(module.text("import_warning"))
            if(module.text("status") == "failed") TextButton(onClick = { model.launch { model.get(base + listOf("modules", module.id, "retry"), JsonObject(emptyMap())); refresh() } }, enabled = !state.busy) { Text(tr("Retry import")) }
            if(module.text("status") == "ready") TextButton(onClick = { model.launch {
                model.get(base + listOf("script-knowledge", "rebuild"), buildJsonObject { put("module_id", module.id); put("async", true) }); refresh()
            } }, enabled = !state.busy && builds.none { it.text("module_id") == module.id && it.text("status") in listOf("pending", "running") }) { Text(tr("Rebuild script knowledge")) }
        } } }
        items(builds, key = { "build:" + it.id }) { b -> Column {
            Text(tr("Script knowledge") + " · " + modules.find { it.id == b.text("module_id") }?.name.orEmpty()); Text(moduleStageLabel(b.text("status")))
            if(b.number("total_batches") > 0) Text("${b.number("completed_batches")} / ${b.number("total_batches")} " + tr("batches"))
            if(b.text("status") in listOf("pending", "running")) LinearProgressIndicator()
            if(b.text("error").isNotEmpty()) Text(b.text("error"), color = MaterialTheme.colorScheme.error)
            if(b.text("status") == "completed") Text(tr("Entries") + " · ${b.obj("result").number("entries")}")
        } }
        item { TextButton(onClick = { model.launch { refresh() } }, enabled = !state.busy) { Text(tr("Refresh")) } }
    }
}

private fun moduleStageLabel(value: String) = tr(mapOf("queued" to "Queued", "uploaded" to "Queued", "extracting" to "Extracting PDF text", "structuring" to "Structuring module", "knowledge" to "Building script knowledge", "ready" to "Ready", "failed" to "Failed", "pending" to "Pending", "running" to "Running", "completed" to "Completed")[value] ?: value)
