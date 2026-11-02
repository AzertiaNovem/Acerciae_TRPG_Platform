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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

private val emptyObject = JsonObject(emptyMap())
data class AppState(
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
        set(value) { field=value; if(!value) { metadataJob?.cancel(); metadataJob=null; metadataGeneration++; metadataUpdated=0L } }
    var chatVisible = false
    private val readSeq = mutableMapOf<String,Long>()
    private val preferences = application.getSharedPreferences("chat-activity",0)
    private var speechReady = false
    private val speech = android.speech.tts.TextToSpeech(application) { speechReady = it == android.speech.tts.TextToSpeech.SUCCESS }
    fun stopSpeech() { speech.stop() }
    override fun onCleared() { speech.stop(); speech.shutdown(); super.onCleared() }
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
            val messages=client().messages(token(),s.channelId,win.id).filter { it.seq>old && it.authorId!=user }
            if(stamp!=epoch || !foreground) return
            if(messages.isNotEmpty()) update { val prior=chatNotices.find { it.id==win.id }?.messages.orEmpty(); copy(chatNotices=(listOf(ChatNotice(win.id,win.name,(messages+prior).distinctBy { it.id }.sortedByDescending { it.seq }.take(24)))+chatNotices.filter { it.id!=win.id }).take(4)) }
        }
        if(stamp!=epoch || !chatVisible) return
        if(s.channel.text("rule_system")=="dnd2024") { val value=get(listOf("channels",s.channelId,"windows",s.windowId,"initiative")); if(stamp!=epoch) return; update { copy(initiative=value) } }
        val before=previous.campaign?.messages?.maxOfOrNull { it.seq }
        if(stamp!=epoch || !foreground || !chatVisible) return
        if(allowSpeech && s.readAloud && speechReady && before!=null) {
            speech.language=java.util.Locale.forLanguageTag(s.serverSettings.text("language"))
            s.campaign?.messages.orEmpty().filter { it.seq>before && it.authorId!=user && it.kind!="system" }.takeLast(5).forEach { speech.speak(it.displayText.take(1500),android.speech.tts.TextToSpeech.QUEUE_ADD,null,it.id) }
        }
        val seq=s.campaign?.messages?.maxOfOrNull { it.seq }
        if(seq!=null && seq>(readSeq[s.windowId] ?: -1) && s.windows.find { it.id==s.windowId }?.containsKey("unread")==true) {
            get(listOf("channels",s.channelId,"windows",s.windowId,"read"),buildJsonObject { put("seq",seq) }); if(stamp==epoch) readSeq[s.windowId]=seq
        }
    }
    private val sessionStore = SessionStore(application)
    // Downloaded media, one directory per account and server (core/AssetDiskCache.kt); deleted on sign-out.
    private val assetRoot = File(application.filesDir, "offline/assets")
    private fun assetsFor(endpoint: String, user: User) = AssetDiskCache(File(assetRoot, AssetDiskCache.hex("$endpoint|${user.id}")), legacyDir = File(getApplication<Application>().cacheDir, "assets/" + AssetDiskCache.hex("$endpoint|${user.id}")))
    private fun readsFor(endpoint: String, user: User) = AssetDiskCache(File(getApplication<Application>().filesDir, "offline/pages/" + AssetDiskCache.hex("$endpoint|${user.id}")), 64L * 1024 * 1024)
    init {
        update { copy(bannersEnabled=preferences.getBoolean("banners",true),readAloud=preferences.getBoolean("readAloud",false)) }
        MobileLocale.initialize(application)
        try {
            sessionStore.read()?.let { saved ->
                if (!ServiceConfiguration.acceptsSavedEndpoint(saved.endpoint)) { sessionStore.clear(); return@let }
                api = BackendClient(BackendAddress(ServiceConfiguration.BACKEND_ROOT, BuildConfig.DEBUG), assets = assetsFor(ServiceConfiguration.BACKEND_ROOT, saved.session.user), reads = readsFor(ServiceConfiguration.BACKEND_ROOT, saved.session.user)); session = saved.session
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
    suspend fun uploadModule(bytes: ByteArray, title: String): JsonObject = client().uploadModule(state.value.channelId, title, bytes, token())
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
        client.assets = assetsFor(state.value.endpoint, auth.user); client.reads = readsFor(state.value.endpoint, auth.user)
        epoch++; api = client; session = auth; drafts.clear(); catalogUpdated = 0L
        auth.user.uiLanguage?.let { MobileLocale.set(it) }
        update { AppState(endpoint = endpoint, user = auth.user, busy = true, connection = "已连接") }
        try { sessionStore.save(SavedLogin(state.value.endpoint, auth)) }
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
        oldApi?.assets?.invalidate(); oldApi?.reads?.invalidate(); navigationJob?.cancel(); clearAvatarImages()
        if (oldApi != null && oldToken != null) viewModelScope.launch { runCatching { oldApi.resource(listOf("auth", "logout"), oldToken, emptyObject) } }
    }
    private fun rememberDraft() { if (state.value.windowId.isNotEmpty()) drafts[state.value.windowId] = state.value.draft }
    private fun clearChannel() {
        metadataJob?.cancel(); metadataJob=null; metadataGeneration++
        metadataUpdated=0L; failedPolls=0; nextPoll=0L; readSeq.clear(); speech.stop(); update { copy(chatNotices=emptyList(),initiative=emptyObject,speechMode = "ooc", references = emptyList(), jumpMessageId = null, channelId = "", windowId = "", characterId = "", channel = emptyObject, campaign = null, windows = emptyList(), characters = emptyList(), scenes = emptyList(), reminders = emptyList(), draft = "", diceHint = "", result = null, hasOlder = false) } }
    suspend fun selectServer(id: String) {
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
        rememberDraft(); epoch++
        update { copy(speechMode = if (gm) "narration" else "ic", references = emptyList(), jumpMessageId = null, windowId = id, draft = drafts[id].orEmpty(), campaign = null, diceHint = "", result = null) }
        val stamp = epoch
        restoreCachedWindow(id, stamp)
        coroutineContext.ensureActive(); if (stamp != epoch) return
        rememberSelection()
        refresh(false,metadata=false)
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
    private suspend fun restoreCachedWindow(id: String, stamp: Long) {
        val s = state.value
        val messages = cached(listOf("channels",s.channelId,"windows",id,"messages"), mapOf("limit" to "50")) ?: return
        val docs = cached(listOf("channels",s.channelId,"documents")) ?: JsonArray(emptyList())
        val hints = cached(listOf("channels",s.channelId,"highlights")) ?: JsonArray(emptyList())
        if (stamp != epoch) return
        val campaign = runCatching { Json { ignoreUnknownKeys = true }.decodeFromJsonElement<DemoCampaign>(buildJsonObject {
            put("title", s.channel.name); put("scene", s.windows.find { it.id == id }?.text("scene_title").orEmpty()); put("messages", messages)
            put("documents", if(s.gm) docs else JsonArray(emptyList())); put("highlights", if(s.gm) hints else JsonArray(emptyList())); put("replay", JsonArray(emptyList()))
        }) }.getOrNull() ?: return
        update { copy(campaign = campaign, hasOlder = campaign.messages.size == 50) }
    }
    private fun purgeCachedAccess() { clearAvatarImages(); update { copy(cacheRevision = cacheRevision + 1) }; api?.reads?.clear(); api?.assets?.clear() }
    private fun permissionsDiffer(old: JsonObject, oldWindows: List<JsonObject>, fresh: JsonObject, freshWindows: List<JsonObject>) =
        listOf("player_group_id","player_group_version","my_role","my_character_ids","knowledge_mode").any { old[it] != fresh[it] } || oldWindows.any { win -> freshWindows.find { it.id == win.id }?.get("members") != win["members"] }
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
            val messages=client().messages(token(),s.channelId,s.windowId)
            if(stamp!=epoch) return
            val old=state.value.campaign
            val all=((if(merge && !permissionsChanged) old?.messages.orEmpty() else emptyList())+messages).associateBy { it.id }.values.sortedBy { it.seq }
            update { copy(campaign=DemoCampaign(info.name,wins.find { it.id==s.windowId }?.text("scene_title").orEmpty(),all,if(isGM) old?.documents.orEmpty() else emptyList(),if(isGM) old?.highlights.orEmpty() else emptyList(),emptyList()),channel=info,windows=wins,hasOlder=if(merge && !permissionsChanged) hasOlder else messages.size==50,connection="已连接 · 自动刷新") }
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
        if (auth != null && profile.uiLanguage != null && (profile.uiLanguage != auth.user.uiLanguage || profile.avatarVersion != auth.user.avatarVersion || profile.hasAvatar != auth.user.hasAvatar || profile.displayName != auth.user.displayName || profile.atmosphereEnabled != auth.user.atmosphereEnabled)) {
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
        polling = true
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
        update { copy(draft = if (draft.trim() == text) "" else draft, diceHint = "", references = emptyList()) }; refreshSoon()
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
        if (e is BackendException && e.apiResponse && e.status == 401) { logout(); notice(tr("登录已过期，请重新登录")); return }
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
