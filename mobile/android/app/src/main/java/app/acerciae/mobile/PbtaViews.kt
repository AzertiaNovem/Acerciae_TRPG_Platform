package app.acerciae.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
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
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun PbtaSheetEditor(card: JsonObject, rules: JsonObject, characterId: String, editable: Boolean, dirty: Boolean, state: AppState, model: AppViewModel, change: (JsonObject) -> Unit) {
    val pack = rules.obj("pack"); val sheet = card.obj("pbta")
    val window = state.windows.find { it.id == state.windowId }
    val canSpeak = window != null && (state.gm || window.rows("members").any { it.text("user_id") == state.user?.id })
    var bonus by remember { mutableStateOf("0") }; var status by remember { mutableStateOf("") }; var acting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun set(key: String, value: JsonElement) { change(JsonObject(card + ("pbta" to JsonObject(sheet + (key to value))))) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(pack.name + " · PbtA", style = MaterialTheme.typography.titleMedium)
        Choice(tr("Playbook"), sheet.text("book"), listOf("" to tr("Choose a playbook")) + pack.rows("books").map { it.id to it.name }, editable) { set("book",JsonPrimitive(it)) }
        listOf("stats" to "Stats","resources" to "Resources and experience","conditions" to "Conditions").forEach { (group,label) ->
            Text(tr(label),style=MaterialTheme.typography.titleSmall)
            pack.rows(group).forEach { definition ->
                if(group == "conditions") SettingToggle(definition.name,sheet.obj(group).flag(definition.id),editable) { on ->
                    val values = sheet.obj(group).toMutableMap(); if(on) values[definition.id] = JsonPrimitive(true) else values.remove(definition.id); set(group,JsonObject(values))
                } else OutlinedTextField((sheet.obj(group)[definition.id] as? JsonPrimitive)?.content.orEmpty(), { text ->
                    val values=sheet.obj(group).toMutableMap()
                    if(text.isEmpty()) values.remove(definition.id) else values[definition.id]=text.toIntOrNull()?.takeIf { it in -9999..9999 }?.let { JsonPrimitive(it) } ?: JsonPrimitive(text)
                    set(group,JsonObject(values))
                },label={Text(definition.name)},enabled=editable)
            }
        }
        Text(tr("Moves"),style=MaterialTheme.typography.titleSmall)
        if(editable) OutlinedTextField(bonus,{v->if(v.isEmpty()||v=="-"||v.toIntOrNull()?.let { it in -99..99 }==true) bonus=v},label={Text(tr("Move modifier"))})
        if(dirty) Text(tr("Save the sheet to use a move."),style=MaterialTheme.typography.bodySmall)
        Pbta.moves(pack,sheet).forEach { move ->
            var expanded by remember(move.id) { mutableStateOf(false) }
            TextButton(onClick={expanded=!expanded}) { Text(move.name + if(expanded) " −" else " +") }
            if(expanded) {
                Text(move.text("trigger"))
                if(move.text("stat").isNotEmpty()) {
                    Text("2d6 + " + (pack.rows("stats").find { it.id==move.text("stat") }?.name ?: move.text("stat")) + " (${sheet.obj("stats").number(move.text("stat"))})")
                    pack.rows("bands").forEach { Text(it.name + " · " + move.obj("outcomes").text(it.id),style=MaterialTheme.typography.bodySmall) }
                }
                if(editable) Button(onClick={
                    if(!canSpeak || dirty || acting) return@Button
                    acting=true
                    scope.launch {
                        try {
                            val result=model.get(listOf("channels",state.channelId,"windows",state.windowId,"messages"),Pbta.moveBody(characterId,move,bonus.toIntOrNull()?:0))
                            if(state.scopeKey==model.state.value.scopeKey) { status=result.obj("dice").text("text").ifEmpty { tr("Sent to {window}").replace("{window}",window?.name.orEmpty()) }; model.refresh() }
                        } catch(e:CancellationException) { throw e } catch(e:Exception) { status=e.localizedMessage.orEmpty() } finally { acting=false }
                    }
                },enabled=!dirty&&!acting&&canSpeak&&state.enabled("dice")&&bonus.toIntOrNull()!=null&&Pbta.validSheet(sheet,pack)) { Text(tr(if(move.text("stat").isEmpty()) "Use move" else "Roll dice")+" · "+(window?.name?:tr("Choose a chat window"))) }
            }
        }
        if(status.isNotEmpty()) Text(status)
        if(pack.rows("gmMoves").isNotEmpty()) {
            var open by remember { mutableStateOf(false) }
            TextButton(onClick={open=!open}) { Text(tr("GM reference moves")) }
            if(open) pack.rows("gmMoves").forEach { Text(it.name+" · "+it.text("text")) }
        }
    }
}

private val packGroups=listOf("stats" to "Stats","books" to "Playbooks","resources" to "Resources and experience","conditions" to "Conditions","bands" to "Outcome bands","moves" to "Player moves","gmMoves" to "GM reference moves")

@Composable fun PbtaRulesScreen(state:AppState,model:AppViewModel,close:()->Unit) {
    var rules by remember(state.channelId) { mutableStateOf(JsonObject(emptyMap())) }
    var review by remember(state.channelId) { mutableStateOf(JsonObject(emptyMap())) }
    var pack by remember(state.channelId) { mutableStateOf(JsonObject(emptyMap())) }
    var dirty by remember(state.channelId) { mutableStateOf(false) }; var compared by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }; var discard by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Pair<String,Int>?>(null) }
    val base=listOf("channels",state.channelId,"pbta"); val pending=review.text("status")=="pending"
    val scope=rememberCoroutineScope(); val lifecycle=LocalLifecycleOwner.current.lifecycle
    fun show(saved:JsonObject,draft:JsonObject) { rules=saved;review=draft;pack=if(draft.text("status")=="pending") draft.obj("pack") else saved.obj("pack");dirty=false;compared=false }
    suspend fun reload(force:Boolean=false) {
        try { val saved=model.get(base); val draft=model.get(base+"draft"); if(!force&&dirty){status=tr("Reload saved version");return};show(saved,draft);status="" }
        catch(e:CancellationException){throw e} catch(e:Exception){status=e.localizedMessage.orEmpty()}
    }
    fun decision(op:String) = model.launch {
        model.get(base+"draft",buildJsonObject { put("op",op);put("version",review["version"]?:JsonPrimitive(0));put("revision",rules["revision"]?:JsonPrimitive(0));put("reviewed_changes",compared);put("pack",pack) });reload(true)
    }
    LaunchedEffect(state.scopeKey,lifecycle) {
        if(!state.gm) return@LaunchedEffect
        (model.cached(base) as? JsonObject)?.let { rules=it;pack=it.obj("pack") }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if(!dirty) reload()
            while(true) { delay(8000); if(!dirty&&!model.state.value.busy&&review.text("status") !in listOf("active","kept","none")) reload() }
        }
    }
    BackHandler { if(editing!=null) editing=null else close() }
    if(!state.gm) { Text(tr("仅当前频道的 GM 可访问"));return }
    editing?.let { (group,index) -> PbtaRuleEntry(pack,group,index,state.busy,{pack=it;dirty=true}) { editing=null };return }
    if(discard) AlertDialog(onDismissRequest={discard=false},title={Text(tr("Discard draft and reload character card?"))},confirmButton={TextButton(onClick={discard=false;scope.launch { reload(true) }}){Text(tr("Reload saved version"))}},dismissButton={TextButton(onClick={discard=false}){Text(tr("Cancel"))}})
    Column(Modifier.fillMaxSize()) {
        TextButton(onClick=close){Text(tr("Back"))}
        LazyColumn(Modifier.weight(1f).padding(horizontal=20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            item { Text(tr("Rule pack"),style=MaterialTheme.typography.titleLarge) }
            if(pack.isEmpty()) item { CircularProgressIndicator();TextButton(onClick={scope.launch { reload() }}){Text(tr("Reload rules"))} }
            else {
                item { OutlinedTextField(pack.name,{pack=JsonObject(pack+("name" to JsonPrimitive(it)));dirty=true},label={Text(tr("Name"))},enabled=!state.busy);Text("v${rules.number("revision")} · PbtA") }
                if(review.text("status") in listOf("designing","failed","retry","pending")) item {
                    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
                        Text(tr("World rule draft"),style=MaterialTheme.typography.titleMedium)
                        if(review.text("status")=="designing") Text(tr("Design in progress"))
                        if(review.text("status")=="retry") Text(tr("Run setup again for this channel."))
                        if(review.text("error").isNotEmpty()) Text(review.text("error"))
                        (review["reasons"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content) }
                        if(pending) {
                            var compare by remember { mutableStateOf(false) }
                            TextButton(onClick={compare=!compare}){Text(tr("Compare current rules"))}
                            if(compare) PbtaPackSummary(rules.obj("pack"))
                            if(review["base_revision"]!=rules["revision"]) SettingToggle(tr("I compared the newer official rules"),compared,!state.busy){compared=it}
                            Button(onClick={decision("activate")},enabled=!state.busy&&(review["base_revision"]==rules["revision"]||compared)){Text(tr("Activate draft"))}
                        }
                        if(review.text("status") in listOf("designing","failed")) TextButton(onClick={decision("retry")},enabled=!state.busy){Text(tr("Retry design"))}
                        TextButton(onClick={decision("keep")},enabled=!state.busy){Text(tr("Keep current rules"))}
                    }
                }
                packGroups.forEach { (group,label) ->
                    item { Text(tr(label),style=MaterialTheme.typography.titleMedium) }
                    items(pack.rows(group).indices.toList(),key={"$group:$it"}) { index -> TextButton(onClick={editing=group to index},enabled=!state.busy){Text(pack.rows(group)[index].name)} }
                    if(group!="bands") item { TextButton(onClick={
                        val entry=buildJsonObject {
                            put("id",group.lowercase()+"_"+java.util.UUID.randomUUID().toString().take(8));put("name",tr("New entry"))
                            if(group=="moves") {put("book","");put("stat","");put("trigger","");put("outcomes",buildJsonObject{pack.rows("bands").forEach{put(it.id,"")}})}
                            if(group=="gmMoves") put("text","")
                        };pack=JsonObject(pack+(group to JsonArray(pack.rows(group)+entry)));dirty=true
                    },enabled=!state.busy){Text(tr("Add"))} }
                }
                item { Button(onClick={if(pending) decision("edit") else model.launch { val saved=model.get(base,buildJsonObject{put("revision",rules["revision"]?:JsonPrimitive(0));put("pack",pack)},"PUT");show(saved,review);status=tr("Rule pack saved") }},enabled=dirty&&!state.busy){Text(tr(if(pending) "Save draft" else "Save rule pack"))} }
                item { TextButton(onClick={if(dirty) discard=true else scope.launch{reload()}},enabled=!state.busy){Text(tr("Reload saved version"))} }
            }
            if(status.isNotEmpty()) item { Text(status) }
        }
    }
}

@Composable private fun PbtaPackSummary(pack:JsonObject) {
    packGroups.forEach { (group,label) ->
        var open by remember(group){mutableStateOf(false)}
        TextButton(onClick={open=!open}){Text(tr(label))}
        if(open) pack.rows(group).forEach{row->
            Text(row.name)
            if(group=="moves"){Text(row.text("trigger"));pack.rows("bands").forEach{Text(it.name+" · "+row.obj("outcomes").text(it.id))}}
            if(group=="gmMoves") Text(row.text("text"))
        }
    }
}
@Composable private fun PbtaRuleEntry(pack:JsonObject,group:String,index:Int,busy:Boolean,change:(JsonObject)->Unit,close:()->Unit) {
    val entry=pack.rows(group).getOrNull(index)?:return
    fun set(key:String,value:JsonElement){val rows=pack.rows(group).toMutableList();rows[index]=JsonObject(entry+(key to value));change(JsonObject(pack+(group to JsonArray(rows))))}
    Column {
        TextButton(onClick=close){Text(tr("Back"))}
        LazyColumn(Modifier.weight(1f).padding(horizontal=20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            item{OutlinedTextField(entry.name,{set("name",JsonPrimitive(it))},label={Text(tr("Name"))},enabled=!busy);OutlinedTextField(entry.id,{set("id",JsonPrimitive(it))},label={Text("ID")},enabled=!busy)}
            if(group=="bands") items(listOf("min","max")){key->OutlinedTextField((entry[key] as? JsonPrimitive)?.contentOrNull.orEmpty(),{v->if(v.isEmpty())set(key,JsonNull)else v.toIntOrNull()?.let{set(key,JsonPrimitive(it))}},label={Text(tr(if(key=="min")"Minimum" else "Maximum"))},enabled=!busy)}
            if(group=="gmMoves") item{OutlinedTextField(entry.text("text"),{set("text",JsonPrimitive(it))},label={Text(tr("Text"))},enabled=!busy)}
            if(group=="moves") {
                item{OutlinedTextField(entry.text("trigger"),{set("trigger",JsonPrimitive(it))},label={Text(tr("Trigger"))},enabled=!busy)}
                item{Choice(tr("Playbook"),entry.text("book"),listOf("" to tr("All"))+pack.rows("books").map{it.id to it.name},!busy){set("book",JsonPrimitive(it))}}
                item{Choice(tr("Stat"),entry.text("stat"),listOf("" to tr("Diceless"))+pack.rows("stats").map{it.id to it.name},!busy){set("stat",JsonPrimitive(it))}}
                items(pack.rows("bands"),key={it.id}){band->OutlinedTextField(entry.obj("outcomes").text(band.id),{v->set("outcomes",JsonObject(entry.obj("outcomes")+(band.id to JsonPrimitive(v))))},label={Text(band.name)},enabled=!busy)}
                items(if(entry.text("stat").isEmpty())listOf(payload("id" to "no_roll","name" to tr("Diceless")))else pack.rows("bands"),key={"choice:"+it.id}){band->
                    val choices=(entry["playerChoiceBands"] as? JsonArray).orEmpty()
                    SettingToggle(band.name+" · "+tr("Player choice"),JsonPrimitive(band.id) in choices,!busy){on->set("playerChoiceBands",JsonArray(choices.filter{it!=JsonPrimitive(band.id)}+if(on)listOf(JsonPrimitive(band.id))else emptyList()))}
                }
            }
            if(group!="bands") item{TextButton(onClick={val a=pack.rows(group).toMutableList();a.removeAt(index);change(JsonObject(pack+(group to JsonArray(a))));close()},enabled=!busy){Text(tr("Delete"))}}
        }
    }
}
