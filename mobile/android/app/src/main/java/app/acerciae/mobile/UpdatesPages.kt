package app.acerciae.mobile

import androidx.compose.foundation.layout.*
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.acerciae.mobile.core.*
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*

@Composable fun ReminderPanel(state: AppState, model: AppViewModel, documents: Boolean) {
    var context by remember { mutableStateOf<JsonObject?>(null) }
    var board by remember { mutableStateOf<JsonObject?>(null) }
    var entries by remember { mutableStateOf(emptyList<JsonObject>()) }
    val base = listOf("channels", state.channelId)
    LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text(if (documents) "考据与出处" else tr("当前提醒"), style = MaterialTheme.typography.titleLarge) }
        if (state.gm) item { TextButton(onClick = { model.launch { board = model.get(base + listOf("kp", "board")); entries = model.rows(base + "script-knowledge") } }) { Text(tr("KP 看板 · 剧本下一步与笔记")) } }
        board?.let { b ->
            item { Text(b.obj("next").text("summary")); Text(b.obj("next").obj("next").text("title")); Text(b.obj("next").obj("next").text("body")) }
            items(b.obj("notes").rows("open_threads")) { Text(it.text("summary")) }
            items(entries) { entry ->
                Column {
                    Text(entry.name, style = MaterialTheme.typography.titleMedium); Text(entry.text("body"))
                    entry.rows("citations").forEach { Text(tr("Page") + " ${it.number("page")} · ${it.text("excerpt")}", style = MaterialTheme.typography.bodySmall) }
                    var expanded by remember { mutableStateOf(false) }
                    TextButton(onClick = { expanded = true }) { Text(tr("Status") + ": ${entry.text("status")}") }
                    DropdownMenu(expanded, { expanded = false }) {
                        listOf("pending", "active", "done", "skipped").forEach { status -> DropdownMenuItem(text = { Text(status) }, onClick = { expanded = false; model.launch { model.get(base + listOf("script-knowledge", entry.id), payload("status" to status), "PUT"); entries = model.rows(base + "script-knowledge"); board = model.get(base + listOf("kp", "board")) } }) }
                    }
                }
            }
        }
        if (state.reminders.isEmpty()) item { Text(tr("暂时没有需要提醒的内容")) }
        items(state.reminders, key = { it.id }) { reminder ->
            Column {
                Text(reminder.name, style = MaterialTheme.typography.titleMedium); Text(reminder.text("why"))
                TextButton(onClick = { model.launch { context = null; context = model.get(base + listOf("reminders", reminder.id, "context")) } }, enabled = !state.busy) { Text(tr("查看聊天出处")) }
                TextButton(onClick = { model.launch { model.get(base + listOf("reminders", reminder.id, "dismiss"), JsonObject(emptyMap())); context = null; model.refresh() } }, enabled = !state.busy) { Text(tr("收起提醒")) }
            }
        }
        context?.let { value -> items(value.rows("events")) { event ->
            Surface(color = if (event.flag("cited")) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface) {
                Column(Modifier.padding(12.dp)) {
                    Text(event.text("character_name").ifEmpty { event.text("author_name") }, style = MaterialTheme.typography.labelMedium)
                    Text(event.text("content"))
                    (event["quotes"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content, color = MaterialTheme.colorScheme.primary) }
                }
            }
        } }
        if (state.gm && documents) items(state.campaign?.documents.orEmpty()) { doc ->
            Column { Text(doc.title); Text(doc.preview.orEmpty()); TextButton(onClick = { model.launch { model.notice(model.get(base + listOf("documents", doc.id)).text("markdown")) } }) { Text(tr("阅读全文")) } }
        }
    }
}

@Composable fun ScenarioControls(state: AppState, model: AppViewModel) {
    var title by remember { mutableStateOf("") }; var location by remember { mutableStateOf("") }; var time by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }
    fun save(advance: Boolean) { model.launch {
        model.get(listOf("channels", state.channelId) + if (advance) listOf("scenarios", "advance") else listOf("scenes"), payload("title" to title, "location" to location, "narrative_time" to time))
        model.refresh(); title = ""; location = ""; time = ""
    } }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(tr("下一阶段"), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(title, { title = it }, label = { Text(tr("标题")) })
        OutlinedTextField(location, { location = it }, label = { Text(tr("地点")) })
        OutlinedTextField(time, { time = it }, label = { Text(tr("故事时间")) })
        Text(tr("开启后，所有聊天窗口一起进入新阶段，上一阶段关闭并生成摘要。"), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { save(false) }, enabled = title.isNotBlank() && !state.busy) { Text(tr("准备阶段，稍后进入")) }
        Button(onClick = { confirm = true }, enabled = !state.busy) { Text(tr("立即开启下一阶段")) }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text(tr("所有聊天窗口将进入下一阶段")) }, text = { Text((state.scenes.firstOrNull { it.id == state.channel.text("current_scene_id") }?.name.orEmpty()) + " → " + title.ifEmpty { tr("下一阶段") } + "\n" + location + " · " + time + "\n" + tr("This cannot be undone.")) }, confirmButton = { TextButton(onClick = { confirm = false; save(true) }) { Text(tr("开启下一阶段")) } }, dismissButton = { TextButton(onClick = { confirm = false }) { Text(tr("取消")) } })
}

@Composable fun NovelCreator(state: AppState, model: AppViewModel, close: () -> Unit) {
    var status by remember { mutableStateOf<JsonObject?>(null) }; var jobs by remember { mutableStateOf(emptyList<JsonObject>()) }
    var title by remember { mutableStateOf("") }; var direction by remember { mutableStateOf("") }
    var character by remember { mutableStateOf(state.playable.firstOrNull()?.id.orEmpty()) }
    var scope by remember { mutableStateOf(if (state.gm) "gm_full" else if (character.isNotEmpty()) "character" else "pl_public") }
    var template by remember { mutableStateOf("adv") }; var cloud by remember { mutableStateOf(false) }; var art by remember { mutableStateOf(false) }
    val base = listOf("channels", state.channelId, "studio", "vn-scripts")
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(state.channelId) { model.run { status = model.get(base + "status"); jobs = model.rows(base) } }
    LaunchedEffect(state.channelId, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        while (true) { delay(4000); if (jobs.any { it.text("status") in listOf("pending", "running") }) model.run { jobs = model.rows(base) } }
    } }
    LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton(onClick = close) { Text("返回故事回放") }; Text(tr("制作视觉小说"), style = MaterialTheme.typography.titleLarge) }
        item { OutlinedTextField(title, { title = it }, label = { Text(tr("作品标题")) }) }
        item { ChoiceMenu(tr("可见范围"), scope, buildList { if (state.gm) add("gm_full" to tr("GM 完整视角")); add("pl_public" to tr("公共内容")); if (state.playable.isNotEmpty()) add("character" to tr("角色视角")) }) { scope = it } }
        if (scope == "character") item { ChoiceMenu(tr("角色"), character, state.playable.map { it.id to it.name }) { character = it } }
        item { ChoiceMenu(tr("模板"), template, listOf("adv" to tr("经典对话"), "nvl" to tr("小说页面"), "dossier" to tr("调查档案"), "cinematic" to tr("电影字幕"))) { template = it } }
        item { OutlinedTextField(direction, { direction = it }, label = { Text(tr("改编方向（可选）")) }) }
        item { Text(if (status?.flag("mock") == true) tr("当前使用示例生成服务") else status?.text("note").orEmpty()) }
        if (status?.flag("mock") != true) item { Row { Checkbox(cloud, { cloud = it }, enabled = status?.flag("cloud_allowed") == true); Text(tr("同意将选定日志发送至配置的云端服务")) } }
        item { Row { Checkbox(art, { art = it }, enabled = status?.flag("images") == true); Text(tr("同时生成缺失的背景与立绘")) } }
        item { Button(onClick = { model.launch {
            model.get(base, buildJsonObject {
                put("scope", scope); if (scope == "character") put("scope_character_id", character)
                if (title.isNotBlank()) put("title", title); put("instructions", direction)
                put("template", buildJsonObject { put("base", template) }); put("allow_cloud", cloud); put("generate_art", art)
            }); jobs = model.rows(base)
        } }, enabled = !state.busy && status != null && (status?.flag("mock") == true || (cloud && status?.flag("cloud_allowed") == true)) && (scope != "character" || character.isNotEmpty())) { Text(tr("生成视觉小说")) } }
        items(jobs, key = { it.id }) { job -> Column {
            Text(job.name.ifEmpty { tr("视觉小说") }, style = MaterialTheme.typography.titleMedium)
            Text("${job.text("status")} · ${job.obj("progress").number("chunks_done")} / ${job.obj("progress").number("chunks_total")}")
            if (job.text("error").isNotEmpty()) Text(job.text("error"), color = MaterialTheme.colorScheme.error)
            if (job.text("status") in listOf("pending", "running")) TextButton(onClick = { model.launch { model.get(base + listOf(job.id, "cancel"), JsonObject(emptyMap())); jobs = model.rows(base) } }, enabled = !state.busy) { Text(tr("取消生成")) }
            if (job.text("presentation_id").isNotEmpty()) Text(tr("已完成，可返回故事回放查看并下载独立播放包"))
        } }
    }
}
@Composable fun ChoiceMenu(label: String, value: String, choices: List<Pair<String, String>>, select: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }) { Text("$label：${choices.find { it.first == value }?.second.orEmpty()}") }
        DropdownMenu(expanded, { expanded = false }) { choices.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { expanded = false; select(id) }) } }
    }
}

@Composable fun CharacterSpace(character: JsonObject, state: AppState, model: AppViewModel, close: () -> Unit) {
    var pointRules by remember { mutableStateOf<JsonObject?>(null) }; var rulesError by remember { mutableStateOf("") }
    var space by remember { mutableStateOf(JsonObject(emptyMap())) }; var card by remember { mutableStateOf(JsonObject(emptyMap())) }
    var name by remember { mutableStateOf("") }; var bio by remember { mutableStateOf("") }; var speakingStyle by remember { mutableStateOf("") }; var prompt by remember { mutableStateOf("") }; var mode by remember { mutableStateOf("uploaded") }; var cloud by remember { mutableStateOf(false) }
    val base = listOf("channels", state.channelId, "characters", character.id)
    fun apply(v: JsonObject) { space = v; card = v.obj("character").obj("role_card"); name = v.obj("character").text("name"); bio = v.obj("character").text("bio"); speakingStyle = v.obj("character").text("speaking_style"); prompt = v.obj("character").text("appearance_prompt"); mode = v.obj("character").text("asset_mode") }
    var slot by remember { mutableStateOf("portrait") }; var subtitle by remember { mutableStateOf("IDLE") }
    val context = LocalContext.current
    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) model.launch {
            val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use { stream ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val count = stream.read(buffer); if (count < 0) break; require(output.size() + count <= 10 * 1024 * 1024) { tr("请选择小于 10 MB 的图片") }; output.write(buffer, 0, count) }; output.toByteArray()
            } ?: error(tr("无法读取图片")) }
            space = model.uploadArtwork(bytes, character.id, slot, subtitle)
        }
    }
    val editable = space.obj("character").flag("editable") && !state.busy
    val pointsOn = space.obj("points").flag("enabled")
    val pointsValid = !pointsOn || (pointRules != null && PointBuy(card, pointRules!!).issues.isEmpty())
    LaunchedEffect(character.id) { try { apply(model.get(base + "space")) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { model.notice(tr("角色资料加载失败，请重新打开角色卡")) } }
    LaunchedEffect(pointsOn) { if (pointsOn) { try { pointRules = model.get(listOf("coc7", "rules")); rulesError = "" } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { rulesError = tr("职业规则暂不可用，请重试；草稿保留") } } }
    val groups = listOf(
        Triple("basic", tr("基本信息"), listOf("player", "occupation", "age", "sex", "residence", "birthplace")),
        Triple("characteristics", tr("CoC7 属性"), listOf("STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUK")),
        Triple("derived", tr("状态"), listOf("hp", "hp_max", "mp", "mp_max", "san", "san_max", "mov", "build", "db")),
        Triple("background", tr("人物背景"), listOf("personal_description", "ideology", "significant_people", "meaningful_locations", "treasured_possessions", "traits", "injuries", "phobias", "arcane", "encounters")),
        Triple("wealth", tr("财产"), listOf("cash", "assets", "spending_level")), Triple("skills", tr("技能"), card.obj("skills").keys.sorted()))
    Column {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        TextButton(onClick = close) { Text(tr("返回角色")) }
        if (space.obj("character").flag("editable")) TextButton(onClick = { model.launch {
            apply(model.get(base + "card", buildJsonObject { put("name", name); put("bio", bio); put("speaking_style", speakingStyle); put("role_card", card) }, "PUT")); model.refresh(); model.notice(tr("角色卡已保存"))
        } }, enabled = editable && pointsValid && name.isNotBlank()) { Text(tr("保存")) }
    }
    LazyColumn(Modifier.weight(1f).padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text(tr("角色空间"), style = MaterialTheme.typography.titleLarge) }
        item { OutlinedTextField(name, { name = it }, label = { Text(tr("姓名")) }, enabled = editable); OutlinedTextField(bio, { bio = it }, label = { Text(tr("简介")) }, enabled = editable); OutlinedTextField(speakingStyle, { speakingStyle = it }, label = { Text(tr("说话风格")) }, enabled = editable) }
        items(groups.filter { !pointsOn || it.first != "skills" }) { (group, label, fields) ->
            var expanded by remember { mutableStateOf(false) }
            Column {
                TextButton(onClick = { expanded = !expanded }) { Text(label) }
                if (expanded) fields.forEach { field ->
                    val numeric = group in listOf("characteristics", "skills") || (group == "derived" && field != "db")
                    OutlinedTextField((card.obj(group)[field] as? JsonPrimitive)?.content.orEmpty(), { value ->
                        val section = card.obj(group).toMutableMap()
                        if (!numeric) section[field] = JsonPrimitive(value)
                        else if (value.isEmpty()) section.remove(field)
                        else value.toIntOrNull()?.takeIf { it in -99..999 }?.let { section[field] = JsonPrimitive(it) }
                        card = JsonObject(card + (group to JsonObject(section)))
                    }, label = { Text(fieldLabel(field)) }, enabled = editable)
                }
            }
        }
        if (pointsOn) item {
            pointRules?.let { PointBuyEditor(card, it, editable, state.gm, space.obj("points").text("language").ifEmpty { state.serverSettings.text("language") }) { updated -> card = updated } } ?: Column {
                Text(rulesError.ifEmpty { tr("正在读取职业和技能规则…") })
                TextButton(onClick = { model.launch { pointRules = model.get(listOf("coc7", "rules")); rulesError = "" } }) { Text(tr("重新加载规则")) }
            }
        }
        items(card.rows("items")) { Text("${it.name} × ${it.number("qty")}\n${it.text("note")}") }

        item { Text(tr("Appearance & images") + " · ${space.text("era")} · ${space.text("narrative_time")}", style = MaterialTheme.typography.titleMedium) }
        items(listOf("avatar", "portrait")) { slot -> val asset = space.obj(slot); if (asset.id.isNotEmpty()) AuthenticatedArtwork(model, state.channelId, asset.id, asset.number("version"), Modifier.fillMaxWidth().height(if (slot == "avatar") 80.dp else 220.dp)) }
        items(space.rows("subtitles")) { asset -> Text(asset.text("subtitle")); AuthenticatedArtwork(model, state.channelId, asset.id, asset.number("version"), Modifier.fillMaxWidth().height(180.dp)) }
        if (space.obj("character").flag("editable")) {
            item { ChoiceMenu(tr("素材来源"), mode, listOf("uploaded" to tr("上传素材"), "generated" to tr("生成素材"))) { mode = it } }
            item { OutlinedTextField(prompt, { prompt = it }, label = { Text(tr("外观与统一画风描述")) }, enabled = editable) }
            item { TextButton(onClick = { model.launch { space = model.get(base + "appearance", payload("asset_mode" to mode, "appearance_prompt" to prompt), "PUT") } }, enabled = editable) { Text(tr("保存外观设置")) } }
            if (mode == "uploaded") {
                item { ChoiceMenu(tr("上传到"), slot, listOf("avatar" to tr("头像"), "portrait" to tr("主立绘"), "subtitle" to tr("表情立绘"))) { slot = it } }
                if (slot == "subtitle") item { OutlinedTextField(subtitle, { subtitle = it }, label = { Text(tr("表情名称，如 IDLE")) }) }
                item { Button(onClick = { upload.launch(arrayOf("image/png", "image/jpeg")) }, enabled = editable && (slot != "subtitle" || subtitle.isNotBlank())) { Text(tr("选择图片并上传")) } }
            }
            if (mode == "generated") {
                item { Row { Checkbox(cloud, { cloud = it }); Text(tr("允许本次生成使用云端服务")) } }
                item { Button(onClick = { model.launch {
                    model.get(base + "appearance", payload("asset_mode" to mode, "appearance_prompt" to prompt), "PUT")
                    model.get(base + listOf("assets", "generate"), buildJsonObject { put("slots", JsonArray(listOf(JsonPrimitive("portrait"), JsonPrimitive("avatar")))); put("allow_cloud", cloud) }); space = model.get(base + "space")
                } }, enabled = editable && space.flag("generation_available") && prompt.isNotBlank()) { Text(tr("生成头像与主立绘")) } }
            }
        }
        items(space.rows("jobs")) { Text("${it.text("kind")} · ${it.text("status")}\n${it.text("error")}") }
        item { TextButton(onClick = { model.launch { space = model.get(base + "space") } }, enabled = !state.busy) { Text(tr("刷新素材")) } }
    }
}
}
private fun fieldLabel(key: String) = mapOf("player" to tr("Player"), "occupation" to tr("职业"), "age" to tr("年龄"), "sex" to tr("性别"), "residence" to tr("现居地"), "birthplace" to tr("出生地"), "personal_description" to tr("外貌描述"), "ideology" to tr("思想信念"), "significant_people" to tr("重要之人"), "meaningful_locations" to tr("重要之地"), "treasured_possessions" to tr("宝贵之物"), "traits" to tr("特质"), "injuries" to tr("伤病"), "phobias" to tr("恐惧与狂躁"), "arcane" to tr("神秘知识"), "encounters" to tr("离奇遭遇"), "cash" to tr("现金"), "assets" to tr("资产"), "spending_level" to tr("消费水平"))[key] ?: key.uppercase()

@Composable fun DubbingPanel(id: String, state: AppState, model: AppViewModel, close: () -> Unit) {
    var presentation by remember { mutableStateOf(JsonObject(emptyMap())) }; var voices by remember { mutableStateOf(emptyList<JsonObject>()) }; var presets by remember { mutableStateOf(emptyList<JsonObject>()) }
    var cast by remember { mutableStateOf(JsonObject(emptyMap())) }; var estimate by remember { mutableStateOf<JsonObject?>(null) }; var job by remember { mutableStateOf<JsonObject?>(null) }
    val base = listOf("channels", state.channelId, "studio")
    val speakers = buildMap { put("narrator", tr("旁白")); presentation.rows("events").filter { !it.flag("hidden") && it.text("speaker_character_id").isNotEmpty() }.forEach { put(it.text("speaker_character_id"), it.text("speaker_display_name")) } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(id) { model.run {
        presentation = model.get(base + listOf("presentations", id)); cast = presentation.obj("settings").obj("cast")
        voices = model.rows(base + "voices"); presets = model.rows(base + listOf("tts", "available-voices"))
    } }
    LaunchedEffect(id, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        while (true) { delay(3000); job?.let { current -> if (current.text("status") in listOf("pending", "running")) model.run { job = model.get(base + listOf("tts", "jobs", current.id)) } } }
    } }
    LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton(onClick = close) { Text("返回故事回放") }; Text(tr("配音选角"), style = MaterialTheme.typography.titleLarge) }
        items(speakers.keys.sorted()) { speaker ->
            ChoiceMenu(speakers[speaker].orEmpty(), cast.text(speaker), listOf("" to tr("不配音")) + voices.filter { it.text("character_id").isEmpty() || it.text("character_id") == speaker }.map { it.id to it.name }) { cast = JsonObject(cast + (speaker to JsonPrimitive(it))); estimate = null }
        }
        item { ChoiceMenu(tr("添加预设音色"), "", presets.map { it.id to it.name }) { preset -> model.launch {
            model.get(base + "voices", payload("name" to presets.first { it.id == preset }.name, "voice_type" to "preset", "voice_id" to preset)); voices = model.rows(base + "voices")
        } } }
        item { Button(onClick = { model.launch {
            presentation = model.get(base + listOf("presentations", id, "cast"), buildJsonObject { put("cast", cast) })
            estimate = model.get(base + listOf("presentations", id, "tts", "estimate"), JsonObject(emptyMap()))
        } }, enabled = !state.busy) { Text(tr("保存选角并估算配音")) } }
        estimate?.let { value -> item {
            Text(tr("Characters (count)") + " ${value.number("chars")} · " + tr("Lines") + " ${value.number("lines_to_synthesize")}")
            Text(if (value.flag("mock")) tr("示例服务，无真实配音费用") else tr("将使用服务器配置的配音服务，可能产生费用；实际金额由服务商结算。"))
            if (!value.flag("within_budget")) Text(tr("超过战役字符预算"))
            Button(onClick = { model.launch { job = model.get(base + listOf("presentations", id, "tts", "jobs"), JsonObject(emptyMap())); estimate = null } }, enabled = !state.busy && value.flag("within_budget") && value.number("lines_to_synthesize") > 0) { Text(tr("确认生成配音")) }
        } }
        job?.let { current -> item { Text(tr("Job") + " · ${current.text("status")}\n${current.text("error")}") } }
    }
}
