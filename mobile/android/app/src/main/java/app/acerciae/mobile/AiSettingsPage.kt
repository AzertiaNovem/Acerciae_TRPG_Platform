package app.acerciae.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.*

// Server options → AI: the server's providers (an endpoint of a known kind with its own keys) and the provider and
// model of each use. A use only offers providers whose kind can do it. Same API and rules as the web.

private fun optionLabel(key: String, value: String) = when {
    key == "reasoning_effort" && value.isEmpty() -> tr("Thinking effort: off")
    value == "auto" -> tr("Provider default")
    key == "size" -> value
    else -> tr(value.replaceFirstChar { it.uppercase() })
}

@Composable fun AiProvidersSection(state: AppState, model: AppViewModel) {
    var catalog by remember { mutableStateOf<JsonObject?>(null) }
    var ai by remember(state.serverId) { mutableStateOf(state.serverSettings.obj("ai")) }
    var uses by remember(state.serverId) { mutableStateOf(ai.obj("uses")) }
    var editing by remember(state.serverId) { mutableStateOf<AiProviders.Draft?>(null) }
    var newKind by remember { mutableStateOf("openai") }
    var doomed by remember { mutableStateOf<JsonObject?>(null) }
    suspend fun reload() { ai = model.get(listOf("servers", state.serverId, "ai")); uses = ai.obj("uses") }
    LaunchedEffect(state.serverId) { model.load { catalog = model.get(listOf("ai", "catalog")); reload() } }
    val cat = catalog ?: run { Text(tr("Loading…")); return }
    val providers = ai.rows("providers")
    fun useLabel(id: String) = tr(AiProviders.uses(cat).find { it.id == id }?.text("label") ?: id)
    fun capabilityLabel(c: String) = tr(AiProviders.uses(cat).find { it.text("capability") == c }?.text("label") ?: c)
    fun kindLabel(id: String) = tr(AiProviders.kind(cat, id)?.text("label") ?: id)

    Text(tr("Providers"), style = MaterialTheme.typography.titleMedium)
    Text(tr("Add the AI services this server uses: each is an endpoint of a known kind with this server's own keys. You can change the endpoint of any of them."), style = MaterialTheme.typography.bodySmall)
    if (providers.isEmpty()) Text(tr("No providers yet: AI runs in mock mode."))
    providers.forEach { p ->
        val kind = AiProviders.kind(cat, p.text("kind"))
        val draft = editing
        if (draft != null && draft.id == p.id && kind != null) ProviderEditor(draft, kind, p, state, model, { editing = it }, { editing = null }) { reload() }
        else Surface(tonalElevation = 2.dp, shape = MaterialTheme.shapes.medium) {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(p.name + " · " + kindLabel(p.text("kind")), style = MaterialTheme.typography.titleSmall)
                Text(p.text("api_base").ifEmpty { kind?.text("default_api_base").orEmpty().replace("{region}", p.obj("options").text("region").ifEmpty { "us-east-1" }) },
                    style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                Text(AiProviders.capabilities(kind).joinToString(" · ") { capabilityLabel(it) }, style = MaterialTheme.typography.bodySmall)
                if (!p.flag("api_key_set")) Text(tr("No key"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                val used = (p["used_by"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
                if (used.isNotEmpty()) Text(tr("Used for") + ": " + used.joinToString(", ") { useLabel(it) }, style = MaterialTheme.typography.bodySmall)
                Row {
                    TextButton(onClick = { if (kind != null) editing = AiProviders.draftOf(p, kind) }, enabled = !state.busy && editing == null) { Text(tr("Edit")) }
                    TextButton(onClick = { doomed = p }, enabled = !state.busy) { Text(tr("Delete")) }
                }
            }
        }
    }
    val adding = editing
    if (adding != null && adding.id == null) AiProviders.kind(cat, adding.kind)?.let { kind -> ProviderEditor(adding, kind, null, state, model, { editing = it }, { editing = null }) { reload() } }
    if (editing == null) {
        Choice(tr("Provider"), newKind, AiProviders.kinds(cat).map { it.id to tr(it.text("label")) }, !state.busy) { newKind = it }
        Text(tr("Can do") + ": " + AiProviders.capabilities(AiProviders.kind(cat, newKind)).joinToString(", ") { capabilityLabel(it) }, style = MaterialTheme.typography.bodySmall)
        Button(onClick = { AiProviders.kind(cat, newKind)?.let { editing = AiProviders.draftOf(null, it, tr(it.text("label"))) } }, enabled = !state.busy) { Text(tr("Add provider")) }
    }

    Text(tr("Model uses"), style = MaterialTheme.typography.titleMedium)
    Text(tr("Pick the provider and model for each use. Only providers that can do a use are offered."), style = MaterialTheme.typography.bodySmall)
    AiProviders.uses(cat).forEach { use ->
        val id = use.id
        val current = uses.obj(id).takeIf { it.isNotEmpty() } ?: buildJsonObject { put("provider", use.text("default")); put("model", ""); putJsonObject("options") {} }
        fun update(v: JsonObject) { uses = JsonObject(uses + (id to v)) }
        val fitting = AiProviders.fitting(cat, providers, use)
        val chosen = providers.find { it.id == current.text("provider") }
        Surface(tonalElevation = 1.dp, shape = MaterialTheme.shapes.medium) {
            Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(tr(use.text("label")), style = MaterialTheme.typography.titleSmall)
                Choice(tr("Provider"), current.text("provider"),
                    AiProviders.modes(use).map { it to tr(AiProviders.modeLabel(use, it)) } + fitting.map { it.id to it.name + " · " + kindLabel(it.text("kind")) }, !state.busy) { update(AiProviders.choose(current, it)) }
                if (chosen != null) {
                    OutlinedTextField(current.text("model"), { update(JsonObject(current + ("model" to JsonPrimitive(it)))) }, label = { Text(tr("Model")) }, singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                    val suggested = AiProviders.suggestions(cat, chosen.text("kind"), use.text("capability")).filter { it != current.text("model") }.take(3)
                    if (suggested.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        suggested.forEach { m -> AssistChip(onClick = { update(JsonObject(current + ("model" to JsonPrimitive(m)))) }, label = { Text(m, style = MaterialTheme.typography.labelSmall) }, enabled = !state.busy) }
                    }
                    AiProviders.optionKeys(use.text("capability"), chosen.text("kind")).forEach { key ->
                        val value = current.obj("options").text(key)
                        fun setOption(v: String) = update(JsonObject(current + ("options" to JsonObject(current.obj("options") + (key to JsonPrimitive(v))))))
                        val choices = AiProviders.optionChoices(key)
                        if (choices != null) Choice(tr(if (key == "reasoning_effort") "Thinking effort" else if (key == "size") "Image size" else "Image quality"),
                            value.ifEmpty { if (key == "reasoning_effort") "" else "auto" }, choices.map { it to optionLabel(key, it) }, !state.busy) { setOption(it) }
                        else OutlinedTextField(value, { setOption(it) }, label = { Text(tr("Default voice")) }, singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                    }
                }
            }
        }
    }
    val changed = uses != ai.obj("uses")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (changed) TextButton(onClick = { uses = ai.obj("uses") }, enabled = !state.busy) { Text(tr("Undo changes")) }
        Button(onClick = { model.launch {
            ai = model.get(listOf("servers", state.serverId, "ai", "uses"), AiProviders.usesBody(ai.obj("uses"), uses), "PUT"); uses = ai.obj("uses")
            model.refreshCatalog(); model.notice(tr("Model uses saved"))
        } }, enabled = !state.busy && changed) { Text(tr("Save model uses")) }
    }
    Text(tr("Keys are encrypted on the server and never sent back to the browser."), style = MaterialTheme.typography.bodySmall)

    doomed?.let { p -> AlertDialog(onDismissRequest = { doomed = null },
        title = { Text(tr("Delete provider “{name}”?").replace("{name}", p.name)) },
        text = { Text(tr("The uses on it go back to their defaults.")) },
        confirmButton = { TextButton(onClick = { doomed = null; model.launch {
            ai = model.get(listOf("servers", state.serverId, "ai", "providers", p.id), method = "DELETE"); uses = ai.obj("uses"); model.refreshCatalog()
        } }, enabled = !state.busy) { Text(tr("Delete")) } },
        dismissButton = { TextButton(onClick = { doomed = null }) { Text(tr("Cancel")) } }) }
}

@Composable private fun ProviderEditor(draft: AiProviders.Draft, kind: JsonObject, stored: JsonObject?, state: AppState, model: AppViewModel,
                                       change: (AiProviders.Draft) -> Unit, cancel: () -> Unit, saved: suspend () -> Unit) {
    Surface(tonalElevation = 3.dp, shape = MaterialTheme.shapes.medium) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(tr(kind.text("label")), style = MaterialTheme.typography.titleSmall)
            Text(tr(kind.text("protocol")), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(draft.name, { change(draft.copy(name = it)) }, label = { Text(tr("Name")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(draft.apiBase, { change(draft.copy(apiBase = it)) }, label = { Text(tr("Endpoint")) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                placeholder = { Text(kind.text("default_api_base").ifEmpty { tr("Provider default") }) })
            if (kind.text("api_base_hint").isNotEmpty()) Text(tr(kind.text("api_base_hint")), style = MaterialTheme.typography.bodySmall)
            kind.rows("fields").forEach { f ->
                val key = f.text("key"); val label = tr(f.text("label")) + if (f.flag("required")) " *" else ""
                if (f.text("type") != "secret") {
                    OutlinedTextField(draft.options[key].orEmpty(), { change(draft.copy(options = draft.options + (key to it))) }, label = { Text(label) }, singleLine = true,
                        placeholder = { Text(f.text("placeholder")) }, modifier = Modifier.fillMaxWidth())
                } else {
                    val main = key == "api_key"
                    val set = if (main) stored?.flag("api_key_set") == true else stored?.obj("secrets")?.obj(key)?.flag("set") == true
                    val hint = if (main) stored?.text("api_key_hint").orEmpty() else stored?.obj("secrets")?.obj(key)?.text("hint").orEmpty()
                    val value = if (main) draft.apiKey else draft.secrets[key].orEmpty()
                    OutlinedTextField(value, { change(if (main) draft.copy(apiKey = it, clearApiKey = false) else draft.copy(secrets = draft.secrets + (key to it))) },
                        label = { Text(label) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(if (set) tr("stored ({hint}) — type to replace").replace("{hint}", hint) else tr(if (f.flag("required")) "required" else "optional")) })
                    if (set && !f.flag("required")) Row {
                        Text(tr("Remove the stored key"), Modifier.weight(1f))
                        Switch(if (main) draft.clearApiKey else draft.secrets.containsKey(key) && draft.secrets[key] == null,
                            { on -> change(if (main) draft.copy(clearApiKey = on, apiKey = "") else draft.copy(secrets = if (on) draft.secrets + (key to null) else draft.secrets - key)) })
                    }
                }
            }
            if (kind.text("notes").isNotEmpty()) Text(tr(kind.text("notes")), style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = cancel, enabled = !state.busy) { Text(tr("Cancel")) }
                Button(onClick = { model.launch {
                    val body = AiProviders.body(draft)
                    if (draft.id == null) model.get(listOf("servers", state.serverId, "ai", "providers"), body)
                    else model.get(listOf("servers", state.serverId, "ai", "providers", draft.id), body, "PUT")
                    saved(); cancel(); model.notice(tr("Provider saved"))
                } }, enabled = !state.busy && AiProviders.ready(draft, kind, stored)) { Text(tr("Save provider")) }
            }
        }
    }
}
