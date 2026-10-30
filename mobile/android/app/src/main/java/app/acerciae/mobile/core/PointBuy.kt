package app.acerciae.mobile.core

import kotlinx.serialization.json.*

/** Local preview only; the server recomputes and authorizes every save. */
class PointBuy(val card: JsonObject, val rules: JsonObject) {
    val career = rules.rows("careers").find { it.name == card.obj("career").text("name") } ?: JsonObject(emptyMap())
    val characteristicTotal get() = listOf("STR","CON","SIZ","DEX","APP","INT","POW","EDU").sumOf { card.obj("characteristics").number(it) }
    val careerBudget get() = career.rows("points").sumOf { term -> term.number("mult") * (term["attrs"] as? JsonArray).orEmpty().maxOfOrNull { card.obj("characteristics").number(it.jsonPrimitive.content) }.let { maxOf(0, it ?: 0) } }
    val hobbyBudget get() = card.obj("characteristics").number("INT") * 2
    fun spent(kind: String) = card.obj("skill_points").values.sumOf { it.jsonObject.number(kind) }
    val skillNames get() = (rules.rows("skills").map { it.name } + card.obj("skills").keys + card.obj("skill_points").keys).distinct().sorted()
    fun family(key: String): String {
        val name = key.trim()
        if (name == "Fighting (Brawl)") return "Fighting"
        if (name.startsWith("Firearms (")) return "Firearms"
        return rules.rows("families").sortedByDescending { it.name.length }.firstOrNull { name == it.name || name.startsWith(it.name + " (") || name.startsWith(it.name + "（") }?.name ?: name
    }
    fun standard(key: String) = rules.rows("skills").any { it.name == key } || family(key) != key
    fun base(key: String): Int {
        rules.rows("skills").find { it.name == key }?.let { return when (it.text("base")) { "DEX/2" -> card.obj("characteristics").number("DEX") / 2; "EDU" -> card.obj("characteristics").number("EDU"); else -> it.number("base") } }
        val f = family(key)
        if (f == key) return card.obj("skill_points").obj(key).number("base")
        val spec = key.removePrefix(f).trim(' ', '(', ')', '（', '）').lowercase()
        val special = mapOf("Fighting" to mapOf("brawl" to 25,"斗殴" to 25,"axe" to 15,"chainsaw" to 10,"链锯" to 10,"flail" to 10,"garrote" to 15,"spear" to 20,"矛" to 20,"sword" to 20,"剑" to 20,"whip" to 5,"鞭" to 5), "Firearms" to mapOf("handgun" to 20,"手枪" to 20,"rifle/shotgun" to 25,"rifle" to 25,"shotgun" to 25,"步枪" to 25,"霰弹枪" to 25,"步/霰" to 25,"bow" to 15,"弓" to 15,"弓术" to 15,"smg" to 15,"submachine gun" to 15,"冲锋枪" to 15,"来复" to 25,"来复枪" to 25,"步枪/霰弹枪" to 25,"火焰喷射器" to 10,"重武器" to 10,"机枪" to 10,"flamethrower" to 10,"heavy weapons" to 10,"machine gun" to 10))
        return special[f]?.get(spec) ?: rules.rows("families").find { it.name == f }?.number("base") ?: 0
    }
    fun covers(entry: JsonObject, key: String): Boolean {
        val name = key.trim(); val f = family(name); val target = entry.text("skill")
        if (entry.flag("any")) return f == target || name == target
        val want = entry.text("spec").trim().lowercase()
        if (want.isNotEmpty()) { val have = RuleNames.split(name).second.lowercase(); return f == target && have.isNotEmpty() && (have.contains(want) || want.contains(have)) }
        return name == target || (f == target && RuleNames.split(name).second.isEmpty())
    }
    fun allowed(key: String): Boolean {
        if (career.isEmpty()) return false
        val entries = (career.rows("fixed") + buildJsonObject { put("skill", "Credit Rating") }).toMutableList()
        (card.obj("career")["choices"] as? JsonArray).orEmpty().forEachIndexed { i, group ->
            career.rows("choices").getOrNull(i)?.let { choice ->
                (group as? JsonArray).orEmpty().forEach { pick ->
                    val name = pick.jsonPrimitive.content
                    choice.rows("from").find { covers(it, name) }?.let { option ->
                        val spec = RuleNames.split(name).second
                        entries.add(buildJsonObject { put("skill", family(name)); put("spec", spec); put("any", spec.isEmpty() && option.flag("any")) })
                    }
                }
            }
        }
        (card.obj("career")["specialties"] as? JsonArray).orEmpty().forEach {
            val name = it.jsonPrimitive.content; val spec = RuleNames.split(name).second
            if (name.isNotEmpty()) entries.add(buildJsonObject { put("skill", if (spec.isEmpty()) name else family(name)); put("spec", spec) })
        }
        return entries.any { covers(it, key) }
    }
    fun total(key: String): Int {
        val p = card.obj("skill_points")[key] as? JsonObject
        return if (p == null) (card.obj("skills")[key] as? JsonPrimitive)?.intOrNull ?: base(key) else base(key) + p.number("growth") + p.number("career") + p.number("hobby")
    }
    val issues get() = buildList {
        if (career.isEmpty() && card.obj("career").text("name").isNotEmpty()) add("请选择列表中的职业")
        if (spent("career") > careerBudget) add("职业点超过预算")
        if (spent("hobby") > hobbyBudget) add("兴趣点超过 INT×2")
        if ((card.obj("career")["specialties"] as? JsonArray).orEmpty().count { it.jsonPrimitive.content.isNotEmpty() } > career.number("free")) add("自由特长超过职业允许数量")
        (card.obj("career")["choices"] as? JsonArray).orEmpty().forEachIndexed { i, picks -> career.rows("choices").getOrNull(i)?.let { group ->
            if (picks.jsonArray.size > group.number("pick")) add("职业选项 ${i+1} 超过可选数量")
            if (picks.jsonArray.any { pick -> group.rows("from").none { covers(it, pick.jsonPrimitive.content) } }) add("职业选项 ${i+1} 包含无效技能")
        } }
        card.obj("skill_points").keys.sorted().forEach { key ->
            val p = card.obj("skill_points").obj(key)
            if (p.number("career") > 0 && !allowed(key)) add("$key：不能投入职业点，请先调整职业选项或移除点数")
            if (key == "Cthulhu Mythos" && (p.number("career") > 0 || p.number("hobby") > 0)) add("克苏鲁神话不能投入职业点或兴趣点")
            if (total(key) > 99) add("$key：总值超过 99")
        }
    }
    val creditWarning: String? get() {
        val range = (career["credit"] as? JsonArray).orEmpty(); if (range.size != 2) return null
        val credit = total("Credit Rating"); val low = range[0].jsonPrimitive.int; val high = range[1].jsonPrimitive.int
        return if (credit !in low..high) "信用评级 $credit 不在职业建议范围 $low–$high 内（不阻止保存）" else null
    }
}
