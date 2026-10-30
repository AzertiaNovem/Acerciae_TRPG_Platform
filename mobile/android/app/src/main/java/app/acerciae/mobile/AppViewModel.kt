package app.acerciae.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.acerciae.mobile.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

private val emptyObject = JsonObject(emptyMap())
data class AppState(
    val campaign: DemoCampaign? = null, val error: String? = null,
    val speechMode: String = "ooc", val references: List<Message> = emptyList(), val jumpMessageId: String? = null,
    val draft: String = "", val role: String = tr("场外"),
    val endpoint: String = ServiceConfiguration.BACKEND_ROOT, val connection: String = tr("尚未检查"),
    val checking: Boolean = false, val notice: String? = null,
    val user: User? = null, val busy: Boolean = false,
    val servers: List<JsonObject> = emptyList(), val channels: List<JsonObject> = emptyList(),
    val reminders: List<JsonObject> = emptyList(),
    val windows: List<JsonObject> = emptyList(), val characters: List<JsonObject> = emptyList(), val scenes: List<JsonObject> = emptyList(),
    val serverId: String = "", val channelId: String = "", val windowId: String = "", val characterId: String = "",
    val channel: JsonObject = emptyObject, val serverSettings: JsonObject = emptyObject,
    val hasOlder: Boolean = false, val diceHint: String = "", val result: String? = null, val resultType: String = "",
) {
    val online get() = user != null
    val scopeKey get() = channelId + channel.text("my_role") + channel.text("player_group_id") + channel["player_group_version"].toString() + channel["my_character_ids"].toString()
    val studioAccess get() = AccessRules.studio(channel, serverSettings)
    val studioAvailable get() = studioAccess == "open"
    val serverRole get() = servers.find { it.id == serverId }?.text("my_role").orEmpty()
    val canCreateChannel get() = AccessRules.canCreateChannel(serverRole, serverSettings)
    val gm get() = channel.text("my_role") == "gm"
    val playable get() = characters.filter { it.text("user_id") == user?.id || (gm && it.text("kind") == "npc") }
    val serverName get() = servers.find { it.id == serverId }?.name ?: tr("服务器")
    val windowName get() = windows.find { it.id == windowId }?.name ?: tr("聊天")
    fun enabled(feature: String) = !online || serverSettings.obj("features").flag(feature)
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow(AppState())
    val state = mutableState.asStateFlow()
    private var api: BackendClient? = null
    private var session: Session? = null
    private var epoch = 0L
    private val drafts = mutableMapOf<String, String>()
    private var refreshing = false
    private var polling = false
    private var catalogUpdated = 0L
    private val sessionStore = SessionStore(application)
    init {
        MobileLocale.initialize(application)
        try {
            sessionStore.read()?.let { saved ->
                if (!ServiceConfiguration.acceptsSavedEndpoint(saved.endpoint)) { sessionStore.clear(); return@let }
                api = BackendClient(BackendAddress(ServiceConfiguration.BACKEND_ROOT, BuildConfig.DEBUG)); session = saved.session
                saved.session.user.uiLanguage?.let { MobileLocale.set(it) }
                update { copy(user = saved.session.user, campaign = null, connection = "正在恢复登录…") }
            }
        } catch (_: Exception) { update { copy(notice = tr("无法读取已保存的登录，请重新登录")) } }
    }
    private fun update(block: AppState.() -> AppState) { mutableState.value = state.value.block() }
    fun draft(value: String) { update { copy(draft = value) } }
    fun speechMode(value: String) { if (value in listOf("ic", "narration", "ooc")) update { copy(speechMode = value) } }
    fun removeReference(id: String) { update { copy(references = references.filterNot { it.id == id }) } }
    fun role(value: String) { update { copy(role = value) } }
    fun chooseRole(id: String) { update { copy(characterId = id, role = playable.find { it.id == id }?.name ?: if (gm) tr("旁白") else tr("场外"), diceHint = "") } }
    fun notice(value: String?) { update { copy(notice = value) } }
    fun result(value: String?) { update { copy(result = value) } }
    fun launch(work: suspend () -> Unit) { viewModelScope.launch { run(work) } }
    suspend fun run(work: suspend () -> Unit) {
        if (state.value.busy) return
        update { copy(busy = true) }
        try { work() } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { handle(e) }
        finally { update { copy(busy = false) } }
    }
    private fun client() = api ?: error(tr("请先登录"))
    private fun token() = session?.token ?: error(tr("请先登录"))
    suspend fun get(path: List<String>, body: JsonObject? = null, method: String? = null, query: Map<String, String> = emptyMap()) = client().resource(path, token(), body, method, query)
    suspend fun rows(path: List<String>, query: Map<String, String> = emptyMap()) = client().resources(path, token(), query)
    suspend fun bytes(path: List<String>, query: Map<String, String> = emptyMap()) = client().bytes(path, token(), query)
    suspend fun uploadArtwork(bytes: ByteArray, character: String, slot: String, subtitle: String) = client().uploadCharacterAsset(state.value.channelId, character, slot, subtitle, bytes, token())
    fun login(username: String, password: String, registering: Boolean = false, displayName: String = "") = launch {
        val client = BackendClient(BackendAddress(state.value.endpoint, BuildConfig.DEBUG))
        val auth = try {
            if (registering) client.register(username, password, displayName) else client.login(username, password)
        } catch (e: BackendException) {
            when (e.status) {
                409 -> { notice(tr("用户名已被使用，请换一个用户名")); return@launch }
                401 -> { notice(tr("用户名或密码不正确")); return@launch }
                else -> throw e
            }
        }
        epoch++; api = client; session = auth; drafts.clear(); catalogUpdated = 0L
        auth.user.uiLanguage?.let { MobileLocale.set(it) }
        update { AppState(endpoint = endpoint, user = auth.user, busy = true, connection = "已连接") }
        try { sessionStore.save(SavedLogin(state.value.endpoint, auth)) }
        catch (_: Exception) { notice(tr("登录成功，但设备未能安全保存登录状态")) }
        val stamp = epoch; val servers = rows(listOf("servers")); if (stamp != epoch) return@launch; update { copy(servers = servers) }
        servers.firstOrNull()?.let { selectServer(it.id) }
    }
    fun changeLanguage(code: String) {
        if (code !in InterfaceLanguage.codes) return
        if (!state.value.online) { MobileLocale.set(code); return }
        launch {
            val auth = session ?: return@launch
            val value = get(listOf("auth", "me"), payload("ui_language" to code), "PUT")
            if (session?.token != auth.token) return@launch
            val user = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<User>(value)
            session = Session(auth.token, user); update { copy(user = user) }; MobileLocale.set(user.uiLanguage ?: code)
            sessionStore.save(SavedLogin(ServiceConfiguration.BACKEND_ROOT, session!!))
        }
    }
    fun changeAtmosphere(enabled: Boolean) = launch {
        val auth = session ?: return@launch
        val value = get(listOf("auth", "me"), buildJsonObject { put("atmosphere_enabled", enabled) }, "PUT")
        if (session?.token != auth.token) return@launch
        val user = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<User>(value)
        session = Session(auth.token, user); update { copy(user = user) }
        sessionStore.save(SavedLogin(ServiceConfiguration.BACKEND_ROOT, session!!))
    }
    fun logout() {
        val oldApi = api; val oldToken = session?.token
        epoch++; api = null; session = null; drafts.clear(); catalogUpdated = 0L
        update { AppState(connection = "已退出登录") }
        try { sessionStore.clear() } catch (_: Exception) { notice(tr("设备未能清除登录记录，请保持联网完成退出")) }
        if (oldApi != null && oldToken != null) viewModelScope.launch { runCatching { oldApi.resource(listOf("auth", "logout"), oldToken, emptyObject) } }
    }
    private fun rememberDraft() { if (state.value.windowId.isNotEmpty()) drafts[state.value.windowId] = state.value.draft }
    private fun clearChannel() { update { copy(speechMode = "ooc", references = emptyList(), jumpMessageId = null, channelId = "", windowId = "", characterId = "", channel = emptyObject, campaign = null, windows = emptyList(), characters = emptyList(), scenes = emptyList(), reminders = emptyList(), draft = "", diceHint = "", result = null, hasOlder = false) } }
    suspend fun selectServer(id: String) {
        rememberDraft(); epoch++; val stamp = epoch; clearChannel()
        update { copy(serverId = id, serverSettings = emptyObject, channels = emptyList()) }
        val settings = get(listOf("servers", id, "settings")); val channels = rows(listOf("servers", id, "channels"))
        if (stamp != epoch) return
        update { copy(serverSettings = settings, channels = channels) }
        channels.firstOrNull()?.let { selectChannel(it.id) }
    }
    suspend fun selectChannel(id: String) {
        rememberDraft(); epoch++; val stamp = epoch; clearChannel(); update { copy(channelId = id) }
        val info = get(listOf("channels", id)); val windows = rows(listOf("channels", id, "windows"))
        val characters = rows(listOf("channels", id, "characters")); val scenes = rows(listOf("channels", id, "scenes"))
        if (stamp != epoch) return
        update { copy(channel = info, windows = windows, characters = characters, scenes = scenes) }
        chooseRole(state.value.playable.firstOrNull()?.id.orEmpty())
        windows.firstOrNull()?.let { selectWindow(it.id) }
    }
    suspend fun selectWindow(id: String) {
        rememberDraft(); epoch++
        update { copy(speechMode = if (gm) "narration" else "ic", references = emptyList(), jumpMessageId = null, windowId = id, draft = drafts[id].orEmpty(), campaign = null, diceHint = "", result = null) }
        refresh(false)
    }
    suspend fun refresh(merge: Boolean = true) {
        val s = state.value
        if (!s.online || s.windowId.isEmpty() || refreshing) return
        refreshing = true; val stamp = epoch
        try {
            val messages = client().messages(token(), s.channelId, s.windowId)
            val info = get(listOf("channels", s.channelId))
            val docs = if (info.text("my_role") == "gm") client().documents(token(), s.channelId) else emptyList()
            val highlights = if (info.text("my_role") == "gm") client().highlights(token(), s.channelId) else emptyList()
            val reminders = rows(listOf("channels", s.channelId, "reminders"))
            val settings = get(listOf("servers", s.serverId, "settings"))
            val wins = rows(listOf("channels", s.channelId, "windows")); val chars = rows(listOf("channels", s.channelId, "characters")); val scenes = rows(listOf("channels", s.channelId, "scenes"))
            if (stamp != epoch) return
            val permissionsChanged = s.channel["player_group_id"] != info["player_group_id"] || s.channel["player_group_version"] != info["player_group_version"] || s.channel["my_role"] != info["my_role"] || s.channel["my_character_ids"] != info["my_character_ids"] || s.channel["knowledge_mode"] != info["knowledge_mode"] || s.windows.find { it.id == s.windowId }?.get("members") != wins.find { it.id == s.windowId }?.get("members")
            if (permissionsChanged) update { copy(result = null, diceHint = "", references = emptyList(), jumpMessageId = null, speechMode = if (s.channel["my_role"] != info["my_role"]) if (info.text("my_role") == "gm") "narration" else "ic" else speechMode) }
            val all = ((if (merge && !permissionsChanged) state.value.campaign?.messages.orEmpty() else emptyList()) + messages).associateBy { it.id }.values.sortedBy { it.seq }
            update { copy(campaign = DemoCampaign(info.name, wins.find { it.id == s.windowId }?.text("scene_title").orEmpty(), all, docs, highlights, emptyList()),
                reminders = reminders, serverSettings = settings, channel = info, windows = wins, characters = chars, scenes = scenes,
                hasOlder = if (merge && !permissionsChanged) hasOlder else messages.size == 50, connection = "已连接 · 自动刷新") }
            if (state.value.characterId.isNotEmpty() && state.value.playable.none { it.id == state.value.characterId }) chooseRole("")
        } finally { refreshing = false }
    }
    suspend fun refreshCatalog() {
        if (!state.value.online) return
        val stamp = epoch
        val profile = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<User>(get(listOf("auth", "me")))
        val servers = rows(listOf("servers"))
        if (stamp != epoch) return
        val auth = session
        if (auth != null && profile.uiLanguage != null && (profile.uiLanguage != auth.user.uiLanguage || profile.avatarVersion != auth.user.avatarVersion || profile.displayName != auth.user.displayName || profile.atmosphereEnabled != auth.user.atmosphereEnabled)) {
            session = Session(auth.token, profile); update { copy(user = profile) }; MobileLocale.set(profile.uiLanguage)
            runCatching { sessionStore.save(SavedLogin(ServiceConfiguration.BACKEND_ROOT, session!!)) }
        }
        update { copy(servers = servers) }
        if (servers.none { it.id == state.value.serverId }) {
            epoch++; clearChannel(); update { copy(serverId = "", channels = emptyList(), serverSettings = emptyObject) }
            servers.firstOrNull()?.let { selectServer(it.id) }
        } else {
            val channels = rows(listOf("servers", state.value.serverId, "channels"))
            val settings = get(listOf("servers", state.value.serverId, "settings"))
            if (stamp != epoch) return
            update { copy(channels = channels, serverSettings = settings) }
            if (channels.none { it.id == state.value.channelId }) {
                epoch++; clearChannel(); channels.firstOrNull()?.let { selectChannel(it.id) }
            } else if (state.value.windowId.isEmpty()) selectChannel(state.value.channelId)
        }
        catalogUpdated = android.os.SystemClock.elapsedRealtime()
    }
    suspend fun poll(forceCatalog: Boolean = false) {
        if (!state.value.online || state.value.busy || polling) return
        polling = true
        val token = session?.token
        try {
            if (forceCatalog || catalogUpdated == 0L || android.os.SystemClock.elapsedRealtime() - catalogUpdated >= 30_000) refreshCatalog()
            refresh()
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (session?.token == token) handle(e, true) }
        finally { polling = false }
    }
    fun older() = launch {
        val s = state.value; val before = s.campaign?.messages?.firstOrNull()?.seq ?: return@launch; val stamp = epoch
        val messages = client().messages(token(), s.channelId, s.windowId, before)
        if (stamp == epoch) update { copy(campaign = campaign?.copy(messages = (messages + campaign.messages).distinctBy { it.id }.sortedBy { it.seq }), hasOlder = messages.size == 50) }
    }
    suspend fun openEvidence(event: JsonObject, quote: Boolean) {
        val s = state.value; val stamp = epoch
        val message = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<Message>(get(listOf("channels", s.channelId, "messages", event.text("message_id"))))
        if (stamp != epoch) return
        if (quote) {
            if (s.references.size >= 5 && s.references.none { it.id == message.id }) { notice(tr("At most five chat references")); return }
            update { copy(references = (references + message).distinctBy { it.id }) }
        }
        else {
            if (event.text("chat_window_id") != s.windowId) selectWindow(event.text("chat_window_id"))
            if (state.value.channelId != s.channelId || state.value.user?.id != s.user?.id || state.value.windowId != event.text("chat_window_id")) return
            update { copy(campaign = campaign?.copy(messages = (campaign.messages + message).distinctBy { it.id }.sortedBy { it.seq }), jumpMessageId = message.id) }
        }
    }
    fun sendDemo() { if (state.value.online) send() }
    private fun send() = launch {
        val s = state.value; val stamp = epoch; val text = s.draft.trim()
        if (text.isEmpty() || s.windowId.isEmpty()) return@launch
        val body = buildJsonObject {
            put("content", text); put("kind", s.speechMode); put("visibility", "window")
            if (s.characterId.isNotEmpty()) put("character_id", s.characterId)
            put("reference_ids", JsonArray(s.references.map { JsonPrimitive(it.id) }))
        }
        get(listOf("channels", s.channelId, "windows", s.windowId, "messages"), body)
        if (stamp != epoch) return@launch
        update { copy(draft = if (draft.trim() == text) "" else draft, diceHint = "", references = emptyList()) }; refresh()
    }
    fun assistance(type: String) {
        if (type == "consistency" && state.value.draft.isBlank()) return
        if (!state.value.online) { notice(tr("请先在设置中连接服务器")); return }
        launch {
            val s = state.value; val stamp = epoch
            if (type == "consistency" && s.draft.isBlank()) return@launch
            val body = buildJsonObject { put("chat_window_id", s.windowId); if (s.characterId.isNotEmpty()) put("character_id", s.characterId); put(if (type == "consistency") "draft" else "hint", s.draft) }
            val v = get(listOf("channels", s.channelId, type), body)
            if (stamp != epoch) return@launch
            val result = if (type == "inspiration") v.text("draft") else (if (v.flag("insufficient_evidence")) tr("证据不足") else v.text("score_label")) + "\n\n" + v.text("rationale") + "\n\n证据与冲突\n" + v.rows("evidence").joinToString("\n\n") { it.text("summary") + "\n" + it.text("scene_title") } + "\n" + v.rows("conflicts").joinToString("\n") { it.text("description") }
            update { copy(result = result, resultType = type) }
        }
    }
    suspend fun previewDice() {
        val s = state.value; val stamp = epoch
        if (!s.online || !s.enabled("dice") || !s.draft.trim().startsWith(".") || s.windowId.isEmpty()) { update { copy(diceHint = "") }; return }
        try {
            val body = buildJsonObject { put("content", s.draft); put("chat_window_id", s.windowId); if (s.characterId.isNotEmpty()) put("character_id", s.characterId) }
            val result = get(listOf("channels", s.channelId, "dice", "preview"), body)
            if (epoch == stamp && state.value.draft == s.draft) update { copy(diceHint = result.text("hint")) }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { if (stamp == epoch) update { copy(diceHint = tr("命令预览不可用；发送时由服务器校验")) } }
    }
    private fun handle(e: Exception, silent: Boolean = false) {
        if (e is BackendException && e.status == 401) { logout(); notice(tr("登录已过期，请重新登录")); return }
        if (e is BackendException && e.status in listOf(403, 404) && silent) { epoch++; clearChannel(); catalogUpdated = 0L }
        val message = if (e is BackendException || e is IllegalArgumentException) e.message ?: "请求失败" else tr("连接失败，请重试")
        update { copy(connection = message, notice = if (silent) notice else message) }
    }
    fun checkConnection() {
        if (state.value.checking) return
        val endpoint = state.value.endpoint; update { copy(checking = true, connection = "检查中…") }
        viewModelScope.launch {
            try { val health = BackendClient(BackendAddress(endpoint, BuildConfig.DEBUG)).health(); update { copy(connection = "${health.status} · 数据库 ${health.db} · LLM ${health.llmMode}") } }
            catch (e: CancellationException) { throw e } catch (e: Exception) { handle(e) }
            finally { update { copy(checking = false) } }
        }
    }
}
