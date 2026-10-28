package app.acerciae.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.*

@Composable fun ServerManagementPage(state: AppState, model: AppViewModel, area: String, close: () -> Unit) {
    if (!state.serverSettings.flag("is_maintainer")) { Text(tr("Only server maintainers can change these settings.")); return }
    var draft by remember(state.serverId) { mutableStateOf(state.serverSettings) }
    var invites by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var channels by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var uses by remember { mutableStateOf("10") }; var hours by remember { mutableStateOf("168") }
    var doomed by remember { mutableStateOf<JsonObject?>(null) }; var deleteServer by remember { mutableStateOf(false) }; var phrase by remember { mutableStateOf("") }
    fun set(group: String, key: String, value: JsonElement) { draft = JsonObject(draft + (group to JsonObject(draft.obj(group) + (key to value)))) }
    suspend fun loadInvites() { invites = model.rows(listOf("servers", state.serverId, "invites")) }
    fun save(keys: List<String>) { model.launch {
        val body = buildJsonObject { keys.forEach { group -> put(group, JsonObject(draft.obj(group).filterKeys { it !in listOf("api_key_set", "api_key_hint") && (group != "ai_policy" || it in listOf("token_budget", "image_budget", "period", "max_concurrent")) })) } }
        draft = model.get(listOf("servers", state.serverId, "settings"), body, "PUT"); model.refreshCatalog(); model.notice(tr("Saved"))
    } }
    LaunchedEffect(state.serverId, area) { model.run { if (area == "Access") loadInvites(); if (area == "Channels") channels = model.rows(listOf("servers", state.serverId, "all-channels")) } }
    Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = close) { Text(tr("Back")) }; Text(tr(area), style = MaterialTheme.typography.titleLarge)
        if (area == "Access") {
            Choice(tr("How people join"), draft.obj("policy").text("join_policy"), listOf("invite" to tr("With an invite link from a maintainer"), "open" to tr("Open: listed in the server directory, anyone may join"), "closed" to tr("Closed: only maintainers add members")), !state.busy) { set("policy", "join_policy", JsonPrimitive(it)) }
            Choice(tr("Who may create channels"), draft.obj("policy").text("channel_creation"), listOf("members" to tr("Every member"), "maintainers" to tr("Maintainers only")), !state.busy) { set("policy", "channel_creation", JsonPrimitive(it)) }
            listOf("guest_invites" to "Channel GMs may invite guests", "main_chat_spectators" to "Members may read other channels' Main Chat").forEach { (key, label) ->
                Row { Text(tr(label), Modifier.weight(1f)); Switch(draft.obj("policy").flag(key), { set("policy", key, JsonPrimitive(it)) }, enabled = !state.busy) }
            }
            Text(tr("A GM can invite people from outside the server. Guests see only the channels they were invited to and leave the server with their last channel."))
            Text(tr("Members not invited to a channel can read its Main Chat, read-only: only lines everyone at that table sees. Guests never can."))
            Button(onClick = { save(listOf("policy")) }, enabled = !state.busy) { Text(tr("Save")) }
            Text(tr("Invite links"), style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(uses, { uses = it }, label = { Text(tr("Maximum uses")) }); OutlinedTextField(hours, { hours = it }, label = { Text(tr("Expires in (hours)")) })
            Button(onClick = { model.launch { model.get(listOf("servers", state.serverId, "invites"), buildJsonObject { put("max_uses", uses.toInt()); put("expires_in_hours", hours.toInt()) }); loadInvites() } }, enabled = !state.busy && (uses.toIntOrNull() ?: -1) in 0..10000 && (hours.toIntOrNull() ?: -1) in 0..8760 && state.serverSettings.obj("policy").text("join_policy") != "closed") { Text(tr("Create link")) }
            invites.forEach { invite ->
                androidx.compose.foundation.text.selection.SelectionContainer { Text(invite.text("code")) }
                Text("${invite.number("uses")} / ${invite.number("max_uses")} · ${invite.text("expires_at")}")
                if (invite.flag("active")) TextButton(onClick = { model.launch { model.get(listOf("servers", state.serverId, "invites", invite.id), method = "DELETE"); loadInvites() } }, enabled = !state.busy) { Text(tr("Revoke")) }
            }
        } else if (area == "AI") {
            Text(tr("AI on this server runs only on the providers configured here, with this server's own keys. Without them it runs in mock mode."))
            listOf("llm", "image", "tts").forEach { group ->
                val providers = when(group) { "llm" -> listOf("mock", "openai_compatible", "anthropic"); "image" -> listOf("disabled", "mock", "gpt_image"); else -> listOf("disabled", "mock", "qwen") }
                Text(tr(when(group) { "llm" -> "Language model"; "image" -> "Image generation"; else -> "Voice" }), style = MaterialTheme.typography.titleMedium)
                Choice(tr("Provider"), draft.obj(group).text("provider"), providers.map { it to it }, !state.busy) { set(group, "provider", JsonPrimitive(it)) }
                (listOf("api_base", "model") + when(group) { "llm" -> listOf("embedding_model", "reasoning_effort"); "image" -> listOf("size", "quality"); else -> listOf("voice") }).forEach { key ->
                    OutlinedTextField(draft.obj(group).text(key), { set(group, key, JsonPrimitive(it)) }, label = { Text(tr(fieldName(key))) }, enabled = !state.busy)
                }
                OutlinedTextField(draft.obj(group).text("api_key"), { set(group, "api_key", JsonPrimitive(it)) }, label = { Text(tr("New API key (leave blank to keep)")) }, visualTransformation = PasswordVisualTransformation(), enabled = !state.busy)
                Text(state.serverSettings.obj(group).text("api_key_hint"))
                Row { Text(tr("Clear saved API key"), Modifier.weight(1f)); Switch(draft.obj(group).flag("clear_api_key"), { set(group, "clear_api_key", JsonPrimitive(it)) }, enabled = !state.busy) }
            }
            Text(tr("AI policy"), style = MaterialTheme.typography.titleMedium)
            listOf("token_budget", "image_budget", "max_concurrent").forEach { key -> OutlinedTextField(draft.obj("ai_policy").text(key), { text -> text.toLongOrNull()?.takeIf { it >= 0 }?.let { set("ai_policy", key, JsonPrimitive(it)) } }, label = { Text(tr(fieldName(key))) }, enabled = !state.busy) }
            Choice(tr("Budget period"), draft.obj("ai_policy").text("period"), listOf("month" to tr("Each calendar month"), "total" to tr("Total")), !state.busy) { set("ai_policy", "period", JsonPrimitive(it)) }
            Button(onClick = { save(listOf("llm", "image", "tts", "ai_policy")) }, enabled = !state.busy) { Text(tr("Save")) }
        } else {
            channels.forEach { item -> Text(item.name); TextButton(onClick = { doomed = item; phrase = "" }, enabled = !state.busy) { Text(tr("Delete channel")) } }
            if (state.serverRole == "owner") TextButton(onClick = { deleteServer = true; phrase = "" }, enabled = !state.busy) { Text(tr("Delete server")) }
        }
    }
    if (doomed != null || deleteServer) {
        val expected = if (deleteServer) "Delete Server" else "Delete Channel"
        AlertDialog(onDismissRequest = { if (!state.busy) { doomed = null; deleteServer = false } }, title = { Text(if (deleteServer) state.serverName else doomed!!.name) }, text = { Column {
            Text(tr(if (deleteServer) "Every channel goes with it — chat, characters, documents, media and logs — for every member, and its invites stop working. This cannot be undone." else "Its chat, characters, documents, media, scenarios and logs are deleted for every member. This cannot be undone."))
            OutlinedTextField(phrase, { phrase = it }, label = { Text(tr("Type {phrase} to confirm.").replace("{phrase}", expected)) })
        } }, confirmButton = { TextButton(onClick = { model.launch {
            model.get(if (deleteServer) listOf("servers", state.serverId) else listOf("channels", doomed!!.id), payload("confirm" to phrase), "DELETE")
            doomed = null; deleteServer = false; model.refreshCatalog(); close()
        } }, enabled = phrase == expected && !state.busy) { Text(tr("Delete")) } }, dismissButton = { TextButton(onClick = { doomed = null; deleteServer = false }, enabled = !state.busy) { Text(tr("Cancel")) } })
    }
}
private fun fieldName(key: String) = mapOf("api_base" to "API base URL", "model" to "Model", "embedding_model" to "Embedding model", "reasoning_effort" to "Thinking effort", "size" to "Image size", "quality" to "Image quality", "voice" to "Voice", "token_budget" to "Token budget", "image_budget" to "Image budget", "max_concurrent" to "Simultaneous AI tasks")[key] ?: key

@Composable fun StoryControls(state: AppState, model: AppViewModel) {
    var reveal by remember { mutableStateOf(false) }; var confirm by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(tr("Story"), style = MaterialTheme.typography.titleMedium)
        if (state.channel.text("story_status") == "ended") {
            Text(tr(if (state.channel.flag("story_reveal_all")) "Every member can read the whole story in the Log Studio, Keeper-only lines included." else "Every member can read the whole story in the Log Studio. Keeper-only lines stay with you."))
            TextButton(onClick = { model.launch { model.get(listOf("channels", state.channelId, "story", "reopen"), JsonObject(emptyMap())); model.refresh() } }, enabled = !state.busy) { Text(tr("Reopen the story")) }
        } else {
            Text(tr("When the story ends, the Log Studio opens to every member and the campaign log shows them the whole story: every chat window, whispers and hidden rolls, and the scenario titles."))
            Row { Text(tr("Also reveal Keeper-only lines"), Modifier.weight(1f)); Switch(reveal, { reveal = it }, enabled = !state.busy) }
            TextButton(onClick = { confirm = true }, enabled = !state.busy) { Text(tr("End the story")) }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text(tr("End the story")) }, text = { Text(tr("End the story? Every member of this channel will be able to read the whole story in the Log Studio.")) }, confirmButton = { TextButton(onClick = { confirm = false; model.launch { model.get(listOf("channels", state.channelId, "story", "end"), buildJsonObject { put("reveal_keeper_lines", reveal) }); model.refresh() } }, enabled = !state.busy) { Text(tr("End the story")) } }, dismissButton = { TextButton(onClick = { confirm = false }) { Text(tr("Cancel")) } })
}
