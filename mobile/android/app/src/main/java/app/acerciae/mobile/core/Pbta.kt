package app.acerciae.mobile.core

import kotlinx.serialization.json.*

object Pbta {
    fun validSheet(sheet: JsonObject, pack: JsonObject): Boolean {
        if (pack.rows("books").none { it.id == sheet.text("book") }) return false
        return listOf("stats","resources","conditions").all { group ->
            if (sheet[group] != null && sheet[group] != JsonNull && sheet[group] !is JsonObject) return@all false
            val known = pack.rows(group).map { it.id }.toSet()
            sheet.obj(group).all { (key,value) ->
                val v = value as? JsonPrimitive
                key in known && v != null && !v.isString && if(group == "conditions") v.booleanOrNull != null else v.intOrNull?.let { it in -9999..9999 } == true
            }
        }
    }
    fun moves(pack: JsonObject, sheet: JsonObject) = pack.rows("moves").filter { it.text("book").isEmpty() || it.text("book") == sheet.text("book") }
    fun moveBody(character: String, move: JsonObject, modifier: Int): JsonObject {
        require(Regex("^[a-z][a-z0-9_-]{0,39}$").matches(move.id) && modifier in -99..99)
        val extra = if(move.text("stat").isNotEmpty() && modifier != 0) " $modifier" else ""
        return payload("character_id" to character,"kind" to "ic","visibility" to "window","content" to ".move ${move.id}$extra")
    }
}
