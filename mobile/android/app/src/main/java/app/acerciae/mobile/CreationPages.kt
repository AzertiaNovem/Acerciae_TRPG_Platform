package app.acerciae.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.*

@Composable fun Choice(label: String, value: String, options: List<Pair<String, String>>, enabled: Boolean = true, change: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }, enabled = enabled) { Text(label + "：" + (options.find { it.first == value }?.second ?: value)) }
        DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { change(id); expanded = false }) }
        }
    }
}

@Composable fun CreateChannelPage(state: AppState, model: AppViewModel, close: () -> Unit) {
    if (!state.canCreateChannel) { Text(tr("Only server maintainers can create channels.")); return }
    val server = remember { state.serverId }
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("isolated") }
    var createdId by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(tr("添加频道"), style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(name, { name = it }, label = { Text(tr("频道名称")) }, enabled = createdId == null && !state.busy)
        OutlinedTextField(description, { description = it }, label = { Text(tr("频道介绍")) }, enabled = createdId == null && !state.busy)
        Choice(tr("角色知识"), mode, listOf("isolated" to tr("隔离：各自掌握线索"), "public" to tr("公开：共享知识")), createdId == null && !state.busy) { mode = it }
        Text(tr("创建后你将成为此频道的守密人，并自动建立主聊天窗口。"))
        Button(onClick = { model.launch {
            if (createdId == null) createdId = model.get(listOf("servers", server, "channels"), payload("name" to name.trim(), "description" to description, "knowledge_mode" to mode, "rule_system" to "coc7e")).id
            if (model.state.value.serverId == server) { model.refreshCatalog(); model.selectChannel(createdId!!) }
            close()
        } }, enabled = !state.busy && name.isNotBlank()) { Text(if (createdId == null) tr("创建") else tr("打开频道")) }
        TextButton(onClick = close, enabled = !state.busy) { Text(tr("取消")) }
    }
}

@Composable fun CreateCharacterPage(state: AppState, model: AppViewModel, close: () -> Unit) {
    val channel = remember { state.channelId }
    var name by remember { mutableStateOf("") }
    var style by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("pc") }
    var owner by remember { mutableStateOf("") }
    var members by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var created by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(channel) { if (state.gm) model.run { members = model.rows(listOf("channels", channel, "members")) } }
    if (created != null) { CharacterSpace(created!!, state, model, close); return }
    Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(tr("添加角色"), style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(name, { name = it }, label = { Text(tr("角色姓名")) })
        OutlinedTextField(style, { style = it }, label = { Text(tr("说话风格")) })
        if (state.gm) {
            Choice(tr("类型"), kind, listOf("pc" to tr("玩家角色"), "npc" to "NPC"), !state.busy) { kind = it }
            if (kind == "pc") Choice(tr("所属玩家"), owner, listOf("" to tr("我自己")) + members.filter { it.id != state.user?.id }.map { it.id to it.text("display_name") }, !state.busy) { owner = it }
        }
        Text(tr("创建后可继续编辑属性、技能、背景和外观。"))
        Button(onClick = { model.launch {
            created = model.get(listOf("channels", channel, "characters"), buildJsonObject {
                put("name", name.trim()); put("kind", kind); put("speaking_style", style)
                if (state.gm && kind == "pc" && owner.isNotEmpty()) put("user_id", owner)
            })
            model.refresh()
        } }, enabled = !state.busy && name.isNotBlank()) { Text(tr("创建并编辑角色卡")) }
        TextButton(onClick = close, enabled = !state.busy) { Text(tr("取消")) }
    }
}
