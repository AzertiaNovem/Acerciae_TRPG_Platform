package app.acerciae.mobile
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.*

@Composable fun DndCardEditor(card: JsonObject, rules: JsonObject, editable: Boolean, gm: Boolean, points: Boolean, language: String, change: (JsonObject) -> Unit) {
    val abilities = listOf("STR", "DEX", "CON", "INT", "WIS", "CHA")
    val d = card["dnd"] as? JsonObject ?: buildJsonObject { put("level",1); put("method","point_buy"); put("ac",10); put("speed",30); put("base",buildJsonObject { abilities.forEach { put(it,8) } }) }
    fun set(key: String, value: JsonElement, group: String = "") {
        val fields = if(group.isEmpty()) JsonObject(d + (key to value)) else JsonObject(d + (group to JsonObject(d.obj(group).toMutableMap().apply { if(value == JsonNull) remove(key) else put(key,value) })))
        change(JsonObject(card + ("dnd" to fields)))
    }
    fun local(v: JsonObject) = v.obj("names").text(language).ifEmpty { v.name }
    @Composable fun num(key: String, label: String, group: String = "", allow: Boolean = editable, optional: Boolean = false) {
        val v = if(group.isEmpty()) d[key] else d.obj(group)[key]
        OutlinedTextField((v as? JsonPrimitive)?.contentOrNull ?: if(optional) "" else "0", { s -> if(optional && s.isEmpty()) set(key,JsonNull,group) else s.toIntOrNull()?.takeIf { it in -999..9999 }?.let { set(key,JsonPrimitive(it),group) } }, label = { Text(label) }, enabled = allow, modifier = Modifier.fillMaxWidth())
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("D&D 2024 · SRD 5.2", style = MaterialTheme.typography.titleMedium)
        listOf("class" to "classes", "species" to "species", "background" to "backgrounds").forEach { (key, collection) ->
            ChoiceMenu(tr(key), d.text(key), listOf("" to tr("— choose —")) + rules.rows(collection).map { it.name to local(it) }) { value -> if(editable) {
                val fields=d.toMutableMap(); fields[key]=JsonPrimitive(value)
                val selected=rules.rows(collection).find { it.name==value }
                if(selected!=null) when(key) {
                    "class" -> { if(selected.text("caster")=="none") fields["spellcasting_ability"]=JsonPrimitive(""); fields["saves"]=selected["saves"] ?: JsonArray(emptyList()); fields["hit_dice"]=JsonPrimitive("${maxOf(1,d.number("level"))}d${selected.number("hit_die")}") }
                    "species" -> fields["speed"]=selected["speed"] ?: JsonPrimitive(30)
                    "background" -> { fields["increases"]=JsonObject(emptyMap()); val skills=d.obj("skills").toMutableMap(); val old=rules.rows("backgrounds").find { it.name==d.text("background") }; (old?.get("skills") as? JsonArray).orEmpty().forEach { val k=it.jsonPrimitive.content; if((skills[k] as? JsonPrimitive)?.intOrNull==1) skills.remove(k) }; (selected["skills"] as? JsonArray).orEmpty().forEach { val k=it.jsonPrimitive.content; skills[k]=JsonPrimitive(maxOf(1,(skills[k] as? JsonPrimitive)?.intOrNull ?: 0)) }; fields["skills"]=JsonObject(skills) }
                }
                change(JsonObject(card + ("dnd" to JsonObject(fields))))
            } }
        }
        OutlinedTextField(d.text("subclass"), { set("subclass",JsonPrimitive(it)) }, label = { Text(tr("Subclass")) }, enabled = editable)
        num("level",tr("Level"))
        ChoiceMenu(tr("Ability scores"),d.text("method"),listOf("point_buy" to tr("Point buy (27 points)"),"standard_array" to tr("Standard array (15, 14, 13, 12, 10, 8)")) + if(!points) listOf("manual" to tr("Manual values")) else emptyList()) { if(editable) set("method",JsonPrimitive(it)) }
        Text(tr("Point buy for role cards") + " · ${abilities.sumOf { rules.obj("point_buy").obj("costs").number(d.obj("base").number(it).toString()) }} / ${rules.obj("point_buy").number("budget")}")
        abilities.forEach { a ->
            var open by remember(a) { mutableStateOf(false) }
            TextButton(onClick={open=!open}) { Text(rules.obj("names").obj(a).text(language).ifEmpty { a }) }
            if(open) {
                num(a,tr("Base"),"base"); num(a,tr("Background increase"),"increases"); num(a,tr("Ability Score Improvements and feats after level 1"),"improvements",editable && (!points || gm))
                Text(tr("Total") + " · ${d.obj("base").number(a)+d.obj("increases").number(a)+d.obj("improvements").number(a)}")
                val saves=(d["saves"] as? JsonArray).orEmpty()
                Row { Checkbox(saves.contains(JsonPrimitive(a)), { on -> set("saves",JsonArray(saves.filter { it!=JsonPrimitive(a) } + if(on) listOf(JsonPrimitive(a)) else emptyList())) },enabled=editable); Text(tr("Saving throw proficiency")) }
            }
        }
        var skillsOpen by remember { mutableStateOf(false) }; TextButton(onClick={skillsOpen=!skillsOpen}) { Text(tr("Skills")) }
        if(skillsOpen) rules.rows("skills").forEach { s -> ChoiceMenu(rules.obj("names").obj(s.name).text(language).ifEmpty { s.name },d.obj("skills").number(s.name).toString(),listOf("0" to tr("None"),"1" to tr("Proficient"),"2" to tr("Expertise"))) { if(editable) set(s.name,JsonPrimitive(it.toInt()),"skills") } }
        var combat by remember { mutableStateOf(false) }; TextButton(onClick={combat=!combat}) { Text(tr("Combat and spellcasting")) }
        if(combat) {
            listOf("ac","hp_max","speed","initiative").forEach { num(it,tr(it)) }
            OutlinedTextField(d.text("hit_dice"),{set("hit_dice",JsonPrimitive(it))}, label={Text(tr("Hit Dice"))},enabled=editable)
            ChoiceMenu(tr("Spellcasting ability"),d.text("spellcasting_ability"),listOf("" to tr("None"))+abilities.map { it to it }) { if(editable) set("spellcasting_ability",JsonPrimitive(it)) }
            Text(tr("Empty slot limits use the class and level defaults."))
            (1..9).forEach { num(it.toString(),tr("Spell level")+" $it","slots",optional=true) }
        }
        listOf("features","spells","notes").forEach { k -> OutlinedTextField(d.text(k),{set(k,JsonPrimitive(it))},label={Text(tr(k))},enabled=editable) }
    }
}
