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
@Composable fun WorldRecord(state: AppState, model: AppViewModel) {
    var world by remember { mutableStateOf(JsonObject(emptyMap())) }; var text by remember { mutableStateOf("") }; var secret by remember { mutableStateOf(true) }; var error by remember { mutableStateOf("") }
    val base=listOf("channels",state.channelId,"world"); val lifecycle=LocalLifecycleOwner.current.lifecycle
    suspend fun reload() { world=model.get(base); error="" }
    LaunchedEffect(state.scopeKey,lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { try { while(true) { reload(); delay(5000) } } catch(e: CancellationException) { throw e } catch(e: Exception) { error=e.message.orEmpty() } } }
    Column(verticalArrangement=Arrangement.spacedBy(10.dp)) {
        Text(tr("World record"),style=MaterialTheme.typography.titleMedium)
        if(error.isNotEmpty()) Text(error,color=MaterialTheme.colorScheme.error)
        world.rows("entities").forEach { entity ->
            var open by remember(entity.id) { mutableStateOf(false) }
            TextButton(onClick={open=!open}) { Text(entity.name+" · "+tr(entity.text("status"))) }
            if(open) { Text(entity.text("description")); Text((entity["state"] as? JsonPrimitive)?.contentOrNull ?: entity["state"].toString()); Text(entity.obj("location").name); Text("v${entity.number("state_version")} · ${entity.text("state_updated_at")}",style=MaterialTheme.typography.bodySmall) }
        }
        if(world.rows("entities").isEmpty()) Text(tr("No world state recorded yet."))
        var changes by remember { mutableStateOf(false) }; TextButton(onClick={changes=!changes}) { Text(tr("Recent changes")) }
        if(changes) world.rows("recent_changes").forEach { Text(it.name+" · "+tr(it.text("status"))+"\n"+((it["state"] as? JsonPrimitive)?.contentOrNull ?: it["state"].toString()),style=MaterialTheme.typography.bodySmall) }
        if(state.gm) {
            OutlinedTextField(text,{text=it},label={Text(tr("Declare a change in the world"))})
            Row { Checkbox(secret,{secret=it}); Text(tr("Secret")) }
            Button(onClick={model.launch { model.get(base+"declare",buildJsonObject { put("text",text); put("secret",secret) },query=mapOf("observe" to state.channel.flag("ai_enabled").toString())); text=""; reload() }},enabled=!state.busy && text.isNotBlank() && text.length<=4000) { Text(tr("Record declaration")) }
        }
        TextButton(onClick={model.launch { reload() }}) { Text(tr("Refresh")) }
    }
}
