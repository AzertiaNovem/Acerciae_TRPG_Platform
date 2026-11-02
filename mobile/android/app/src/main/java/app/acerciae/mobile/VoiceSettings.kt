package app.acerciae.mobile
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.*
import kotlin.math.roundToInt

@Composable fun VoiceSettings(state: AppState, model: AppViewModel, close: () -> Unit) {
    var status by remember { mutableStateOf<JsonObject?>(null) }
    var profiles by remember { mutableStateOf(emptyList<JsonObject>()) }
    var presets by remember { mutableStateOf(emptyList<JsonObject>()) }
    var selected by remember { mutableStateOf("") }
    var fields by remember { mutableStateOf(JsonObject(emptyMap())) }
    val base = listOf("channels", state.channelId, "studio")
    val features = status?.obj("features") ?: JsonObject(emptyMap())
    val editable = status != null && !state.busy && (selected.isEmpty() || profiles.find { it.id == selected }?.get("editable") != JsonPrimitive(false))
    fun set(key: String, value: String) { fields = JsonObject(fields + (key to JsonPrimitive(value))) }
    fun reset() {
        val v = profiles.find { it.id == selected } ?: JsonObject(emptyMap())
        fields = buildJsonObject {
            put("name", v.name); put("voice_id", v.text("voice_id").ifEmpty { presets.firstOrNull()?.id.orEmpty() })
            put("model_id", v.text("model_id").ifEmpty { status?.text("official_model").orEmpty() })
            put("language", v.text("language").ifEmpty { features.rows("languages").firstOrNull()?.id ?: "auto" })
            if (features["dialect"] is JsonObject) put("dialect", v.text("dialect"))
            if (features.flag("instructions")) put("style_instruction", v.text("style_instruction"))
            put("synthesis_parameters", buildJsonObject { features.rows("params").forEach { p -> put(p.text("key"), v.obj("synthesis_parameters")[p.text("key")] ?: p["default"] ?: JsonPrimitive(0)) } })
        }
    }
    LaunchedEffect(state.channelId) { model.run { status = model.get(base + listOf("tts", "status")); profiles = model.rows(base + "voices"); presets = model.rows(base + listOf("tts", "available-voices")); reset() } }
    Column {
        TextButton(onClick = close) { Text(tr("Back")) }
        LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text(tr("Voice settings"), style = MaterialTheme.typography.titleLarge); Text(features.text("label")); Text(status?.text("official_model").orEmpty()) }
            if (status?.flag("mock") == true) item { Text(tr("示例服务，无真实配音费用")) }
            item { ChoiceMenu(tr("Voice"), selected, listOf("" to tr("添加预设音色")) + profiles.filter { it.text("provider") == status?.text("provider") }.map { it.id to it.name }) { selected = it; reset() } }
            item { OutlinedTextField(fields.text("name"), { set("name", it) }, label = { Text(tr("Name")) }, enabled = editable) }
            item { ChoiceMenu(tr("Voice"), fields.text("voice_id"), presets.map { it.id to it.name } + if (presets.none { it.id == fields.text("voice_id") }) listOf(fields.text("voice_id") to fields.text("voice_id")) else emptyList()) { if(editable) set("voice_id", it) } }
            val models = (features["models"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty()
            if(models.isNotEmpty()) item { ChoiceMenu(tr("Model"), fields.text("model_id"), models.map { it to it }) { if(editable) set("model_id", it) } }
            if(features.rows("languages").isNotEmpty()) item {
                ChoiceMenu(tr("Language"), fields.text("language"), features.rows("languages").map { it.id to tr(it.text("label")) }) { if(editable) set("language", it) }
                Text(tr(features.text("language_note")), style = MaterialTheme.typography.bodySmall)
            }
            if(features["dialect"] is JsonObject) item { OutlinedTextField(fields.text("dialect"), { set("dialect", it) }, label = { Text(tr(features.obj("dialect").text("label"))) }, enabled = editable) }
            if(features.flag("instructions")) item { OutlinedTextField(fields.text("style_instruction"), { set("style_instruction", it) }, label = { Text(tr("identity instruction")) }, enabled = editable); Text(tr(features.text("instruction_note")), style = MaterialTheme.typography.bodySmall) }
            features.rows("params").forEach { p -> item {
                val min = p["min"]?.jsonPrimitive?.floatOrNull ?: 0f; val max = p["max"]?.jsonPrimitive?.floatOrNull ?: 1f
                val value = fields.obj("synthesis_parameters")[p.text("key")]?.jsonPrimitive?.floatOrNull ?: 0f
                Text(tr(p.text("label")) + " · %.2f".format(value))
                if(max > min) Slider(value.coerceIn(min,max), { n -> fields = JsonObject(fields + ("synthesis_parameters" to JsonObject(fields.obj("synthesis_parameters") + (p.text("key") to JsonPrimitive(n))))) }, valueRange = min..max, steps = (((max - min) / (p["step"]?.jsonPrimitive?.floatOrNull ?: 0.05f).coerceAtLeast(0.01f)).roundToInt() - 1).coerceAtLeast(0), enabled = editable)
            } }
            item { Button(onClick = { model.launch {
                val body = if(selected.isEmpty()) JsonObject(fields + ("voice_type" to JsonPrimitive("preset"))) else fields
                val v = model.get(base + "voices" + if(selected.isEmpty()) emptyList() else listOf(selected), body, if(selected.isEmpty()) "POST" else "PUT")
                profiles = model.rows(base + "voices"); selected = v.id; reset(); model.notice(tr("Saved"))
            } }, enabled = editable && fields.text("name").isNotBlank() && fields.text("voice_id").isNotBlank()) { Text(tr("Save")) } }
        }
    }
}
