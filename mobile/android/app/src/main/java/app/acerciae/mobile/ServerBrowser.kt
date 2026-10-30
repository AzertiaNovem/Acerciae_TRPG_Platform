package app.acerciae.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.*

@Composable fun ServerBrowser(state: AppState, model: AppViewModel, close: () -> Unit) {
    var query by remember { mutableStateOf("") }; var code by remember { mutableStateOf("") }
    var invite by remember { mutableStateOf<JsonObject?>(null) }
    var servers by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var watching by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    suspend fun load() {
        servers = model.rows(listOf("server-directory"), mapOf("q" to query)); watching = emptyList()
        if (state.serverId.isNotEmpty() && state.serverRole != "guest" && state.serverSettings.obj("policy").flag("main_chat_spectators")) watching = model.rows(listOf("servers", state.serverId, "spectate"))
    }
    suspend fun joined(id: String) { model.refreshCatalog(); model.selectServer(id); close() }
    LaunchedEffect(state.serverId) { model.run { load() } }
    if (selected != null) { SpectatorPage(selected!!, state, model) { selected = null }; return }
    LazyColumn(Modifier.fillMaxSize().imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton(onClick = close) { Text(tr("Done")) }; Text(tr("Servers"), style = MaterialTheme.typography.titleLarge) }
        item { Text(tr("Join a server"), style = MaterialTheme.typography.titleMedium) }
        item { OutlinedTextField(code, { code = it; invite = null }, label = { Text(tr("Invite code")) }) }
        item { TextButton(onClick = { model.launch { invite = model.get(listOf("invites", code.trim())) } }, enabled = code.isNotBlank() && !state.busy) { Text(tr("Preview")) } }
        invite?.let { value -> item { Text(value.name); Button(onClick = { model.launch { val s = model.get(listOf("invites", code.trim(), "accept"), JsonObject(emptyMap())); joined(s.id) } }, enabled = value.flag("valid") && !state.busy) { Text(tr("Join")) } } }
        item { Text(tr("Open servers"), style = MaterialTheme.typography.titleMedium); OutlinedTextField(query, { query = it }, label = { Text(tr("Search")) }); TextButton(onClick = { model.launch { load() } }, enabled = !state.busy) { Text(tr("Search")) } }
        items(servers, key = { it.id }) { item ->
            Text(item.name + " · ${item.number("member_count")} " + tr("Members"))
            val member = state.servers.any { it.id == item.id }
            TextButton(onClick = { model.launch { if (!member) model.get(listOf("servers", item.id, "join"), JsonObject(emptyMap())); joined(item.id) } }, enabled = !state.busy) { Text(tr(if (member) "Open" else "Join")) }
        }
        if (watching.isNotEmpty()) item { Text(tr("Read-only Main Chat"), style = MaterialTheme.typography.titleMedium) }
        items(watching, key = { "watch:" + it.id }) { item -> TextButton(onClick = { selected = item }) { Text(item.name) } }
    }
}
@Composable private fun SpectatorPage(channel: JsonObject, state: AppState, model: AppViewModel, close: () -> Unit) {
    var messages by remember(channel.id) { mutableStateOf<List<JsonObject>>(emptyList()) }; var more by remember { mutableStateOf(false) }
    suspend fun load(older: Boolean = false) {
        // Use only sanitized spectator messages, with no character or document lookups.
        try {
            val value = model.get(listOf("channels", channel.id, "spectate"), query = mapOf("limit" to "50") + if (older) mapOf("before_seq" to messages.first().text("seq")) else emptyMap())
            val next = value.rows("messages"); messages = if (older) next + messages else next; more = next.size >= 50
        } catch (e: Exception) { messages = emptyList(); more = false; throw e }
    }
    LaunchedEffect(channel.id) { model.run { load() } }
    LazyColumn(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton(onClick = close) { Text(tr("Back")) }; Text(channel.name, style = MaterialTheme.typography.titleLarge); Text(tr("Read-only Main Chat")) }
        item { TextButton(onClick = { model.launch { load() } }, enabled = !state.busy) { Text(tr("Refresh")) } }
        if (more) item { TextButton(onClick = { model.launch { load(true) } }, enabled = !state.busy) { Text(tr("Load earlier messages")) } }
        items(messages, key = { it.id }) { item -> Text(item.text("author_name"), style = MaterialTheme.typography.labelSmall); Text(item.text("content")) }
    }
}
