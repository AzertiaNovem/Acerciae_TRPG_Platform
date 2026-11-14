package app.acerciae.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.acerciae.mobile.core.*
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

private val emptyObject = JsonObject(emptyMap())
data class AppState(
    val accountUsers: List<User> = emptyList(),
    val cacheRevision: Long = 0,
    val chatNotices: List<ChatNotice> = emptyList(), val initiative: JsonObject = emptyObject, val bannersEnabled: Boolean = true, val readAloud: Boolean = false,
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
    /** The text of lines the user recalled in this visit, by message id, for "Re-edit". */
    val recallDrafts: Map<String, String> = emptyMap(),
    val recalledMessages: Map<String, Message> = emptyMap(),
    /** Characters being written as right now: character id to the window they are typed in (core/Typing.kt). */
    val typing: Map<String, String> = emptyMap(),
    /** The Inspiration result on screen, and every option text shown so far (what "Another take" avoids). */
    val inspiration: JsonObject? = null, val inspirationShown: List<String> = emptyList(),
) {
    val online get() = user != null
    val scopeKey get() = cacheRevision.toString() + channelId + channel.text("my_role") + channel.text("player_group_id") + channel["player_group_version"].toString() + channel["my_character_ids"].toString()
    val studioAccess get() = AccessRules.studio(channel, serverSettings)
    val studioAvailable get() = studioAccess == "open"
    val serverRole get() = servers.find { it.id == serverId }?.text("my_role").orEmpty()
    val canCreateChannel get() = AccessRules.canCreateChannel(serverRole, serverSettings)
    val gm get() = channel.text("my_role") == "gm"
    val playable get() = characters.filter { it.text("user_id") == user?.id || (gm && it.text("kind") == "npc") }
    val serverName get() = servers.find { it.id == serverId }?.name ?: tr("服务器")
    val windowName get() = windows.find { it.id == windowId }?.name ?: tr("聊天")
    fun enabled(feature: String) = !online || FeatureAccess.enabled(feature, serverSettings, channel)
    /** Who else is writing in the window on screen (the character being written as here needs no telling). */
    val typingHere get() = if (windowId.isEmpty()) emptyList() else characters.filter { typing[it.id] == windowId && it.id != characterId }.map { it.name }
    /** The pin of a chat line among this group's reminders, when it is pinned. */
    fun pinOf(m: Message) = Pins.of(reminders, m.id)
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow(AppState())
    val state = mutableState.asStateFlow()
    private var api: BackendClient? = null
    private var session: Session? = null
    private var epoch = 0L
    private val drafts = mutableMapOf<String, String>()
    private val refreshing = mutableSetOf<Long>()
    private var polling = false
    private var catalogUpdated = 0L
    var foreground = false
        set(value) { field=value; if(!value) { stopArtworkPrefetch(); metadataJob?.cancel(); metadataJob=null; metadataGeneration++; metadataUpdated=0L; hypertextEngine.dispose() } }
    var chatVisible = false
    private val readSeq = mutableMapOf<String,Long>()
    private val preferences = application.getSharedPreferences("chat-activity",0)
    private var speechReady = false
    private val speech = android.speech.tts.TextToSpeech(application) { speechReady = it == android.speech.tts.TextToSpeech.SUCCESS }
    fun stopSpeech() { speech.stop() }
    override fun onCleared() { stopRealtime(); speech.stop(); speech.shutdown(); hypertext.reset(); hypertextEngine.dispose(); super.onCleared() }

    // ---- live updates. The chat stream (core/ChatSocket.kt) follows the channel on screen. A push wakes the poll loop
    // (MainActivity), which refreshes as it always has; a recall is applied at once. While the stream is live, polling
    // every 30 s is only a safety net; when it is down the loop polls every 4 s as before.
    @Volatile var pushPending = false
        private set
    @Volatile var pushConnected = false
        private set
    private var socket: ChatSocket? = null
    private var socketToken: String? = null
    private val pushListener = object : ChatSocket.Listener {
        override fun event(event: RealtimeEvent) { viewModelScope.launch { onPush(event) } }
        override fun live(live: Boolean) { viewModelScope.launch {
            pushConnected = live
            if (!live) { typingFlags.clear(); showTyping() }   // the snapshot after the next subscription says who is typing
            if (live) { pushPending = true; hypertext.resync() }   // card states and closings may have been missed
            if (state.value.online) update { copy(connection = if (live) "已连接 · 实时推送" else "已连接 · 自动刷新") }
        } }
        override fun resync() { pushPending = true; viewModelScope.launch { hypertext.resync() } }
    }
    fun followRealtime() {
        val s = state.value; val client = api; val token = session?.token
        if (!s.online || !foreground || s.channelId.isEmpty() || client == null || token == null) { stopRealtime(); return }
        if (token != socketToken) stopRealtime()
        val stream = socket ?: ChatSocket(BackendAddress(s.endpoint, BuildConfig.DEBUG), { client.fileToken(token) }, pushListener).also { socket = it; socketToken = token }
        stream.follow(s.channelId)
        if (typingJob == null) typingJob = viewModelScope.launch { while (true) { delay(1_000); typingSignal.tick(); if (typingFlags.prune()) showTyping() } }
    }
    fun stopRealtime() {
        socket?.close(); socket = null; socketToken = null; pushConnected = false
        typingJob?.cancel(); typingJob = null; typingSignal.forget(); typingFlags.clear(); showTyping()
    }
    // ---- typing flags (core/Typing.kt): a pen next to a character while it is being written as. The composer raises
    // this device's flag over the chat stream and keeps it up while the writer types; the table's flags arrive on the
    // same stream. The flag is the character's: writing as oneself raises none.
    private val typingFlags = TypingFlags()
    private val typingSignal = TypingSignal({ socket?.send(it) })
    private var typingJob: Job? = null
    private fun typingTarget() = state.value.let { TypingTarget.of(it.channelId, it.windowId, it.characterId) }
    private fun showTyping() { val current = typingFlags.byCharacter; if (current != state.value.typing) update { copy(typing = current) } }
    private fun onPush(e: RealtimeEvent) {
        if (e.channelId.isNotEmpty() && e.channelId != state.value.channelId) return
        if (hypertext.onPush(e)) return   // a card's state or closing: applied here, nothing to fetch
        if (typingFlags.apply(e)) { showTyping(); return }   // a pen is no reason to fetch anything
        when (e.type) {
            "message.recalled" -> e.message?.let(::applyRecall)
            "character.updated", "scene.changed", "server.settings" -> metadataUpdated = 0L
            "channel.deleted", "server.deleted" -> catalogUpdated = 0L
        }
        pushPending = true
    }

    // ---- interactive messages (kind hypertext, core/HypertextStore.kt): this viewer's state and the action pipeline
    // of the cards in the open window. The card routes go through the session signed in now (a 401 signs out, as
    // everywhere); a line an action posted joins the window at once; the engine page (HypertextEngine.kt) is made for
    // the first script and dropped when idle or in the background. Everything is dropped on sign-in, sign-out, a
    // channel switch and any change of knowledge scope. Spectators never come here.
    private val hypertextEngine = hypertextEngine(application, viewModelScope)
    private suspend fun <T> cardRoute(work: suspend (BackendClient, String) -> T): T {
        try { return work(client(), token()) }
        catch (e: BackendException) { if (ConnectionPolicy.invalidatesSession(e)) handle(e); throw e }
    }
    private val hypertextApi = object : HypertextApi {
        override suspend fun status(channel: String, ids: List<String>) = cardRoute { c, t -> c.hypertextStatus(t, channel, ids) }
        override suspend fun save(channel: String, message: String, state: JsonObject, baseVersion: Long) = cardRoute { c, t -> c.hypertextSave(t, channel, message, state, baseVersion) }
        override suspend fun act(channel: String, message: String, body: JsonObject) = cardRoute { c, t -> c.hypertextAct(t, channel, message, body) }
        override suspend fun close(channel: String, message: String) = cardRoute { c, t -> c.hypertextClose(t, channel, message) }
    }
    val hypertext = HypertextStore(hypertextApi, hypertextEngine, viewModelScope, posted = ::hypertextPosted)
    private val hypertextTracker = HxTracker()
    init {
        // The status of each card loaded in the open window is asked once, and for all of them when a window opens.
        viewModelScope.launch {
            state.map { s -> if (!s.online) HxTracker.View("", "", "", emptyList()) else HxTracker.View(s.user?.id.orEmpty() + "|" + s.scopeKey, s.channelId, s.windowId, HxTracker.cardIds(s.campaign?.messages.orEmpty())) }
                .distinctUntilChanged()
                .collect { v -> val step = hypertextTracker.next(v); if (step.reset) hypertext.reset(); if (step.track) hypertext.track(v.channelId, v.ids, step.refresh) }
        }
    }
    private fun hypertextPosted(m: Message) {
        val s = state.value; val lines = s.campaign?.messages ?: return
        val next = HxChat.withPosted(lines, m, s.channelId, s.windowId, recalledMessages) ?: return
        recallDeadlines.note(m)
        update { copy(campaign = campaign?.copy(messages = next)) }
    }
    /** A control of a card was used (the card has checked that it may be). */
    fun hypertextAct(ctx: HxContext, nodeId: String, action: HxAction) { if (state.value.online && ctx.channelId == state.value.channelId) hypertext.interact(ctx, nodeId, action) }
    /** "Post" (true) or "Cancel" on a card's confirmation. */
    fun hypertextAnswer(id: String, ok: Boolean) = hypertext.answer(id, ok)
    /** A GM closes a card for everyone; a refusal is shown in the server's words (a known code in the catalog's). */
    suspend fun hypertextClose(m: Message) {
        val stamp = epoch; val channel = m.channelId ?: state.value.channelId
        try { hypertext.close(channel, m.id) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            if (stamp != epoch) return
            notice(if (e is BackendException) tr(HypertextPipeline.errorText(e)) else tr(ConnectionPolicy.message(e)))
        }
    }

    // ---- recall: the author takes a line back within two minutes (docs/API.md). The tombstone replaces the line here,
    // in quoted references and in banners; the author keeps the text for "Re-edit".
    private val recallDeadlines = RecallDeadlines()
    private val recalledMessages get() = state.value.recalledMessages
    private fun wasRecalled(id: String) = recalledMessages.containsKey(id)
    fun canRecall(m: Message) = state.value.user?.id != null && !m.recalled && ((m.authorId == state.value.user?.id && recallDeadlines.open(m)) || (m.standIn && state.value.characters.any { it.id == m.characterId && it.text("user_id") == state.value.user?.id }))
    private fun applyRecall(tombstone: Message) {
        if (!tombstone.recalled) return
        if (!wasRecalled(tombstone.id)) {
            metadataUpdated = 0L
            val s = state.value; val imageChannel = tombstone.channelId ?: s.channelId
            ChatIllustrationImages.remove(ChatIllustrations.key(s.endpoint, s.user?.id.orEmpty(), imageChannel, tombstone.id))
            val imageClient = api
            viewModelScope.launch { imageClient?.forgetMessageImage(imageChannel, tombstone.id) }
            val cache = api?.reads
            viewModelScope.launch(Dispatchers.IO) { cache?.removeMessage(tombstone.id) }
        }
        speech.stop()
        update { copy(recalledMessages = recalledMessages + (tombstone.id to tombstone), campaign = campaign?.copy(messages = campaign.messages.withRecall(tombstone)), references = references.filterNot { it.id == tombstone.id },
            chatNotices = chatNotices.map { n -> n.copy(messages = n.messages.filterNot { it.id == tombstone.id }) }.filter { it.messages.isNotEmpty() }) }
    }
    fun recall(m: Message) = launch {
        val s = state.value; val stamp = epoch
        val done = try { client().recall(token(), s.channelId, m.id) } catch (e: BackendException) { val refusal = recallRefusal(e) ?: throw e; notice(tr(refusal)); return@launch }
        if (stamp != epoch) return@launch
        applyRecall(done.message)
        // A recalled interactive message has nothing to edit again (the server answers content "" for it too).
        if (done.content.isNotEmpty() && m.kind != Hypertext.KIND) update { copy(recallDrafts = recallDrafts + (m.id to done.content)) }
    }
    fun reedit(id: String) { val text = state.value.recallDrafts[id] ?: return; update { copy(draft = if (draft.isBlank()) text else draft + "\n" + text, recallDrafts = recallDrafts - id) } }
    fun setBanners(on:Boolean) { preferences.edit().putBoolean("banners",on).apply(); update { copy(bannersEnabled=on,chatNotices=if(on) chatNotices else emptyList()) } }
    fun setReadAloud(on:Boolean) { preferences.edit().putBoolean("readAloud",on).apply(); update { copy(readAloud=on) }; if(!on) speech.stop() }
    fun dismissNotice(id:String) { update { copy(chatNotices=chatNotices.filter { it.id!=id }) } }
    fun initiativeAction(action:String,entry:String="") = launch { val s=state.value; val value=get(listOf("channels",s.channelId,"windows",s.windowId,"initiative"),payload("action" to action,"entry_id" to entry)); update { copy(initiative=value) } }
    private suspend fun updateActivity(previous:AppState,stamp:Long,allowSpeech:Boolean) {
        if(stamp!=epoch || !foreground) return
        val s=state.value; val user=s.user?.id ?: return
        update { copy(chatNotices=chatNotices.filter { n -> windows.any { it.id==n.id && (it.text("kind")=="main" || it.rows("members").any { member -> member.text("user_id")==user }) } && (!chatVisible || n.id!=windowId) }) }
        if(s.bannersEnabled) for(win in s.windows.filter { WindowActivity.shouldNotify(previous.windows.find { old->old.id==it.id },it,user,if(chatVisible) s.windowId else "") }) {
            val old=previous.windows.find { it.id==win.id }?.number("last_seq") ?: 0
            val rows=client().messages(token(),s.channelId,win.id)
            val messages=rows.filter { it.seq>old && it.authorId!=user && !it.recalled && !wasRecalled(it.id) }
            val recalled=rows.filter { it.recalled }.map { it.id }.toSet()   // a banner never keeps a line taken back
            if(stamp!=epoch || !foreground) return
            if(messages.isNotEmpty()) update { val prior=chatNotices.find { it.id==win.id }?.messages.orEmpty().filterNot { it.id in recalled }; copy(chatNotices=(listOf(ChatNotice(win.id,win.name,(messages+prior).distinctBy { it.id }.sortedByDescending { it.seq }.take(24)))+chatNotices.filter { it.id!=win.id }).take(4)) }
        }
        if(stamp!=epoch || !chatVisible) return
        if(s.channel.text("rule_system")=="dnd2024") { val value=get(listOf("channels",s.channelId,"windows",s.windowId,"initiative")); if(stamp!=epoch) return; update { copy(initiative=value) } }
        val before=previous.campaign?.messages?.maxOfOrNull { it.seq }
        if(stamp!=epoch || !foreground || !chatVisible) return
        if(allowSpeech && s.readAloud && speechReady && before!=null) {
            speech.language=java.util.Locale.forLanguageTag(s.serverSettings.text("language"))
            s.campaign?.messages.orEmpty().filter { it.seq>before && it.authorId!=user && ReadAloud.speaks(it) && !wasRecalled(it.id) }.takeLast(5).forEach { speech.speak(it.displayText.take(1500),android.speech.tts.TextToSpeech.QUEUE_ADD,null,it.id) }
        }
        val seq=s.campaign?.messages?.maxOfOrNull { it.seq }
        if(seq!=null && seq>(readSeq[s.windowId] ?: -1) && s.windows.find { it.id==s.windowId }?.containsKey("unread")==true) {
            get(listOf("channels",s.channelId,"windows",s.windowId,"read"),buildJsonObject { put("seq",seq) }); if(stamp==epoch) readSeq[s.windowId]=seq
        }
    }
    private val sessionStore = SessionStore(application)
    var restartAccount: () -> Unit = {}
    private var retired = false
    private companion object { val parkedDrafts = mutableMapOf<String, Map<String, String>>() }
    fun selectAccount(id: String?) {
        if (retired || state.value.busy || id == session?.user?.id) return
        try { sessionStore.select(id) } catch (_: Exception) { notice(tr("无法读取已保存的登录，请重新登录")); return }
        rememberDraft()
        session?.user?.id?.let { parkedDrafts[it] = drafts.toMap() }
        stopRealtime()
        retired = true
        epoch++
        stopArtworkPrefetch(reset = true)
        session = null
        api = null
        clearAvatarImages()
        restartAccount()
    }
    // Downloaded media, one directory per account and server (core/AssetDiskCache.kt); deleted on sign-out.
    private val assetRoot = File(application.filesDir, "offline/assets")
    private fun assetsFor(endpoint: String, user: User) = AssetDiskCache(File(assetRoot, AssetDiskCache.hex("$endpoint|${user.id}")), legacyDir = File(getApplication<Application>().cacheDir, "assets/" + AssetDiskCache.hex("$endpoint|${user.id}")))
    private fun readsFor(endpoint: String, user: User) = AssetDiskCache(File(getApplication<Application>().filesDir, "offline/pages/" + AssetDiskCache.hex("$endpoint|${user.id}")), 64L * 1024 * 1024)
    init {
        update { copy(bannersEnabled=preferences.getBoolean("banners",true),readAloud=preferences.getBoolean("readAloud",false)) }
        MobileLocale.initialize(application)
        try {
            val roster = sessionStore.roster()
            update { copy(accountUsers = roster.accounts.map { it.session.user }) }
            roster.accounts.find { it.session.user.id == roster.active }?.let { saved ->
                drafts.putAll(parkedDrafts[saved.session.user.id].orEmpty())
                api = BackendClient(BackendAddress(ServiceConfiguration.BACKEND_ROOT, BuildConfig.DEBUG), assets = assetsFor(ServiceConfiguration.BACKEND_ROOT, saved.session.user), reads = readsFor(ServiceConfiguration.BACKEND_ROOT, saved.session.user)); session = saved.session
                saved.session.user.uiLanguage?.let { MobileLocale.set(it) }
                update { copy(user = saved.session.user, campaign = null, connection = "正在恢复登录…") }
            }
        } catch (_: Exception) { update { copy(notice = tr("无法读取已保存的登录，请重新登录")) } }
    }
    private fun update(block: AppState.() -> AppState) { mutableState.value = state.value.block() }
    fun draft(value: String) { update { copy(draft = value) }; typingSignal.edited(typingTarget(), value) }
    fun speechMode(value: String) { if (value in listOf("ic", "narration", "ooc")) update { copy(speechMode = value) } }
    fun removeReference(id: String) { update { copy(references = references.filterNot { it.id == id }) } }
    fun role(value: String) { update { copy(role = value) } }
    fun chooseRole(id: String) { if (id != state.value.characterId) typingSignal.lower(); update { copy(characterId = id, role = playable.find { it.id == id }?.name ?: if (gm) tr("旁白") else tr("场外"), diceHint = "") } }
    fun notice(value: String?) { update { copy(notice = value) } }
    fun result(value: String?) { update { copy(result = value, inspiration = if (value == null) null else inspiration) } }
    fun loadAsync(work: suspend () -> Unit) { viewModelScope.launch { load(work) } }
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
    suspend fun bytes(path: List<String>, query: Map<String, String> = emptyMap(), hash: String? = null) = client().bytes(path, token(), query, hash)
    suspend fun discardMessageImage(channel: String, message: String) { client().forgetMessageImage(channel, message) }
    suspend fun uploadModule(bytes: ByteArray, title: String): JsonObject = client().uploadModule(state.value.channelId, title, bytes, token())
    suspend fun uploadArtwork(bytes: ByteArray, character: String, slot: String, subtitle: String) = client().uploadCharacterAsset(state.value.channelId, character, slot, subtitle, bytes, token())
    fun login(username: String, password: String, registering: Boolean = false, displayName: String = "") = launch {
        histories.clear()
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
        client.assets = assetsFor(state.value.endpoint, auth.user); client.reads = readsFor(state.value.endpoint, auth.user)
        hypertext.reset()
        epoch++; api = client; session = auth; drafts.clear(); catalogUpdated = 0L
        auth.user.uiLanguage?.let { MobileLocale.set(it) }
        update { AppState(endpoint = endpoint, user = auth.user, busy = true, connection = "已连接") }
        try { sessionStore.save(SavedLogin(state.value.endpoint, auth)); val users = sessionStore.roster().accounts.map { it.session.user }; update { copy(accountUsers = users) } }
        catch (_: Exception) { notice(tr("登录成功，但设备未能安全保存登录状态")) }
        update { copy(busy = false) }
        restoreCachedCatalog()
        navigate { refreshCatalog(); refresh(metadata = false) }
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
    fun changeDiceDisplay(display: String) = launch {
        val auth = session ?: return@launch
        val value = get(listOf("auth", "me"), payload("dice_display" to display), "PUT")
        if (session?.token != auth.token) return@launch
        val user = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<User>(value)
        session = Session(auth.token, user); update { copy(user = user) }
        sessionStore.save(SavedLogin(ServiceConfiguration.BACKEND_ROOT, session!!))
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
        if (retired) return
        val id = session?.user?.id ?: return
        val others = state.value.accountUsers.filterNot { it.id == id }
        try { sessionStore.remove(id) } catch (_: Exception) { notice(tr("设备未能清除登录记录，请保持联网完成退出")); return }
        parkedDrafts.remove(id)
        stopRealtime()
        stopArtworkPrefetch(reset = true)
        val oldApi = api; val oldToken = session?.token
        hypertext.reset()
        epoch++; api = null; session = null; drafts.clear(); catalogUpdated = 0L
        update { AppState(connection = "已退出登录", accountUsers = others) }
        oldApi?.assets?.invalidate(); oldApi?.reads?.invalidate(); histories.clear(); navigationJob?.cancel(); clearAvatarImages(); ChatIllustrationImages.clear()
        if (oldApi != null && oldToken != null) kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { runCatching { oldApi.resource(listOf("auth", "logout"), oldToken, emptyObject) } }
        retired = true
        restartAccount()
    }
    private fun rememberDraft() { if (state.value.windowId.isNotEmpty()) drafts[state.value.windowId] = state.value.draft }
    private fun clearChannel() {
        stopArtworkPrefetch(reset = true)
        metadataJob?.cancel(); metadataJob=null; metadataGeneration++
        typingSignal.lower(); typingFlags.clear(); hypertext.reset()
        metadataUpdated=0L; failedPolls=0; nextPoll=0L; readSeq.clear(); speech.stop(); recallDeadlines.clear(); update { copy(typing=emptyMap(),inspiration=null,inspirationShown=emptyList(),recallDrafts=emptyMap(),chatNotices=emptyList(),initiative=emptyObject,speechMode = "ooc", references = emptyList(), jumpMessageId = null, channelId = "", windowId = "", characterId = "", channel = emptyObject, campaign = null, windows = emptyList(), characters = emptyList(), scenes = emptyList(), reminders = emptyList(), draft = "", diceHint = "", result = null, hasOlder = false) } }
    suspend fun selectServer(id: String) {
        if (id == state.value.serverId && state.value.channels.isNotEmpty() && state.value.channelId.isNotEmpty() && state.value.campaign != null) return
        rememberHistory()
        rememberDraft(); epoch++; val stamp = epoch; clearChannel()
        update { copy(serverId = id, serverSettings = emptyObject, channels = emptyList()) }
        restoreCachedServer(id, stamp)
        coroutineContext.ensureActive(); if (stamp != epoch) return
        val channels = rows(listOf("servers", id, "channels"))
        if (stamp != epoch) return
        update { copy(channels = channels) }
        (channels.find { it.id == state.value.channelId } ?: channels.firstOrNull())?.let { selectChannel(it.id) } ?: run { val settings=get(listOf("servers",id,"settings")); if(stamp==epoch) update { copy(serverSettings=settings) } }
    }
    suspend fun selectChannel(id: String) {
        if (id == state.value.channelId && state.value.channels.isNotEmpty() && state.value.windowId.isNotEmpty() && state.value.campaign != null) { refresh(metadata=false); return }
        rememberHistory()
        rememberDraft(); epoch++; val stamp = epoch; clearChannel(); update { copy(channelId = id) }
        restoreCachedChannel(id, stamp)
        coroutineContext.ensureActive(); if (stamp != epoch) return
        val info = get(listOf("channels", id)); val windows = rows(listOf("channels", id, "windows"))
        if (stamp != epoch) return
        if (state.value.channel.isNotEmpty() && permissionsDiffer(state.value.channel, state.value.windows, info, windows)) { purgeCachedAccess(); update { copy(campaign = null, characters = emptyList(), scenes = emptyList(), reminders = emptyList()) } }
        update { copy(channel = info, windows = windows) }
        chooseRole(state.value.playable.firstOrNull()?.id.orEmpty())
        (windows.find { it.id == state.value.windowId } ?: windows.firstOrNull())?.let { selectWindow(it.id) }
    }
    suspend fun selectWindow(id: String) {
        if (id == state.value.windowId && state.value.campaign != null) { refresh(true,metadata=false); return }
        rememberHistory()
        rememberDraft(); epoch++; typingSignal.lower()
        update { copy(inspiration = null, inspirationShown = emptyList(), speechMode = if (gm) "narration" else "ic", references = emptyList(), jumpMessageId = null, windowId = id, draft = drafts[id].orEmpty(), campaign = null, diceHint = "", result = null) }
        val stamp = epoch
        restoreCachedWindow(id, stamp)
        coroutineContext.ensureActive(); if (stamp != epoch) return
        rememberSelection()
        refresh(true,metadata=false)
    }
    private var navigationJob: Job? = null
    fun navigate(work: suspend () -> Unit) {
        navigationJob?.cancel()
        navigationJob = viewModelScope.launch { try { work() } catch (e: CancellationException) { throw e } catch (e: Exception) { handle(e, true) } }
    }
    suspend fun load(work: suspend () -> Unit) { try { work() } catch (e: CancellationException) { throw e } catch (e: Exception) { handle(e) } }
    suspend fun cached(path: List<String>, query: Map<String,String> = emptyMap()): JsonElement? {
        val auth = session?.token ?: return null
        val value = api?.cachedValue(path, query)
        coroutineContext.ensureActive()
        return if (session?.token == auth) value else null
    }
    private suspend fun cachedRows(path: List<String>) = (cached(path) as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
    private suspend fun rememberSelection() {
        val s = state.value; val store = api?.reads ?: return; val revision = store.generation(); val ticket = store.reserve("selection")
        withContext(Dispatchers.IO) { store.put("selection", payload("server" to s.serverId, "channel" to s.channelId, "window" to s.windowId).toString().toByteArray(), revision, ticket) }
    }
    private suspend fun restoreCachedCatalog() {
        if (state.value.serverId.isNotEmpty()) return
        val stamp = epoch
        val rows = cachedRows(listOf("servers"))
        val store = api?.reads
        val selection = withContext(Dispatchers.IO) { store?.get("selection")?.let { runCatching { Json.parseToJsonElement(it.toString(Charsets.UTF_8)) as? JsonObject }.getOrNull() } } ?: emptyObject
        if (stamp != epoch) return
        update { copy(servers = rows) }
        val server = rows.find { it.id == selection.text("server") } ?: rows.firstOrNull() ?: return
        update { copy(serverId = server.id) }
        restoreCachedServer(server.id, stamp, selection.text("channel"), selection.text("window"))
    }
    private suspend fun restoreCachedServer(id: String, stamp: Long, preferredChannel: String = "", preferredWindow: String = "") {
        val rows = cachedRows(listOf("servers",id,"channels")); val settings = cached(listOf("servers",id,"settings")) as? JsonObject ?: emptyObject
        if (stamp != epoch) return
        update { copy(channels = rows, serverSettings = settings) }
        (rows.find { it.id == preferredChannel } ?: rows.firstOrNull())?.let { update { copy(channelId = it.id) }; restoreCachedChannel(it.id, stamp, preferredWindow) }
    }
    private suspend fun restoreCachedChannel(id: String, stamp: Long, preferredWindow: String = "") {
        val info = cached(listOf("channels",id)) as? JsonObject ?: return
        val wins = cachedRows(listOf("channels",id,"windows")); val chars = cachedRows(listOf("channels",id,"characters"))
        val scenes = cachedRows(listOf("channels",id,"scenes")); val reminders = cachedRows(listOf("channels",id,"reminders"))
        if (stamp != epoch) return
        update { copy(channel = info, windows = wins, characters = chars, scenes = scenes, reminders = reminders) }
        chooseRole(state.value.playable.firstOrNull()?.id.orEmpty())
        (wins.find { it.id == preferredWindow } ?: wins.firstOrNull())?.let { win ->
            update { copy(windowId = win.id, draft = drafts[win.id].orEmpty(), speechMode = if(gm) "narration" else "ic") }
            restoreCachedWindow(win.id, stamp)
        }
    }
    private val histories = linkedMapOf<String, ChatHistory>()
    private fun rememberHistory() {
        val s = state.value; val view = s.campaign ?: return
        if (s.channelId.isEmpty() || s.windowId.isEmpty()) return
        val key = s.channelId + "|" + s.windowId; val snapshot = ChatHistory(view.messages, s.hasOlder)
        if (histories[key] == snapshot) return
        histories.remove(key); histories[key] = snapshot
        if (histories.size > 12) histories.remove(histories.keys.first())
        api?.keepHistory(snapshot, s.channelId, s.windowId)
    }
    private suspend fun restoreCachedWindow(id: String, stamp: Long) {
        val s = state.value; val key = s.channelId + "|" + id
        val saved = histories[key] ?: api?.cachedHistory(s.channelId, id) ?: kotlin.run {
            val rows = cached(listOf("channels",s.channelId,"windows",id,"messages"), mapOf("limit" to "50")) ?: return
            val messages = runCatching { Json { ignoreUnknownKeys = true }.decodeFromJsonElement<List<Message>>(rows) }.getOrNull() ?: return
            ChatHistory(messages, messages.size == 50)
        }
        if (stamp != epoch) return
        val messages = saved.messages.map { recalledMessages[it.id] ?: it }
        histories.remove(key); histories[key] = ChatHistory(messages, saved.hasOlder)
        if (histories.size > 12) histories.remove(histories.keys.first())
        update { copy(campaign = DemoCampaign(s.channel.name, s.windows.find { it.id == id }?.text("scene_title").orEmpty(), messages,emptyList(),emptyList(),emptyList()), hasOlder = saved.hasOlder) }
        if (s.gm) {
            val docs = cached(listOf("channels",s.channelId,"documents")) ?: JsonArray(emptyList())
            val hints = cached(listOf("channels",s.channelId,"highlights")) ?: JsonArray(emptyList())
            if (stamp != epoch) return
            val json = Json { ignoreUnknownKeys = true }
            update { copy(campaign = campaign?.copy(documents = json.decodeFromJsonElement(docs), highlights = json.decodeFromJsonElement(hints))) }
        }
    }
    private fun purgeCachedAccess() { hypertext.reset(); histories.clear(); stopArtworkPrefetch(reset = true); clearAvatarImages(); ChatIllustrationImages.clear(); update { copy(cacheRevision = cacheRevision + 1) }; api?.reads?.clear(); api?.assets?.clear() }
    private fun permissionsDiffer(old: JsonObject, oldWindows: List<JsonObject>, fresh: JsonObject, freshWindows: List<JsonObject>) =
        listOf("player_group_id","player_group_version","my_role","my_character_ids","knowledge_mode").any { old[it] != fresh[it] } || oldWindows.any { win -> freshWindows.find { it.id == win.id }?.get("members") != win["members"] }
    private var artworkPrefetcher = CharacterArtworkPrefetcher()
    private var artworkJob: Job? = null
    private var artworkGeneration = 0L
    private fun stopArtworkPrefetch(reset: Boolean = false) {
        artworkJob?.cancel(); artworkJob = null; artworkGeneration++
        if (reset) artworkPrefetcher = CharacterArtworkPrefetcher()
    }
    private fun scheduleArtworkPrefetch() {
        val s = state.value
        val client = api ?: return
        val token = session?.token ?: return
        if (!foreground || artworkJob != null || s.channelId.isEmpty() || s.characters.isEmpty()) return
        val worker = artworkPrefetcher
        val generation = ++artworkGeneration
        artworkJob = viewModelScope.launch {
            try { worker.warm(s.channelId, s.characters, client, token) }
            finally { if (generation == artworkGeneration) artworkJob = null }
        }
    }
    private var metadataJob: Job? = null
    private var metadataGeneration = 0L
    private var metadataUpdated = 0L
    private var failedPolls = 0
    private var nextPoll = 0L
    private suspend fun <T> auxiliary(cached:T,empty:T,work:suspend ()->T):T { return try { work() } catch(e:CancellationException) { throw e } catch(e:Exception) {
        if(e is BackendException && e.apiResponse) {
            if(e.status==401) throw e
            if(e.status in listOf(403,404)) return empty
        }
        update { copy(connection=tr("聊天已连接，部分内容暂未更新，将自动重试")) }
        cached
    } }
    suspend fun refresh(merge: Boolean = true, metadata:Boolean = true) {
        val s=state.value
        if(!s.online || s.windowId.isEmpty() || epoch in refreshing) return
        val stamp=epoch; refreshing.add(stamp)
        try {
            val (info,wins)=coroutineScope {
                val i=async { get(listOf("channels",s.channelId)) }
                val w=async { rows(listOf("channels",s.channelId,"windows")) }
                i.await() to w.await()
            }
            if(stamp!=epoch) return
            val isGM=info.text("my_role")=="gm"
            val permissionsChanged=s.channel["player_group_id"]!=info["player_group_id"] || s.channel["player_group_version"]!=info["player_group_version"] || s.channel["my_role"]!=info["my_role"] || s.channel["my_character_ids"]!=info["my_character_ids"] || s.channel["knowledge_mode"]!=info["knowledge_mode"] || s.windows.find { it.id==s.windowId }?.get("members")!=wins.find { it.id==s.windowId }?.get("members")
            if(permissionsChanged) {
                purgeCachedAccess()
                metadataJob?.cancel(); metadataJob=null; metadataGeneration++
                stopSpeech(); readSeq.clear()
                update { copy(campaign=null,characters=emptyList(),scenes=emptyList(),reminders=emptyList(),chatNotices=emptyList(),result=null,diceHint="",references=emptyList(),jumpMessageId=null,speechMode=if(s.channel["my_role"]!=info["my_role"]) if(isGM) "narration" else "ic" else speechMode) }
            }
            update { copy(channel=info,windows=wins) }
            var messages=client().messages(token(),s.channelId,s.windowId)
            if(stamp!=epoch) return
            val previous=if(merge&&!permissionsChanged) state.value.campaign?.messages.orEmpty() else emptyList()
            if(previous.isNotEmpty()&&messages.size==50) {
                val newest=previous.last().seq;var cursor=messages.minOf{it.seq};var count=50
                while(cursor>newest&&count==50) {
                    val page=client().messages(token(),s.channelId,s.windowId,cursor)
                    if(stamp!=epoch) return
                    val next=page.minOfOrNull{it.seq}?:cursor
                    if(next>=cursor) break
                    messages=page+messages;cursor=next;count=page.size
                }
            }
            recallDeadlines.note(messages)
            messages.filter { it.recalled }.forEach(::applyRecall)
            val old=state.value.campaign
            val incoming=messages;val recalled=recalledMessages
            val merged=withContext(Dispatchers.Default){ChatHistory.merge(previous,incoming,recalled)}
            if(stamp!=epoch) return
            val all=merged.map{recalledMessages[it.id]?:it}
            update { copy(campaign=DemoCampaign(info.name,wins.find { it.id==s.windowId }?.text("scene_title").orEmpty(),all,if(isGM) old?.documents.orEmpty() else emptyList(),if(isGM) old?.highlights.orEmpty() else emptyList(),emptyList()),channel=info,windows=wins,hasOlder=if(merge && !permissionsChanged && old!=null) hasOlder else messages.size==50,connection=if(pushConnected) "已连接 · 实时推送" else "已连接 · 自动刷新") }
            rememberHistory()
            // Optional metadata must never prevent authorized chat messages from appearing.
            if(metadata || permissionsChanged || (metadataJob==null && (metadataUpdated==0L || android.os.SystemClock.elapsedRealtime()-metadataUpdated>=30_000))) {
                metadataUpdated=android.os.SystemClock.elapsedRealtime()
                val current=state.value
                metadataJob?.cancel(); val generation=++metadataGeneration
                val updateMetadata: suspend ()->Unit = {
                coroutineScope {
                    val docs=async { auxiliary(current.campaign?.documents.orEmpty(),emptyList()) { if(isGM) client().documents(token(),s.channelId) else emptyList() } }
                    val hints=async { auxiliary(current.campaign?.highlights.orEmpty(),emptyList()) { if(isGM) client().highlights(token(),s.channelId) else emptyList() } }
                    val reminders=async { auxiliary(current.reminders,emptyList()) { rows(listOf("channels",s.channelId,"reminders")) } }
                    val settings=async { auxiliary(current.serverSettings,emptyObject) { get(listOf("servers",s.serverId,"settings")) } }
                    val chars=async { auxiliary(current.characters,emptyList()) { rows(listOf("channels",s.channelId,"characters")) } }
                    val scenes=async { auxiliary(current.scenes,emptyList()) { rows(listOf("channels",s.channelId,"scenes")) } }
                    val d=docs.await(); val h=hints.await(); val r=reminders.await(); val st=settings.await(); val c=chars.await(); val sc=scenes.await()
                    if(stamp==epoch && current.scopeKey==state.value.scopeKey) {
                        update { copy(campaign=campaign?.copy(documents=d,highlights=h),reminders=r,serverSettings=st,characters=c,scenes=sc) }
                        scheduleArtworkPrefetch()
                        if(state.value.characterId.isEmpty() && state.value.speechMode=="ic") state.value.playable.firstOrNull()?.let { chooseRole(it.id) }
                    }
                }
                }
                if(metadata) updateMetadata()
                else metadataJob=viewModelScope.launch {
                    try { updateMetadata() } catch(e:CancellationException) { throw e }
                    catch(e:Exception) { if(stamp==epoch && current.scopeKey==state.value.scopeKey) handle(e,true) }
                    finally { if(metadataGeneration==generation) metadataJob=null }
                }
            }
            if(stamp==epoch && state.value.characterId.isNotEmpty() && state.value.playable.none { it.id==state.value.characterId }) chooseRole("")
        } finally { refreshing.remove(stamp) }
    }
    suspend fun refreshCatalog() {
        if (!state.value.online) return
        val stamp = epoch
        val profile = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<User>(get(listOf("auth", "me")))
        val servers = rows(listOf("servers"))
        if (stamp != epoch) return
        val auth = session
        if (auth != null && profile.uiLanguage != null && (profile.uiLanguage != auth.user.uiLanguage || profile.avatarVersion != auth.user.avatarVersion || profile.hasAvatar != auth.user.hasAvatar || profile.displayName != auth.user.displayName || profile.atmosphereEnabled != auth.user.atmosphereEnabled || profile.diceDisplay != auth.user.diceDisplay)) {
            session = Session(auth.token, profile); update { copy(user = profile) }; MobileLocale.set(profile.uiLanguage)
            runCatching { sessionStore.save(SavedLogin(ServiceConfiguration.BACKEND_ROOT, session!!)) }
        }
        update { copy(servers = servers) }
        if (servers.none { it.id == state.value.serverId }) {
            if(state.value.serverId.isNotEmpty()) purgeCachedAccess()
            epoch++; clearChannel(); update { copy(serverId = "", channels = emptyList(), serverSettings = emptyObject) }
            servers.firstOrNull()?.let { selectServer(it.id) }
        } else {
            val channels = rows(listOf("servers", state.value.serverId, "channels"))
            val settings = get(listOf("servers", state.value.serverId, "settings"))
            if (stamp != epoch) return
            update { copy(channels = channels, serverSettings = settings) }
            if (channels.none { it.id == state.value.channelId }) {
                if(state.value.channelId.isNotEmpty()) purgeCachedAccess()
                epoch++; clearChannel(); channels.firstOrNull()?.let { selectChannel(it.id) }
            } else if (state.value.windowId.isEmpty()) selectChannel(state.value.channelId)
        }
        catalogUpdated = android.os.SystemClock.elapsedRealtime()
    }
    suspend fun poll(forceCatalog: Boolean = false) {
        if (!state.value.online || state.value.busy || polling || (!forceCatalog && android.os.SystemClock.elapsedRealtime()<nextPoll)) return
        polling = true; pushPending = false   // a push arriving from here on wakes the loop again
        val token = session?.token
        val previous=state.value; val stamp=epoch
        try {
            restoreCachedCatalog()
            var catalogDeferred=false
            if (forceCatalog || catalogUpdated == 0L || android.os.SystemClock.elapsedRealtime() - catalogUpdated >= 30_000) {
                try { refreshCatalog() } catch(e:CancellationException) { throw e } catch(e:Exception) {
                    if(state.value.windowId.isEmpty() || (e is BackendException && e.apiResponse && e.status==401)) throw e
                    catalogUpdated=android.os.SystemClock.elapsedRealtime(); catalogDeferred=true
                }
            }
            refresh(metadata=false)
            failedPolls=0; nextPoll=0L
            if(previous.scopeKey == state.value.scopeKey) auxiliary(Unit,Unit) { updateActivity(previous,stamp,!forceCatalog) }
            if(catalogDeferred) update { copy(connection=tr("聊天已连接，部分内容暂未更新，将自动重试")) }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (session?.token == token) { failedPolls=minOf(4,failedPolls+1); nextPoll=android.os.SystemClock.elapsedRealtime()+minOf(30_000L,4_000L shl failedPolls); handle(e, true) } }
        finally { polling = false }
    }
    fun older() = launch {
        val s = state.value; val before = s.campaign?.messages?.firstOrNull()?.seq ?: return@launch; val stamp = epoch
        val messages = client().messages(token(), s.channelId, s.windowId, before)
        if (stamp == epoch) messages.filter { it.recalled }.forEach(::applyRecall)
        if (stamp == epoch) update { copy(campaign = campaign?.copy(messages = (messages + campaign.messages).map { recalledMessages[it.id] ?: it }.distinctBy { it.id }.sortedBy { it.seq }), hasOlder = messages.size == 50) }
        if (stamp == epoch) rememberHistory()
    }
    suspend fun openEvidence(event: JsonObject, quote: Boolean) {
        val s = state.value; val stamp = epoch
        val message = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<Message>(get(listOf("channels", s.channelId, "messages", event.text("message_id"))))
        if (stamp != epoch) return
        if (message.recalled || wasRecalled(message.id)) return
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
        update { copy(draft = if (draft.trim() == text) "" else draft, diceHint = "", references = emptyList()) }; refreshSoon()
        if (state.value.draft.isBlank()) typingSignal.lower()   // the line is out: the pen goes down with it
    }
    private fun refreshSoon() {
        val stamp = epoch
        viewModelScope.launch { if(stamp != epoch) return@launch; try { refresh(metadata = false) } catch(e:CancellationException) { throw e } catch(e:Exception) { if(stamp == epoch) handle(e, true) } }
    }
    fun assistance(type: String) {
        if (!state.value.enabled(type) || state.value.windowId.isEmpty()) return
        if (type == "consistency" && state.value.draft.isBlank()) return
        if (!state.value.online) { notice(tr("请先在设置中连接服务器")); return }
        launch {
            val s = state.value; val stamp = epoch
            if (type == "consistency" && s.draft.isBlank()) return@launch
            val body = buildJsonObject { put("chat_window_id", s.windowId); if (s.characterId.isNotEmpty()) put("character_id", s.characterId); put(if (type == "consistency") "draft" else "hint", s.draft) }
            val v = get(listOf("channels", s.channelId, type), body)
            if (stamp != epoch) return@launch
            if (type == "inspiration") { update { copy(result = v.text("draft"), resultType = type, inspiration = v, inspirationShown = Inspiration.shown(emptyList(), v)) }; return@launch }
            val result = (if (v.flag("insufficient_evidence")) tr("证据不足") else v.text("score_label")) + "\n\n" + v.text("rationale") + "\n\n证据与冲突\n" + v.rows("evidence").joinToString("\n\n") { it.text("summary") + "\n" + it.text("scene_title") } + "\n" + v.rows("conflicts").joinToString("\n") { it.text("description") }
            update { copy(result = result, resultType = type, inspiration = null) }
        }
    }
    /** Three other ways to play the moment: everything shown so far goes along as `avoid` (docs/API.md). */
    fun anotherTake() = launch {
        val s = state.value; val stamp = epoch; val shown = s.inspirationShown
        val current = s.inspiration ?: return@launch
        if (s.windowId.isEmpty() || !s.enabled("inspiration")) return@launch
        val character = current.text("character_id").ifEmpty { s.characterId }
        val body = buildJsonObject {
            put("chat_window_id", s.windowId); if (character.isNotEmpty()) put("character_id", character)
            put("hint", s.draft); put("variant", shown.size); put("avoid", JsonArray(shown.map { JsonPrimitive(it) }))
        }
        val v = get(listOf("channels", s.channelId, "inspiration"), body)
        if (stamp != epoch || state.value.inspiration == null) return@launch   // closed meanwhile
        update { copy(result = v.text("draft"), resultType = "inspiration", inspiration = v, inspirationShown = Inspiration.shown(shown, v)) }
    }
    /** Puts an Inspiration line, or the roll that goes with it, into the composer. Nothing is sent. */
    fun adopt(text: String) { if (text.isBlank()) return; draft(state.value.draft + (if (state.value.draft.isEmpty()) "" else "\n") + text); result(null) }
    // ---- pinned lines (docs/API.md): a member keeps a chat line among their group's hints until its pinner or the GM
    // takes it down. The list is read again after either, so a new pin comes with its pinner's name.
    fun pin(m: Message) = launch {
        val s = state.value; val stamp = epoch
        get(listOf("channels", s.channelId, "messages", m.id, "pin"), emptyObject)
        reloadReminders(s, stamp)
    }
    fun unpin(reminderId: String) = launch {
        val s = state.value; val stamp = epoch
        get(listOf("channels", s.channelId, "reminders", reminderId), method = "DELETE")
        reloadReminders(s, stamp)
    }
    private suspend fun reloadReminders(s: AppState, stamp: Long) {
        val fresh = rows(listOf("channels", s.channelId, "reminders"))
        if (stamp == epoch && s.scopeKey == state.value.scopeKey) update { copy(reminders = fresh) }
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
        if (ConnectionPolicy.invalidatesSession(e)) { logout(); notice(tr("登录已过期，请重新登录")); return }
        if (e is BackendException && e.apiResponse && e.status in listOf(403, 404) && silent) { purgeCachedAccess(); epoch++; clearChannel(); catalogUpdated = 0L }
        val message = if (e is BackendException && !e.apiResponse) tr("服务入口暂时不可用，请稍后重试")+" (HTTP ${e.status})" else if (e is BackendException || e is IllegalArgumentException) e.message ?: "请求失败" else tr(ConnectionPolicy.message(e))
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
