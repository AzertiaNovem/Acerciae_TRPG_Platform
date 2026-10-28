package app.acerciae.mobile

import android.media.MediaPlayer
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
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
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File

@Composable fun CharacterPanel(character: JsonObject, state: AppState, model: AppViewModel) {
    var showSpace by remember(character.id) { mutableStateOf(false) }
    if (showSpace) { CharacterSpace(character, state, model) { showSpace = false }; return }
    var space by remember(character.id) { mutableStateOf(JsonObject(emptyMap())) }
    var loading by remember(character.id) { mutableStateOf(true) }
    var image by remember(character.id) { mutableStateOf<JsonObject?>(null) }
    var attrs by remember(character.id) { mutableStateOf(JsonObject(emptyMap())) }
    var attribute by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    val path = listOf("channels", state.channelId, "characters", character.id, "attributes")
    LaunchedEffect(character.id) { model.run { space = model.get(path.dropLast(1) + "space"); attrs = model.get(path) }; loading = false }
    image?.let { asset -> androidx.compose.ui.window.Dialog(onDismissRequest = { image = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) { Column(Modifier.safeDrawingPadding()) {
            TextButton(onClick = { image = null }) { Text(tr("返回角色")) }
            AuthenticatedArtwork(model, state.channelId, asset.id, asset.number("version"), Modifier.fillMaxWidth().weight(1f))
        } }
    } }
    LazyColumn(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            val portrait = space.obj("portrait")
            if (portrait.id.isNotEmpty()) TextButton(onClick = { image = portrait }, modifier = Modifier.fillMaxWidth()) { AuthenticatedArtwork(model, state.channelId, portrait.id, portrait.number("version"), Modifier.fillMaxWidth().height(360.dp)) }
            else if (loading) CircularProgressIndicator() else Text(tr("尚无立绘"), Modifier.padding(32.dp))
        }
        item { Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            val avatar = space.obj("avatar")
            if (avatar.id.isNotEmpty()) TextButton(onClick = { image = avatar }) { AuthenticatedArtwork(model, state.channelId, avatar.id, avatar.number("version"), Modifier.size(72.dp)) }
            Column { Text(space.obj("character").text("name").ifEmpty { character.name }, style = MaterialTheme.typography.titleLarge)
                Text(character.text("kind").uppercase() + " · " + character.text("player_name")); Text(space.text("era")) }
        } }
        if (space.obj("character").text("bio").isNotEmpty()) item { Text(space.obj("character").text("bio")) }
        if (space.obj("character").text("speaking_style").isNotEmpty()) item { Text(space.obj("character").text("speaking_style")) }
        item { Button(onClick = { showSpace = true }) { Text(tr("角色卡与外观空间")) } }
        if (space.rows("subtitles").isNotEmpty()) item { Text(tr("表情立绘"), style = MaterialTheme.typography.titleMedium) }
        items(space.rows("subtitles"), key = { it.id + it.text("subtitle") }) { asset ->
            Text(asset.text("subtitle"))
            TextButton(onClick = { image = asset }, modifier = Modifier.fillMaxWidth()) { AuthenticatedArtwork(model, state.channelId, asset.id, asset.number("version"), Modifier.fillMaxWidth().height(260.dp)) }
        }
        items(attrs.obj("attrs").keys.sorted()) { key -> Text("$key  ${attrs.obj("attrs")[key]}") }
        if (attrs.flag("editable") && !state.enabled("coc7_points")) {
            item { OutlinedTextField(attribute, { attribute = it }, label = { Text(tr("属性或技能名")) }) }
            item { OutlinedTextField(value, { value = it }, label = { Text(tr("数值")) }) }
            item { Button(onClick = { model.launch {
                model.get(path, buildJsonObject { put("set", buildJsonObject { put(attribute, value.toDouble()) }) }, "PUT")
                attrs = model.get(path)
            } }, enabled = attribute.isNotBlank() && value.toDoubleOrNull() != null && !state.busy) { Text(tr("保存属性")) } }
        }
    }
}

@Composable fun ScenePanel(scene: JsonObject, state: AppState, model: AppViewModel) {
    var summary by remember(scene.id) { mutableStateOf(scene.text("summary")) }
    var confirm by remember { mutableStateOf(false) }
    val current = state.scenes.find { it.id == scene.id } ?: scene
    LazyColumn(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text(current.name, style = MaterialTheme.typography.titleLarge); Text(current.text("location")); Text(current.text("narrative_time")) }
        item { Text(if (state.channel.text("current_scene_id") == scene.id) tr("当前阶段 · 全战役") else if (current.text("status") == "closed") tr("已结束 · 仅供回顾") else tr("已准备，尚未进入")) }
        if (state.gm) {
            item { OutlinedTextField(summary, { summary = it }, label = { Text(tr("阶段摘要")) }) }
            item { TextButton(onClick = { model.launch { model.get(listOf("channels", state.channelId, "scenes", scene.id), payload("summary" to summary), "PUT"); model.refresh() } }, enabled = !state.busy) { Text(tr("保存摘要")) } }
            if (current.text("status") == "active" && state.channel.text("current_scene_id") != scene.id) item { Button(onClick = { confirm = true }, enabled = !state.busy) { Text(tr("全战役进入此阶段")) } }
        } else item { Text(current.text("summary").ifEmpty { tr("暂无阶段摘要") }) }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text(tr("进入后，所有聊天窗口一起切换，当前阶段将关闭")) }, text = { Text(scene.name + "\n" + scene.text("location") + " · " + scene.text("narrative_time") + "\n" + tr("This cannot be undone.")) }, confirmButton = { TextButton(onClick = { confirm = false; model.launch { model.get(listOf("channels", state.channelId, "scenarios", "enter"), payload("scene_id" to scene.id)); model.refresh() } }) { Text(tr("进入此阶段")) } }, dismissButton = { TextButton(onClick = { confirm = false }) { Text(tr("取消")) } })
}

@Composable fun LiveServerPage(state: AppState, model: AppViewModel) {
    var area by remember { mutableStateOf("") }
    if (area.isNotEmpty()) { ServerManagementPage(state, model, area) { area = "" }; return }
    val maintainer = state.serverSettings.flag("is_maintainer")
    if (!state.online || !maintainer) { Text(tr("仅服务器管理员可访问"), Modifier.padding(20.dp)); return }
    var points by remember(state.serverId) { mutableStateOf(state.enabled("coc7_points")) }
    var studio by remember(state.serverId) { mutableStateOf(state.enabled("log_studio")) }
    var dice by remember(state.serverId) { mutableStateOf(state.enabled("dice")) }
    var consistency by remember(state.serverId) { mutableStateOf(state.enabled("consistency")) }
    var inspiration by remember(state.serverId) { mutableStateOf(state.enabled("inspiration")) }
    var language by remember(state.serverId) { mutableStateOf(InterfaceLanguage.supported(state.serverSettings.text("language"))) }
    LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text(state.serverName, style = MaterialTheme.typography.titleLarge) }
        items(listOf("Access", "AI", "Channels")) { item -> TextButton(onClick = { area = item }) { Text(tr(item)) } }
        item { Text(if (maintainer) tr("服务器管理员") else tr("服务器成员")) }
        if (state.serverSettings.obj("features").containsKey("coc7_points")) item { SettingToggle(tr("CoC7 购点规则"), points, maintainer && !state.busy) { points = it } }
        item { SettingToggle(tr("日志制作"), studio, maintainer && !state.busy) { studio = it } }
        item { SettingToggle(tr("骰子"), dice, maintainer && !state.busy) { dice = it } }
        item { SettingToggle(tr("一致性检查"), consistency, maintainer && !state.busy) { consistency = it } }
        item { SettingToggle(tr("灵感草稿"), inspiration, maintainer && !state.busy) { inspiration = it } }
        if (maintainer) {
            item { Choice(tr("Language"), language, InterfaceLanguage.codes.zip(InterfaceLanguage.names), !state.busy) { language = it } }
            item { Button(onClick = { model.launch {
                model.get(listOf("servers", state.serverId, "settings"), buildJsonObject { put("language", language); put("features", buildJsonObject { state.serverSettings.obj("features").forEach { (k,v) -> put(k,v) }; if (state.serverSettings.obj("features").containsKey("coc7_points")) put("coc7_points", points); put("log_studio", studio); put("dice", dice); put("consistency", consistency); put("inspiration", inspiration) }) }, "PUT")
                model.refreshCatalog(); model.notice(tr("服务器设置已保存"))
            } }, enabled = !state.busy) { Text(tr("保存服务器设置")) } }
        }
    }
}

@Composable fun LiveChannelPage(state: AppState, model: AppViewModel) {
    if (!state.online || !state.gm) { Text(tr("仅当前频道的 GM 可访问"), Modifier.padding(20.dp)); return }
    var playerAccess by remember(state.channelId) { mutableStateOf(state.channel.flag("studio_player_access")) }
    var visible by remember(state.channelId) { mutableStateOf(state.channel.flag("studio_visible")) }
    var autoScenarios by remember(state.channelId) { mutableStateOf(state.channel.flag("auto_scenarios")) }
    var ai by remember(state.channelId) { mutableStateOf(state.channel.flag("ai_enabled")) }
    var cloud by remember(state.channelId) { mutableStateOf(false) }
    var budget by remember(state.channelId) { mutableStateOf("0") }
    var studioLoaded by remember(state.channelId) { mutableStateOf(false) }
    var channelName by remember(state.channelId) { mutableStateOf(state.channel.text("name")) }
    var channelDescription by remember(state.channelId) { mutableStateOf(state.channel.text("description")) }
    var era by remember(state.channelId) { mutableStateOf(state.channel.text("era")) }
    var knowledgeMode by remember(state.channelId) { mutableStateOf(state.channel.text("knowledge_mode")) }
    var diceGroup by remember(state.channelId) { mutableStateOf(state.channel.text("dice_text_group")) }
    var diceGroups by remember(state.serverId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var inviteUsername by remember(state.channelId) { mutableStateOf("") }
    LaunchedEffect(state.channelId) {
        if (state.gm) {
            try { diceGroups = model.rows(listOf("servers", state.serverId, "dice-texts")) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { /* Keep the current selection when unavailable. */ }
        }
        if (state.gm && state.studioAvailable) model.run {
            val v = model.get(listOf("channels", state.channelId, "studio", "settings"))
            cloud = v.flag("studio_cloud_allowed"); budget = v.number("tts_budget_chars").toString(); studioLoaded = true
        }
    }
    LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text(state.channel.text("name"), style = MaterialTheme.typography.titleLarge); Text(tr("以下设置仅作用于当前频道")) }
            item { HorizontalDivider(); Text(tr("守密人设置"), Modifier.padding(top = 16.dp), style = MaterialTheme.typography.titleMedium) }
            item { OutlinedTextField(channelName, { channelName = it }, label = { Text(tr("频道名称")) }) }
            item { OutlinedTextField(channelDescription, { channelDescription = it }, label = { Text(tr("频道介绍")) }) }
            item { OutlinedTextField(era, { era = it }, label = { Text(tr("故事年代")) }) }
            item { Choice(tr("角色知识"), knowledgeMode, listOf("isolated" to tr("隔离：各自掌握线索"), "public" to tr("公开：共享知识")), !state.busy) { knowledgeMode = it }
                Text(tr("公开模式会让角色共享频道知识；隔离模式按角色可见范围提供线索。")) }
            item { Choice(tr("骰子回复"), diceGroup, listOf("" to tr("跟随服务器"), "builtin:zh" to "中文", "builtin:en" to "English") + diceGroups.map { it.id to it.name }, !state.busy) { diceGroup = it } }
            item { SettingToggle(tr("AI 观察与整理"), ai, !state.busy) { ai = it } }
            item { SettingToggle(tr("向成员显示日志制作"), visible, !state.busy) { visible = it } }
            item { SettingToggle(tr("根据叙述建议新阶段"), autoScenarios, !state.busy) { autoScenarios = it } }
            item { ScenarioControls(state, model) }
            item { StoryControls(state, model) }
            item { SettingToggle(tr("Players may open the Log Studio before the story ends"), playerAccess, !state.busy) { playerAccess = it } }
            item { Button(onClick = { model.launch {
                model.get(listOf("channels", state.channelId), buildJsonObject { put("name", channelName.trim()); put("description", channelDescription); put("era", era); put("knowledge_mode", knowledgeMode); put("dice_text_group", diceGroup); put("ai_enabled", ai); put("studio_visible", visible); put("studio_player_access", playerAccess); put("auto_scenarios", autoScenarios) }, "PUT"); model.refreshCatalog(); model.refresh(); model.notice(tr("守密人设置已保存"))
            } }, enabled = !state.busy && channelName.isNotBlank() && era.length <= 80) { Text(tr("保存频道设置")) } }
            item { OutlinedTextField(inviteUsername, { inviteUsername = it }, label = { Text(tr("邀请玩家：账号名")) }) }
            item { Text(tr(if (state.serverSettings.flag("is_maintainer") || state.serverSettings.obj("policy").flag("guest_invites")) "You may invite registered users outside this server as channel guests." else "You may invite existing server members to this channel.")) }
            item { TextButton(onClick = { model.launch {
                model.get(listOf("channels", state.channelId, "members"), payload("username" to inviteUsername.trim(), "role" to "player"))
                inviteUsername = ""; model.notice(tr("玩家已加入频道"))
            } }, enabled = !state.busy && inviteUsername.isNotBlank()) { Text(tr("添加到频道")) } }
            if (studioLoaded) {
                item { SettingToggle(tr("允许日志制作使用云端处理"), cloud, !state.busy) { cloud = it } }
                item { OutlinedTextField(budget, { budget = it }, label = { Text(tr("配音字符预算")) }) }
                item { Button(onClick = { model.launch {
                    model.get(listOf("channels", state.channelId, "studio", "settings"), buildJsonObject { put("studio_cloud_allowed", cloud); put("tts_budget_chars", budget.toInt()) }, "PUT"); model.notice(tr("日志制作设置已保存"))
                } }, enabled = !state.busy && (budget.toIntOrNull() ?: -1) >= 0) { Text(tr("保存日志制作设置")) } }
            }
    }
}
@Composable private fun SettingToggle(title: String, value: Boolean, enabled: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(title, Modifier.weight(1f)); Switch(value, change, enabled = enabled) }
}

@Composable fun StudioPage(state: AppState, model: AppViewModel) {
    var log by remember(state.channelId) { mutableStateOf(JsonObject(emptyMap())) }
    var creating by remember { mutableStateOf(false) }
    var dubbing by remember { mutableStateOf("") }
    if (!state.studioAvailable) { Text(tr("日志制作已被服务器管理员或 GM 关闭"), Modifier.padding(24.dp)); return }
    if (dubbing.isNotEmpty()) { DubbingPanel(dubbing, state, model) { dubbing = "" }; return }
    if (creating) { NovelCreator(state, model) { creating = false }; return }
    var presentations by remember(state.channelId) { mutableStateOf(emptyList<JsonObject>()) }
    var pdfJobs by remember(state.channelId) { mutableStateOf(emptyList<JsonObject>()) }
    var performanceScenes by remember(state.channelId) { mutableStateOf(emptyList<JsonObject>()) }
    var events by remember(state.channelId) { mutableStateOf(emptyList<JsonObject>()) }
    var presentationId by remember(state.channelId) { mutableStateOf("") }
    var index by remember(state.channelId) { mutableIntStateOf(0) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var audioFile by remember { mutableStateOf<File?>(null) }
    var exportBytes by remember { mutableStateOf<ByteArray?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val base = listOf("channels", state.channelId, "studio")
    fun task(work: suspend () -> Unit) { if (!loading) scope.launch {
        loading = true; error = ""
        try { work() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = if (e is BackendException) e.message.orEmpty() else tr("日志操作失败，请重试") }
        finally { loading = false }
    } }
    fun stopAudio() { player?.release(); player = null; audioFile?.delete(); audioFile = null }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val bytes = exportBytes; exportBytes = null
        if (uri != null && bytes != null) task { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error(tr("无法写入文件")) } }
    }
    LaunchedEffect(state.channelId) { task {
        if (state.channelId.isNotEmpty()) { log = model.get(base + "log"); presentations = model.rows(base + "presentations"); pdfJobs = model.rows(base + listOf("pdf", "jobs")) }
    } }
    DisposableEffect(Unit) { onDispose { stopAudio() } }
    LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (error.isNotEmpty()) item { Text(error, color = MaterialTheme.colorScheme.error) }
        if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        item { TextButton(onClick = { task { log = model.get(base + "log"); presentations = model.rows(base + "presentations"); pdfJobs = model.rows(base + listOf("pdf", "jobs")) } }, enabled = !loading) { Text(tr("刷新日志")) } }
        events.getOrNull(index)?.let { event ->
            item { Text(tr("Play") + " · ${index + 1} / ${events.size}", style = MaterialTheme.typography.titleMedium) }
            val scene = performanceScenes.find { it.id == event.text("scene_id") }
            if (scene != null && scene.text("background_asset_id").isNotEmpty()) item { AuthenticatedArtwork(model, state.channelId, scene.text("background_asset_id"), scene.number("background_asset_version"), Modifier.fillMaxWidth().height(180.dp)) }
            val standees = event.rows("character_asset_ids").filter { it.text("asset_id").isNotEmpty() }
            if (standees.isNotEmpty()) item { Row { standees.forEach { item -> AuthenticatedArtwork(model, state.channelId, item.text("asset_id"), item.number("asset_version"), Modifier.weight(1f).height(140.dp)) } } }
            item { Text(event.text("speaker_name_override").ifEmpty { event.text("speaker_display_name") }) }
            item { Text(if (event.text("display_kind") == "dice") event.obj("dice").text("text").ifEmpty { event.text("display_text") } else event.text("display_text"), style = MaterialTheme.typography.bodyLarge) }
            item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                fun move(delta: Int) { stopAudio(); index += delta; val position = index; task { model.get(base + listOf("presentations", presentationId, "progress"), buildJsonObject { put("position", position) }) } }
                OutlinedButton(onClick = { move(-1) }, enabled = index > 0 && !loading) { Text(tr("上一段")) }
                OutlinedButton(onClick = { move(1) }, enabled = index < events.lastIndex && !loading) { Text(tr("下一段")) }
            } }
            if (event.text("audio_asset_id").isNotEmpty()) item {
                Button(onClick = { task {
                    stopAudio()
                    val bytes = model.bytes(base + listOf("tts", "audio", event.text("audio_asset_id")))
                    val file = File.createTempFile("studio-audio-", ".audio", context.cacheDir); audioFile = file
                    withContext(Dispatchers.IO) { file.writeBytes(bytes) }
                    val next = MediaPlayer(); player = next
                    withContext(Dispatchers.IO) { next.setDataSource(file.absolutePath); next.prepare() }; next.start()
                } }, enabled = !loading) { Text(if (event.flag("audio_is_mock")) tr("播放示例音频") else tr("播放配音")) }
            } else item { Text(tr("此段暂无已生成配音"), style = MaterialTheme.typography.bodySmall) }
            item { TextButton(onClick = { stopAudio(); events = emptyList() }) { Text(tr("关闭回放")) } }
        }
        item { Text(tr("已有演出"), style = MaterialTheme.typography.titleMedium) }
        items(presentations, key = { "presentation:" + it.id }) { item ->
            var expanded by remember { mutableStateOf(false) }
            Column {
            TextButton(onClick = { expanded = !expanded }) { Text(item.name) }
            if (expanded) {
            TextButton(onClick = { task {
            stopAudio(); val v = model.get(base + listOf("presentations", item.id)); val progress = model.get(base + listOf("presentations", item.id, "progress"))
            performanceScenes = v.rows("scenes"); events = v.rows("events").filter { !it.flag("hidden") }; presentationId = item.id; index = progress.number("position").coerceIn(0, maxOf(0, events.lastIndex))
        } }, enabled = !loading) { Text(tr("开始回放")) }
            TextButton(onClick = { dubbing = item.id }) { Text(tr("配音选角")) }
            TextButton(onClick = { task { exportBytes = model.bytes(base + listOf("presentations", item.id, "bundle.zip")); save.launch("novel-${item.id}.zip") } }, enabled = !loading) { Text(tr("下载独立播放包")) }
            }
            }
        }
        if (presentations.isEmpty()) item { Text(tr("暂无可访问的演出")) }
        item { Text(tr("Events") + " · ${log.obj("project").number("event_count")}", style = MaterialTheme.typography.titleMedium) }
        item { Button(onClick = { creating = true }) { Text(tr("制作视觉小说")) } }
        items(listOf("json", "txt", "html", "zip")) { format ->
            TextButton(onClick = { task { exportBytes = model.bytes(base + listOf("log", "export"), mapOf("format" to format)); save.launch("campaign.$format") } }, enabled = !loading) { Text(tr("Export") + " ${format.uppercase()}") }
        }
        items(log.rows("windows")) { window ->
            TextButton(onClick = { task { exportBytes = model.bytes(base + listOf("log", "export"), mapOf("format" to "sealdice", "chat_window_id" to window.id)); save.launch("sealdice-${window.id}.json") } }, enabled = !loading) { Text(tr("SealDice JSON") + " · ${window.name}") }
        }
        item { Text(tr("PDF 文件"), style = MaterialTheme.typography.titleMedium) }
        items(pdfJobs, key = { "pdf:" + it.id }) { job ->
            if (job.text("status") == "completed") TextButton(onClick = { task {
                exportBytes = model.bytes(base + listOf("pdf", "jobs", job.id, "file")); save.launch("log-${job.id}.pdf")
            } }, enabled = !loading) { Text(tr("Download") + " PDF · ${job.text("created_at")}") }
            else Text("PDF · ${job.text("status")}")
        }
        if (pdfJobs.isEmpty()) item { Text(tr("暂无 PDF，请先在 Log Studio 完成排版与渲染")) }

    }
}

@Composable fun AuthenticatedArtwork(model: AppViewModel, channelId: String, assetId: String, version: Int, modifier: Modifier) {
    var bitmap by remember(assetId, version) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(assetId, version) {
        try {
            val bytes = model.bytes(listOf("channels", channelId, "media", assetId), if (version > 0) mapOf("v" to version.toString()) else emptyMap())
            bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { bitmap = null }
    }
    bitmap?.let { Image(it, contentDescription = tr("演出素材"), modifier = modifier) } ?: Text(tr("素材加载中或不可用"), modifier, style = MaterialTheme.typography.bodySmall)
}
