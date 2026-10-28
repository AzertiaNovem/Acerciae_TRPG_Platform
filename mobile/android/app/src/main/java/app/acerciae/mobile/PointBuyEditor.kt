package app.acerciae.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.*

@Composable fun PointBuyEditor(card: JsonObject, rules: JsonObject, editable: Boolean, isKeeper: Boolean, language: String, change: (JsonObject) -> Unit) {
    val names = RuleNames(rules, language)
    val preview = PointBuy(card, rules); val career = preview.career
    var search by remember { mutableStateOf("") }; var newSkill by remember { mutableStateOf("") }; var choosing by remember { mutableStateOf(false) }
    fun careerField(key: String, value: JsonElement) = change(JsonObject(card + ("career" to JsonObject(card.obj("career") + (key to value)))))
    fun points(key: String, kind: String, value: Int) { val values = card.obj("skill_points"); change(JsonObject(card + ("skill_points" to JsonObject(values + (key to JsonObject(values.obj(key) + (kind to JsonPrimitive(value)))))))) }
    fun choices(i: Int) = ((card.obj("career")["choices"] as? JsonArray)?.getOrNull(i) as? JsonArray).orEmpty()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(tr("CoC7 购点"), style = MaterialTheme.typography.titleMedium)
        Text(tr("Characteristics") + " ${preview.characteristicTotal} · LUK ${card.obj("characteristics").number("LUK")}")
        TextButton(onClick = { choosing = true }, enabled = editable) { Text(tr("Career") + ": ${names.careerLabel(career).ifEmpty { tr("Choose a career from the list") }}") }
        if (career.isNotEmpty()) {
            Text(names.careerDescription(career), style = MaterialTheme.typography.bodySmall)
            Text(tr("Career points") + ": ${names.formula(career)} = ${preview.careerBudget}")
            Text(tr("固定职业技能：") + career.rows("fixed").joinToString("、") { names.optionLabel(it) }, style = MaterialTheme.typography.bodySmall)
            (career["credit"] as? JsonArray)?.takeIf { it.size == 2 }?.let { Text(tr("Credit Rating") + ": ${it[0]}–${it[1]}") }
            career.rows("choices").forEachIndexed { i, group ->
                var expanded by remember(career.name, i) { mutableStateOf(false) }
                TextButton(onClick = { expanded = !expanded }) { Text(tr("Career") + " ${i+1} · " + tr("Pick {n} of:").replace("{n}", group.number("pick").toString())) }
                if (expanded) group.rows("from").forEach { option ->
                    val key = option.text("skill") + option.text("spec").let { if (it.isEmpty()) "" else " ($it)" }
                    val selected = JsonPrimitive(key) in choices(i)
                    Row {
                        Checkbox(selected, { on ->
                            val groups = (card.obj("career")["choices"] as? JsonArray).orEmpty().toMutableList()
                            while (groups.size <= i) groups.add(JsonArray(emptyList()))
                            groups[i] = JsonArray(if (on) choices(i) + JsonPrimitive(key) else choices(i).filter { it != JsonPrimitive(key) }); careerField("choices", JsonArray(groups))
                        }, enabled = editable && (selected || choices(i).size < group.number("pick")))
                        Text(names.optionLabel(option), Modifier.weight(1f))
                    }
                }
            }
            repeat(career.number("free").coerceAtLeast(0)) { i ->
                OutlinedTextField(names.skillLabel((card.obj("career")["specialties"] as? JsonArray)?.getOrNull(i)?.jsonPrimitive?.content.orEmpty()), { value ->
                    val list = (card.obj("career")["specialties"] as? JsonArray).orEmpty().toMutableList()
                    while (list.size <= i) list.add(JsonPrimitive("")); list[i] = JsonPrimitive(names.skillKey(value))
                    while (list.lastOrNull()?.jsonPrimitive?.content == "") list.removeAt(list.lastIndex)
                    careerField("specialties", JsonArray(list))
                }, label = { Text(tr("Skills") + " ${i+1}") }, enabled = editable)
            }
            if (career.number("free") > 0) Text(tr("特长使用下方技能名，可填专长如 Science (Biology)。"), style = MaterialTheme.typography.bodySmall)
        }
        Text(tr("Career points") + " ${preview.spent("career")} / ${preview.careerBudget} · " + tr("Hobby points") + " ${preview.spent("hobby")} / ${preview.hobbyBudget}")
        preview.issues.forEach { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        preview.creditWarning?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Text(tr("总值 = 基础 + 成长 + 职业 + 兴趣。这里显示预览，保存时由服务器重新校验。"), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(search, { search = it }, label = { Text(tr("搜索技能")) })
        preview.skillNames.filter { search.isBlank() || it.contains(search, true) || names.skillLabel(it).contains(search, true) }.forEach { key -> key(key) {
            var expanded by remember { mutableStateOf(false) }
            TextButton(onClick = { expanded = !expanded }) { Text("${names.skillLabel(key)} · ${preview.total(key)}${if (preview.allowed(key)) " · " + tr("Career") else ""}") }
            if (expanded) {
                Text("½ ${preview.total(key)/2} · ⅕ ${preview.total(key)/5}")
                if (preview.standard(key)) Text(tr("Base") + " ${preview.base(key)}")
                listOf("base" to tr("基础"), "growth" to tr("成长"), "career" to tr("职业"), "hobby" to tr("兴趣")).filter { it.first != "base" || !preview.standard(key) }.forEach { (kind, label) ->
                    val locked = (kind == "growth" && !isKeeper) || key == "Cthulhu Mythos" || (kind == "career" && !preview.allowed(key))
                    OutlinedTextField(card.obj("skill_points").obj(key).number(kind).toString(), { text -> text.ifEmpty { "0" }.toIntOrNull()?.takeIf { it in 0..(if (kind == "base") 99 else 999) }?.let { points(key, kind, it) } }, label = { Text(label) }, enabled = editable && !locked)
                }
                if (editable && card.obj("skill_points").containsKey(key)) TextButton(onClick = {
                    val preserved = buildJsonObject { put("growth", card.obj("skill_points").obj(key).number("growth")); put("base", card.obj("skill_points").obj(key).number("base")) }
                    change(JsonObject(card + ("skill_points" to JsonObject(card.obj("skill_points") + (key to preserved)))))
                }) { Text(tr("清空此技能分配")) }
                if (editable && !preview.standard(key) && (isKeeper || card.obj("skill_points").obj(key).number("growth") == 0)) TextButton(onClick = { change(JsonObject(card + mapOf("skills" to JsonObject(card.obj("skills") - key), "skill_points" to JsonObject(card.obj("skill_points") - key)))) }) { Text(tr("移除自定义技能")) }
            }
        } }
        if (editable) {
            OutlinedTextField(newSkill, { newSkill = it }, label = { Text(tr("添加专长或自定义技能")) })
            TextButton(onClick = { val key = names.skillKey(newSkill); if (!card.obj("skill_points").containsKey(key)) change(JsonObject(card + ("skill_points" to JsonObject(card.obj("skill_points") + (key to JsonObject(emptyMap())))))); search = key; newSkill = "" }, enabled = newSkill.isNotBlank() && newSkill.length <= 60) { Text(tr("添加技能")) }
        }
    }
    if (choosing) {
        var query by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { choosing = false }, title = { Text(tr("选择职业")) }, text = {
            Column { OutlinedTextField(query, { query = it }, label = { Text(tr("搜索职业")) }); LazyColumn(Modifier.heightIn(max = 360.dp)) {
                item { TextButton(onClick = { change(JsonObject(card + ("career" to buildJsonObject { put("name", ""); put("choices", JsonArray(emptyList())); put("specialties", JsonArray(emptyList())) }))); choosing = false }) { Text(tr("暂不选择职业")) } }
                items(rules.rows("careers").filter { query.isBlank() || it.name.contains(query, true) || names.careerLabel(it).contains(query, true) }, key = { it.number("id") }) { item -> TextButton(onClick = { change(JsonObject(card + ("career" to buildJsonObject { put("name", item.name); put("choices", JsonArray(emptyList())); put("specialties", JsonArray(emptyList())) }))); choosing = false }) { Text("${names.careerLabel(item)}\n${names.formula(item)}") } }
            } }
        }, confirmButton = { TextButton(onClick = { choosing = false }) { Text(tr("关闭")) } })
    }
}
