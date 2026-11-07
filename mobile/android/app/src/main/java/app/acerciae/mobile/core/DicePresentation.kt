package app.acerciae.mobile.core

import kotlinx.serialization.json.*

val Message.hasStructuredPbtaResult: Boolean get() = dice?.let { it.text("type") == "pbta_move" && it.text("name").isNotEmpty() && ((it["rolls"] as? JsonArray).isNullOrEmpty() || it["total"] != null) } == true
enum class DiceTone { NEUTRAL, SUCCESS, FAILURE, CRITICAL, FUMBLE, NOTICE }
val Message.diceTone: DiceTone get() {
    val dice = dice ?: return DiceTone.NEUTRAL
    if (dice.text("type") == "hidden_notice") return DiceTone.NOTICE
    val last = (dice["rolls"] as? JsonArray)?.lastOrNull() as? JsonObject
    val level = (last?.get("level") as? JsonPrimitive)?.contentOrNull ?: dice.text("level")
    return when {
        dice["critical"] == JsonPrimitive(true) || level == "critical" -> DiceTone.CRITICAL
        level == "fumble" -> DiceTone.FUMBLE
        last?.get("success") == JsonPrimitive(true) || dice["success"] == JsonPrimitive(true) -> DiceTone.SUCCESS
        last?.get("success") == JsonPrimitive(false) || dice["success"] == JsonPrimitive(false) -> DiceTone.FAILURE
        else -> DiceTone.NEUTRAL
    }
}
val Message.diceCommand: String? get() = if (dice == null || diceTone == DiceTone.NOTICE) null else content
