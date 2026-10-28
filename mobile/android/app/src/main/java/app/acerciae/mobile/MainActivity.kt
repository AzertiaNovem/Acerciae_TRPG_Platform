package app.acerciae.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.acerciae.mobile.core.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.serialization.json.*

private val Ink = Color(0xFF121619)
private val Panel = Color(0xFF242A2E)
private val Accent = Color(0xFFCAD8BD)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Ink,
                surface = Ink, surfaceContainer = Panel, secondary = Color(0xFFD6C59D))) {
                AcerciaeApp()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun AcerciaeApp(model: AppViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    if (!state.online) {
        AuthenticationPage(state, model)
        state.notice?.let { message -> AlertDialog(onDismissRequest = { model.notice(null) }, title = { Text(tr("提示")) }, text = { Text(message) }, confirmButton = { TextButton(onClick = { model.notice(null) }) { Text(tr("知道了")) } }) }
        return
    }
    var page by rememberSaveable { mutableIntStateOf(0) }
    var panel by rememberSaveable { mutableStateOf<String?>(null) }
    var detail by rememberSaveable { mutableStateOf<String?>(null) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val campaign = state.campaign
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(state.user?.id) {
        if (state.online) lifecycle.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            model.poll(forceCatalog = true)
            while (true) { delay(4000); model.poll() }
        }
    }
    LaunchedEffect(state.draft, state.characterId) { delay(400); model.previewDice() }
    BackHandler(enabled = drawer.isOpen || page != 0) {
        if (drawer.isOpen) scope.launch { drawer.close() } else page = 0
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val drawerWidth = minOf(maxWidth * 0.64f, 320.dp)
    ModalNavigationDrawer(drawerState = drawer, drawerContent = {
        ModalDrawerSheet(Modifier.width(drawerWidth), drawerContainerColor = Panel) {
            SidebarPanel(state, model, page, select = { page = it; scope.launch { drawer.close() } },
                showDetail = { detail = it; scope.launch { drawer.close() } },
                close = { scope.launch { drawer.close() } })
        }
    }) {
    Scaffold(
        topBar = {
            TopAppBar(navigationIcon = {
                IconButton(onClick = { keyboard?.hide(); scope.launch { drawer.open() } },
                    modifier = Modifier.semantics { contentDescription = tr("打开侧栏") }) {
                    Canvas(Modifier.size(22.dp)) {
                        listOf(0.2f, 0.5f, 0.8f).forEach { y ->
                            drawLine(Accent, Offset(0f, size.height * y), Offset(size.width, size.height * y), strokeWidth = 2.dp.toPx())
                        }
                    }
                }
            }, title = {
                Column {
                    Text(if (page == 0) if (state.online) state.windowName else campaign?.title ?: "Acerciae" else if (page == 1) tr("故事回放") else if (page == 3) tr("服务器选项") else if (page == 4) tr("频道选项") else if (page == 5) tr("Servers") else tr("设置"), fontSize = 16.sp, maxLines = 1)
                }
            }, actions = {
                if (page == 0) {
                    TextButton(onClick = { panel = "documents" }) { Text(tr("考据")) }
                    TextButton(onClick = { panel = "hints" }) { Text(tr("Reminders") + " ${if (state.online) state.reminders.size else campaign?.highlights?.size ?: 0}") }
                }
            })
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (page) {
                0 -> if (campaign != null) ChatPage(campaign, state, model) else Text(if (state.servers.isEmpty()) tr("尚未加入服务器") + "\n" + tr("Ask a server administrator to invite your account: {username}").replace("{username}", state.user?.username.orEmpty()) else tr("从侧栏选择频道和聊天窗口"), Modifier.padding(24.dp))
                1 -> if (state.online) key(state.scopeKey, state.studioAccess, state.channel.text("story_status"), state.channel.flag("story_reveal_all")) { StudioPage(state, model) } else if (campaign != null) ReplayPage(campaign)
                5 -> ServerBrowser(state, model) { page = 0 }
                3 -> key(state.serverId) { LiveServerPage(state, model) }
                4 -> key(state.channelId) { LiveChannelPage(state, model) }
                else -> SettingsPage(state, model)
            }
        }
    }
    }
    }
    detail?.let { title ->
        if (title.startsWith("character:")) {
            androidx.compose.ui.window.Dialog(onDismissRequest = { detail = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
                Surface(Modifier.fillMaxSize()) { Column(Modifier.safeDrawingPadding()) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(tr("角色主页"), Modifier.padding(16.dp), style = MaterialTheme.typography.titleLarge); TextButton(onClick = { detail = null }) { Text(tr("完成")) } }
                    state.characters.find { it.id == title.substringAfter(":") }?.let { key(state.scopeKey) { CharacterPanel(it, state, model) } }
                } }
            }
        } else ModalBottomSheet(onDismissRequest = { detail = null }) {
            if (state.online && title == "create-channel") {
                CreateChannelPage(state, model) { detail = null }
            } else if (state.online && title == "create-character") {
                CreateCharacterPage(state, model) { detail = null }
            } else if (state.online && title.startsWith("character:")) {
                state.characters.find { it.id == title.substringAfter(":") }?.let { key(state.scopeKey) { CharacterPanel(it, state, model) } }
            } else if (state.online && title.startsWith("scene:")) {
                state.scenes.find { it.id == title.substringAfter(":") }?.let { key(state.scopeKey) { ScenePanel(it, state, model) } }
            } else Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge)
                Text(sidebarDetail(title, campaign), style = MaterialTheme.typography.bodyLarge)
                TextButton(onClick = { detail = null }) { Text(tr("完成")) }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
    if (panel != null && campaign != null) {
        ModalBottomSheet(onDismissRequest = { panel = null }) {
            if (state.online) key(state.channelId, state.channel["player_group_id"], state.channel["player_group_version"], state.gm) { ReminderPanel(state, model, panel == "documents") }
            else LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { Text(if (panel == "documents") tr("考据") else tr("提示"), style = MaterialTheme.typography.headlineSmall) }
                item { Text(if (state.online) tr("按当前账号权限显示") else "本地演示 · 当前以 GM 视角浏览", style = MaterialTheme.typography.labelMedium) }
                if (panel == "documents") items(campaign.documents, key = { it.id }) { doc ->
                    Surface(shape = RoundedCornerShape(16.dp), color = Panel) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(doc.title + if (doc.gmOnly) " · GM" else "", fontWeight = FontWeight.SemiBold)
                            Text(doc.preview.orEmpty(), style = MaterialTheme.typography.bodyMedium)
                            Text("v${doc.version}", style = MaterialTheme.typography.labelSmall, color = Accent)
                            if (state.online) TextButton(onClick = { model.launch { model.notice(model.get(listOf("channels", state.channelId, "documents", doc.id)).text("markdown")) } }) { Text(tr("阅读全文")) }
                        }
                    }
                } else items(campaign.highlights, key = { it.id }) { hint ->
                    Surface(shape = RoundedCornerShape(16.dp), color = Color(0xFF383725)) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(hint.reason, color = Color(0xFFE4D98E))
                            Text(campaign.documents.find { it.id == hint.documentId }?.title.orEmpty(), style = MaterialTheme.typography.labelMedium)
                            hint.sourceEventIds.forEach { id ->
                                campaign.messages.find { it.id == id }?.let { Text(tr("Source") + ": ${it.content}", style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(28.dp)) }
            }
        }
    }
    state.result?.let { result ->
        ModalBottomSheet(onDismissRequest = { model.result(null) }) {
            LazyColumn(Modifier.padding(24.dp)) {
                item { Text(if (state.resultType == "inspiration") tr("灵感草稿") else tr("一致性检查"), style = MaterialTheme.typography.titleLarge) }
                item { Text(result, Modifier.padding(vertical = 16.dp)) }
                if (state.resultType == "inspiration") item { Button(onClick = { model.draft(result); model.result(null) }) { Text(tr("采用草稿")) } }
                item { TextButton(onClick = { model.result(null) }) { Text(tr("关闭")) } }
            }
        }
    }
    state.notice?.let {
        AlertDialog(onDismissRequest = { model.notice(null) }, title = { Text(tr("提示")) },
            text = { LazyColumn { item { Text(it) } } }, confirmButton = { TextButton(onClick = { model.notice(null) }) { Text(tr("知道了")) } })
    }
}

@Composable private fun SidebarPanel(state: AppState, model: AppViewModel, page: Int, select: (Int) -> Unit, showDetail: (String) -> Unit, close: () -> Unit) {
    var charactersExpanded by rememberSaveable { mutableStateOf(true) }
    var stagesExpanded by rememberSaveable { mutableStateOf(true) }
    Column(Modifier.fillMaxHeight().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Acerciae", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = close) { Text(tr("关闭"), fontSize = 12.sp) }
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (state.online) {
                item {
                    var expanded by remember { mutableStateOf(false) }
                    TextButton(onClick = { expanded = true }) { Text(state.serverName) }
                    DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
                        state.servers.forEach { server -> DropdownMenuItem(text = { Text(server.name) }, onClick = { expanded = false; model.launch { model.selectServer(server.id) } }) }
                    }
                }
                item { SidebarRow(tr("Servers")) { select(5) } }
                if (state.serverSettings.flag("is_maintainer")) item { SidebarRow(tr("服务器选项")) { select(3) } }
                item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(tr("频道"), style = MaterialTheme.typography.labelMedium)
                    TextButton(onClick = { showDetail("create-channel") }, enabled = state.serverId.isNotEmpty() && state.canCreateChannel && !state.busy) { Text(tr("添加")) }
                } }
                items(state.channels, key = { "channel:" + it.id }) { channel -> SidebarRow(channel.name, channel.id == state.channelId) { model.launch { model.selectChannel(channel.id) } } }
                if (state.gm) item { SidebarRow(tr("频道选项")) { select(4) } }
                item { Text(tr("聊天窗口"), style = MaterialTheme.typography.labelMedium) }
                items(state.windows, key = { "window:" + it.id }) { window -> SidebarRow(window.name, window.id == state.windowId) { model.launch { model.selectWindow(window.id); select(0) } } }
                item { TextButton(onClick = { charactersExpanded = !charactersExpanded }) { Text(tr("Characters") + if (charactersExpanded) " −" else " +") } }
                if (charactersExpanded && state.channelId.isNotEmpty()) item { TextButton(onClick = { showDetail("create-character") }, enabled = !state.busy) { Text(tr("添加角色")) } }
                if (charactersExpanded) items(state.characters, key = { "character:" + it.id }) { item -> TextButton(onClick = { showDetail("character:" + item.id) }) { ProfileAvatar(item.name, state, model, item.text("avatar_asset_id"), item.text("updated_at")); Spacer(Modifier.width(10.dp)); Text(item.name, Modifier.weight(1f)) } }
                item { TextButton(onClick = { stagesExpanded = !stagesExpanded }) { Text(tr("Scenarios") + if (stagesExpanded) " −" else " +") } }
                if (stagesExpanded) items(state.scenes, key = { "scene:" + it.id }) { item -> SidebarRow(item.name) { showDetail("scene:" + item.id) } }
                if (state.windows.isEmpty()) item { Text(tr("Pick a server and channel, or create one from the left.")) }
            } else {
            item {
                TextButton(onClick = { showDetail(tr("服务器")) }, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(vertical = 12.dp)) {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Arkham Table", fontWeight = FontWeight.SemiBold)
                        Text(tr("服务器选项"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            item { Text(tr("聊天窗口"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            item { SidebarRow(tr("主聊天"), page == 0) { select(0) } }
            item { Text("黑水湾的提灯", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            item { TextButton(onClick = { charactersExpanded = !charactersExpanded }, contentPadding = PaddingValues(0.dp)) { Text(tr("Characters") + if (charactersExpanded) " −" else " +") } }
            if (charactersExpanded) items(listOf("哈维 · 我", "托马斯", tr("守秘人"))) { name -> SidebarRow(name) { showDetail(name) } }
            item { TextButton(onClick = { stagesExpanded = !stagesExpanded }, contentPadding = PaddingValues(0.dp)) { Text(tr("Scenarios") + if (stagesExpanded) " −" else " +") } }
            if (stagesExpanded) items(listOf("警署初访", "分头调查", "寄宿屋 · 当前")) { stage -> SidebarRow(stage) { showDetail(stage) } }
            }
        }
        HorizontalDivider()
        Spacer(Modifier.height(8.dp))
        SidebarRow(tr("故事回放"), page == 1) { select(1) }
        SidebarRow(tr("设置"), page == 2) { select(2) }
        Text(if (state.online) "${state.user?.displayName} · ${if (state.gm) "GM" else tr("Player")}" else "本地演示 · 内容不上传", Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun SidebarRow(title: String, selected: Boolean = false, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)
        .background(if (selected) Accent.copy(alpha = .12f) else Color.Transparent, RoundedCornerShape(12.dp)),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
        Text(title, Modifier.fillMaxWidth(), color = if (selected) Accent else MaterialTheme.colorScheme.onSurface)
    }
}

private fun sidebarDetail(title: String, campaign: DemoCampaign?): String = when (title) {
    tr("服务器") -> "Arkham Table\n当前战役：黑水湾的提灯\n\n当前为本地演示。服务器切换、管理员设置和功能开关将在联网后接入，频道 GM 与服务器管理员权限分别处理。"
    "哈维 · 我" -> "当前演示角色 · 古物学教授\n由 Alice 操作。正式角色卡与属性编辑将在联网后接入。"
    "托马斯" -> "示例角色 · 退役水手\n由 Carol 操作，昨夜独自调查了码头。"
    tr("守秘人") -> "频道 GM\n负责场景叙述与裁定；频道 GM 身份不等于服务器管理员。"
    "警署初访" -> "第一幕 · 历史阶段\n调查员在警长桌上发现提灯徽章，警长答应送来灯塔钥匙。\n\n此处仅浏览阶段摘要，不改变当前游戏阶段。"
    "分头调查" -> "第二幕 · 历史阶段\n调查员分头前往报社与码头。正式内容将按各自知识权限加载。"
    else -> campaign?.documents?.find { it.docType == "current_scene" }?.preview ?: "第三幕 · 调查员重聚"
}

@Composable private fun ChatPage(campaign: DemoCampaign, state: AppState, model: AppViewModel) {
    val scroll = rememberLazyListState()
    LaunchedEffect(campaign.messages.lastOrNull()?.id) { if (campaign.messages.isNotEmpty()) scroll.animateScrollToItem(campaign.messages.lastIndex + if (state.online && state.hasOlder) 2 else 1) }
    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = scroll, contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)) {
            item { Text(campaign.scene, Modifier.fillMaxWidth(), style = MaterialTheme.typography.labelSmall, color = Accent) }
            if (state.online && state.hasOlder) item { TextButton(onClick = model::older, enabled = !state.busy) { Text(tr("加载更早消息")) } }
            items(campaign.messages, key = { it.id }) { message -> MessageBubble(message, state, model) }
        }
        Composer(state, model)
    }
}

@Composable private fun MessageBubble(message: Message, state: AppState, model: AppViewModel) {
    val mine = state.user?.id != null && message.authorId == state.user?.id
    val character = state.characters.find { it.id == message.characterId }
    val asset = character?.text("avatar_asset_id") ?: message.characterAvatarAssetId.orEmpty()
    val revision = character?.text("updated_at").orEmpty() + ":" + (message.characterAvatarVersion ?: 0)
    val name = message.characterName ?: message.authorName
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top) {
        if (!mine) { ProfileAvatar(name, state, model, asset, revision, message.authorId.orEmpty(), message.authorAvatarVersion ?: 0); Spacer(Modifier.width(8.dp)) }
        Column(Modifier.widthIn(max = 280.dp).weight(1f, fill = false), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            Text(name + if (mine) " · " + tr("Me") else if (message.kind == "narration") " · GM" else "",
                style = MaterialTheme.typography.labelSmall, color = Color(0xFFA8ABA9))
            Spacer(Modifier.height(6.dp))
            if (message.dice != null) DiceResult(message) else Surface(shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp,
                bottomEnd = if (mine) 5.dp else 18.dp, bottomStart = if (mine) 18.dp else 5.dp),
                color = if (mine) Color(0xFF354337) else Panel) {
                Text(message.displayText, Modifier.padding(14.dp), style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (mine) { Spacer(Modifier.width(8.dp)); ProfileAvatar(name, state, model, asset, revision, message.authorId.orEmpty(), message.authorAvatarVersion ?: 0) }
    }
}

@Composable private fun Avatar(name: String) {
    Box(Modifier.size(32.dp).background(Color(0xFF48514A), CircleShape), contentAlignment = Alignment.Center) {
        Text(name.take(1), style = MaterialTheme.typography.labelMedium)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun Composer(state: AppState, model: AppViewModel) {
    var rolesOpen by remember { mutableStateOf(false) }
    Surface(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        shape = RoundedCornerShape(26.dp), color = Panel, tonalElevation = 2.dp) {
        Column(Modifier.padding(12.dp)) {
            BasicTextField(value = state.draft, onValueChange = model::draft, minLines = 1, maxLines = 5,
                modifier = Modifier.fillMaxWidth().padding(8.dp), textStyle = TextStyle(color = Color(0xFFF1EEE7), fontSize = 16.sp),
                cursorBrush = Brush.verticalGradient(listOf(Accent, Accent)), decorationBox = { input ->
                    Box { if (state.draft.isEmpty()) Text(tr("What does your character do or say?"), color = Color(0xFF9B9E9A)); input() }
                })
            if (state.diceHint.isNotEmpty()) Text(state.diceHint, style = MaterialTheme.typography.labelSmall)
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Box {
                    TextButton(onClick = { rolesOpen = true }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(if (state.characterId.isEmpty()) if (state.gm) tr("旁白") else tr("场外") else state.role) }
                    DropdownMenu(expanded = rolesOpen, onDismissRequest = { rolesOpen = false }) {
                        if (state.online) {
                            state.playable.forEach { role -> DropdownMenuItem(text = { Text(role.name) }, onClick = { model.chooseRole(role.id); rolesOpen = false }) }
                            DropdownMenuItem(text = { Text(if (state.gm) tr("旁白") else tr("场外")) }, onClick = { model.chooseRole(""); rolesOpen = false })
                        } else listOf("哈维", tr("旁白")).forEach { role -> DropdownMenuItem(text = { Text(role) }, onClick = { model.role(role); rolesOpen = false }) }
                    }
                }
                TextButton(onClick = { model.assistance("consistency") }, enabled = !state.busy && state.enabled("consistency") && state.draft.isNotBlank(), contentPadding = PaddingValues(6.dp)) { Text(tr("一致性"), fontSize = 12.sp) }
                TextButton(onClick = { model.assistance("inspiration") }, enabled = !state.busy && state.enabled("inspiration"), contentPadding = PaddingValues(6.dp)) { Text(tr("灵感"), fontSize = 12.sp) }
                FilledTonalButton(onClick = model::sendDemo, enabled = state.draft.isNotBlank() && !state.busy, contentPadding = PaddingValues(horizontal = 14.dp)) { Text(tr("发送")) }
            }
        }
    }
}

@Composable private fun ReplayPage(campaign: DemoCampaign) {
    var index by rememberSaveable { mutableIntStateOf(0) }
    val frame = campaign.replay.getOrNull(index)
    if (frame == null) { Text(tr("暂无可回放内容"), Modifier.padding(24.dp)); return }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("视觉小说 · 模板预览", style = MaterialTheme.typography.titleMedium)
        Box(Modifier.weight(1f).fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0xFF243D42), Ink)), RoundedCornerShape(24.dp))) {
            Column(Modifier.align(Alignment.TopStart).padding(24.dp)) {
                Text(frame.atmosphere, color = Accent)
                Text("背景与立绘待导入", style = MaterialTheme.typography.labelSmall)
            }
            Surface(Modifier.align(Alignment.BottomCenter).padding(16.dp), shape = RoundedCornerShape(20.dp), color = Panel.copy(alpha = .95f)) {
                Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(frame.speaker, color = Accent, fontWeight = FontWeight.Bold)
                    Text(frame.text, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { index-- }, enabled = index > 0) { Text(tr("上一段")) }
            Text("${index + 1} / ${campaign.replay.size}")
            OutlinedButton(onClick = { index++ }, enabled = index < campaign.replay.lastIndex) { Text(tr("下一段")) }
        }
        Text("Qwen 语音、统一画风素材、海豹 JSON 和 PDF 导出将在服务端协议就绪后接入。", style = MaterialTheme.typography.bodySmall, color = Color(0xFFA8ABA9))
    }
}

@Composable private fun SettingsPage(state: AppState, model: AppViewModel) {
    val scope = rememberCoroutineScope()
    LazyColumn(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) { ProfileAvatar(state.user?.displayName.orEmpty(), state, model, ownerId = state.user?.id.orEmpty(), ownerVersion = state.user?.avatarVersion ?: 0, size = 48.dp); Text(state.user?.displayName.orEmpty(), style = MaterialTheme.typography.titleLarge) }; Text(state.user?.username.orEmpty()) }
        item { Button(onClick = model::logout, enabled = !state.busy) { Text(tr("退出登录")) } }
        item { LanguagePicker(state, model); Text(tr("This changes your interface only. Server AI output language stays unchanged."), style = MaterialTheme.typography.bodySmall) }
        item { Text(tr("内容同步"), style = MaterialTheme.typography.titleMedium) }
        item { TextButton(onClick = { scope.launch { model.poll(forceCatalog = true) } }, enabled = !state.busy) { Text(tr("立即刷新")) } }
        item { Text(tr(state.connection), color = Accent) }
        item { Text(tr("聊天每 4 秒刷新，服务器与频道列表每 30 秒同步，回到前台立即更新。")) }
    }
}

@Composable private fun AuthenticationPage(state: AppState, model: AppViewModel) {
    var registering by rememberSaveable { mutableStateOf(false) }
    var username by rememberSaveable { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    // Password fields deliberately do not survive activity/process recreation.
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    val cleanUsername = username.trim()
    val valid = cleanUsername.isNotEmpty() && password.isNotEmpty() && (!registering || (Regex("^[a-zA-Z0-9_.-]{3,32}$").matches(cleanUsername) && password.length >= 6 && password == confirmation))
    LazyColumn(Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text("Acerciae", style = MaterialTheme.typography.headlineLarge); Text(if (registering) tr("创建账号，加入你的跑团") else tr("登录账号，继续你的故事")) }
        item { LanguagePicker(state, model) }
        item { Text(if (registering) tr("注册账号") else tr("登录"), style = MaterialTheme.typography.titleLarge) }
        item { OutlinedTextField(username, { username = it }, label = { Text(tr("用户名")) }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !state.busy) }
        if (registering) item { OutlinedTextField(displayName, { displayName = it }, label = { Text(tr("显示名称（选填）")) }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !state.busy) }
        item { OutlinedTextField(password, { password = it }, label = { Text(tr("密码")) }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !state.busy) }
        if (registering) {
            item { OutlinedTextField(confirmation, { confirmation = it }, label = { Text(tr("确认密码")) }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !state.busy) }
            item { Text(tr("用户名为 3–32 位字母、数字、下划线、点或短横线；密码至少 6 位。"), style = MaterialTheme.typography.bodySmall) }
            if (confirmation.isNotEmpty() && confirmation != password) item { Text(tr("两次输入的密码不一致"), color = MaterialTheme.colorScheme.error) }
        }
        item { Button(onClick = { model.login(cleanUsername, password, registering, displayName.trim()); password = ""; confirmation = "" }, enabled = valid && !state.busy, modifier = Modifier.fillMaxWidth()) { Text(if (state.busy) tr("请稍候…") else if (registering) tr("注册并登录") else tr("登录")) } }
        item { TextButton(onClick = { registering = !registering; password = ""; confirmation = ""; model.notice(null) }, enabled = !state.busy) { Text(if (registering) tr("已有账号？返回登录") else tr("还没有账号？注册")) } }
        item { Text(tr("登录状态安全保存在此设备，退出登录后清除。"), style = MaterialTheme.typography.bodySmall) }
    }
}
