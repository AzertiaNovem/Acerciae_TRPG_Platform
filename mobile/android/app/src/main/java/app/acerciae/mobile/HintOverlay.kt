package app.acerciae.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.acerciae.mobile.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable fun AssistanceOverlay(state: AppState, model: AppViewModel) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(tr(if (state.resultType == "inspiration") "灵感草稿" else "一致性检查"), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { model.result(null) }) { Text(tr("关闭")) }
        }
        LazyColumn(Modifier.weight(1f)) { item { SelectionContainer { Text(state.result.orEmpty()) } } }
        if (state.resultType == "inspiration") {
            TextButton(onClick = { model.draft(state.draft + (if (state.draft.isEmpty()) "" else "\n") + state.result.orEmpty()); model.result(null) }) { Text(tr("Insert into input")) }
            Text(tr("editable · not sent"), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable fun HintOverlay(state: AppState, model: AppViewModel, close: () -> Unit) {
    var selection by remember { mutableStateOf("") }
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var board by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    val reminder = state.reminders.find { selection == "r:" + it.id }
    val document = state.campaign?.documents?.find { selection == "d:" + it.id }
    val base = listOf("channels", state.channelId)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(selection, reminder?.number("version"), document?.version, retry) {
        data = null; error = ""; loading = true
        try {
            data = when {
                reminder != null -> model.get(base + listOf("reminders", reminder.id, "context"))
                document != null && state.gm -> {
                    val scene = state.windows.find { it.id == state.windowId }?.text("active_scene_id").orEmpty()
                    model.get(base + listOf("documents", document.id), query = if (scene.isEmpty()) emptyMap() else mapOf("scene_id" to scene))
                }
                else -> { if (selection.startsWith("r:") || selection.startsWith("d:")) selection = ""; null }
            }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.localizedMessage.orEmpty() }
        finally { loading = false }
    }
    LaunchedEffect(state.gm, lifecycle) {
        if (state.gm) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                try { board = model.get(base + listOf("kp", "board")) }
                catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.localizedMessage.orEmpty() }
                delay(4000)
            }
        }
    }
    Column {
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (selection.isNotEmpty()) TextButton(onClick = { selection = "" }) { Text(tr("Back")) }
            Text(tr("提示"), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = close) { Text(tr("关闭")) }
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (error.isNotEmpty()) item { Text(error, color = MaterialTheme.colorScheme.error); TextButton(onClick = { retry++ }) { Text(tr("Retry")) } }
            if (selection.isEmpty()) {
                if (state.gm) {
                    item { HintCard(tr("Next per the script"), if (board?.obj("next")?.flag("has_script") == true) board?.obj("next")?.obj("next")?.text("title").orEmpty() else tr("No module imported yet.")) { selection = "next" } }
                    item { HintCard(tr("Notes"), board?.obj("notes")?.rows("open_threads")?.firstOrNull()?.text("summary") ?: tr("Open threads, timeline and reviewed changes.")) { selection = "notes" } }
                }
                if (!state.gm && state.reminders.isEmpty()) item { Text(tr("Nothing to remind you of yet.")) }
                items(state.reminders, key = { it.id }) { r -> HintCard(r.name + " · " + tr(when(r.text("kind")) { "needed" -> "still open"; "plan" -> "plan"; "note" -> "note"; else -> "you may have forgotten" }), (r.rows("citations").firstOrNull()?.get("quotes") as? JsonArray)?.firstOrNull()?.jsonPrimitive?.content ?: r.text("why")) { selection = "r:" + r.id } }
                if (state.gm) items(state.campaign?.documents.orEmpty(), key = { it.id }) { d ->
                    val count = state.campaign?.highlights?.count { it.documentId == d.id } ?: 0
                    HintCard(tr(d.title) + " · v${d.version}" + if(count > 0) " · $count " + tr("active highlights") else "", d.preview.orEmpty()) { selection = "d:" + d.id }
                }
            } else if (selection in listOf("next", "notes")) item { KeeperHintBody(board ?: JsonObject(emptyMap()), selection) }
            else if (loading) item { CircularProgressIndicator() }
            else if (reminder != null) {
                item { Text(reminder.name, style = MaterialTheme.typography.titleMedium); Text(reminder.text("why")); if(reminder.text("llm_mode") == "mock") Text(tr("mock LLM")) }
                items(reminder.rows("script_refs")) { ref -> Text(tr("From the script") + " · " + ref.text("title")); Text(tr("Page") + " ${ref.number("page")} · " + ref.text("excerpt")) }
                if (data?.obj("reminder")?.number("version") == reminder.number("version")) items(data?.rows("events").orEmpty()) { event -> HintEvent(event, model, close) }
                item { Text(tr("The highlighted passages are quoted verbatim from the chat; the note above is the AI reminder about them."), style = MaterialTheme.typography.bodySmall) }
                item { TextButton(onClick = { model.launch { model.get(base + listOf("reminders", reminder.id, "dismiss"), JsonObject(emptyMap())); model.refresh(); selection = "" } }, enabled = !state.busy) { Text(tr("Dismiss")) } }
            } else if (document != null && state.gm) {
                item { Text(tr(document.title) + " · v${document.version}", style = MaterialTheme.typography.titleMedium) }
                if (data?.rows("entries").isNullOrEmpty()) item { Text(tr("Nothing recorded yet")) }
                items(data?.rows("entries").orEmpty()) { entry ->
                    val highlights = state.campaign?.highlights?.filter { it.targetEntryId == entry.id }.orEmpty()
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        SelectionContainer { Text(entry.text("content_md").ifEmpty { entry.text("summary") }, Modifier.background(if(highlights.isEmpty()) Color.Transparent else Color.Yellow.copy(alpha = 0.2f)).padding(6.dp)) }
                        Text(tr(entry.text("status")) + " · " + entry.text("scene_title") + " · v${entry.number("updated_version")}", style = MaterialTheme.typography.bodySmall)
                        highlights.forEach { Text(it.reason, color = Color.Yellow, style = MaterialTheme.typography.bodySmall) }
                        HintSources((entry["source_event_ids"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty(), state, model, close)
                    }
                }
            }
        }
    }
}
@Composable private fun HintCard(title: String, preview: String, click: () -> Unit) {
    Surface(onClick = click, color = Color.White.copy(alpha = 0.06f), shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { Text(title, style = MaterialTheme.typography.titleSmall); Text(preview, maxLines = 3, style = MaterialTheme.typography.bodySmall) }
    }
}
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun HintEvent(event: JsonObject, model: AppViewModel, close: () -> Unit) {
    val text = event.text("content").ifEmpty { event.obj("payload").text("content").ifEmpty { event["payload"]?.toString().orEmpty() } }
    val quoted = remember(event) { buildAnnotatedString {
        append(text)
        (event["quotes"] as? JsonArray)?.forEach { q ->
            val quote = q.jsonPrimitive.content
            if (quote.isNotEmpty()) { var start = text.indexOf(quote); while (start >= 0) { addStyle(SpanStyle(background = Color.Yellow.copy(alpha = 0.25f)), start, start + quote.length); start = text.indexOf(quote, start + quote.length) } }
        }
    } }
    Column(Modifier.fillMaxWidth().background(if(event.flag("cited")) Color.Yellow.copy(alpha = 0.08f) else Color.White.copy(alpha = 0.04f), RoundedCornerShape(10.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(event.text("character_name").ifEmpty { event.text("author_name") } + " · " + event.text("window_name") + " · " + event.text("created_at"), style = MaterialTheme.typography.labelSmall)
        SelectionContainer { Text(quoted) }
        if (event.text("message_id").isNotEmpty()) FlowRow {
            TextButton(onClick = { model.launch { model.openEvidence(event, false); close() } }) { Text(tr("jump to message ↗")) }
            TextButton(onClick = { model.launch { model.openEvidence(event, true); close() } }) { Text(tr("Quote as reference")) }
        }
    }
}
@Composable private fun HintSources(ids: List<String>, state: AppState, model: AppViewModel, close: () -> Unit) {
    if (ids.isEmpty()) return
    var expanded by remember { mutableStateOf(false) }
    var events by remember { mutableStateOf(emptyList<JsonObject>()) }
    var error by remember { mutableStateOf("") }
    TextButton(onClick = { expanded = !expanded }) { Text(tr("Source")) }
    LaunchedEffect(expanded, ids) { if (expanded) {
        try { events = model.rows(listOf("channels", state.channelId, "events"), mapOf("ids" to ids.joinToString(","))) }
        catch(e: CancellationException) { throw e } catch(e: Exception) { error = e.localizedMessage.orEmpty() }
    } }
    if (expanded) { if(error.isNotEmpty()) Text(error); events.forEach { HintEvent(it, model, close) } }
}
@Composable private fun KeeperHintBody(board: JsonObject, slot: String) {
    val next = board.obj("next"); val notes = board.obj("notes")
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if(slot == "next") {
            Text(tr("Next per the script"), style = MaterialTheme.typography.titleMedium)
            if(!next.flag("has_script")) Text(tr("No module imported yet. Import the script in the GM workspace to see what it plans next."))
            else {
                Text(next.text("summary")); Text(tr("Now") + ": " + next.obj("current").text("title"))
                Text(tr("Next") + ": " + next.obj("next").text("title"), style = MaterialTheme.typography.titleSmall)
                Text(next.obj("next").obj("data").text("location")); Text(next.obj("next").text("body"))
                listOf("keeper_actions" to "What the Keeper does there", "prerequisites" to "Needs first", "twists" to "Twists planted here").forEach { (key, title) ->
                    val values = next.obj("next").obj("data")[key] as? JsonArray
                    if (!values.isNullOrEmpty()) { Text(tr(title), style = MaterialTheme.typography.titleSmall); values.forEach { Text(it.jsonPrimitive.content) } }
                }
                Text(next.obj("next").obj("citation").text("excerpt"), style = MaterialTheme.typography.bodySmall)
                HintRows("Still unrevealed", next.rows("pending_clues")); HintRows("Foreshadowing not yet paid off", next.rows("pending_foreshadowing"))
                Text("${next.number("stages_done")}/${next.number("stages_total")} " + tr("stages done"))
            }
        } else {
            Text(tr("Keeper's notes"), style = MaterialTheme.typography.titleMedium)
            HintRows("Open threads", notes.rows("open_threads")); HintRows("Timeline", notes.rows("timeline")); HintRows("Script stages played", notes.rows("stages_done")); HintRows("Latest reviewed changes", notes.rows("recent_changes"))
        }
    }
}
@Composable private fun HintRows(title: String, rows: List<JsonObject>) {
    Text(tr(title), style = MaterialTheme.typography.titleSmall)
    if(rows.isEmpty()) Text(tr("None recorded."))
    rows.forEach { row -> Text(listOf(row.text("summary").ifEmpty { row.text("title") }, row.text("location"), row.text("narrative_time"), tr(row.text("status")), tr(row.text("verdict")), row.text("op"), row.text("reviewer_reason")).filter { it.isNotEmpty() }.joinToString(" · ")) }
}
