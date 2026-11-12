package app.acerciae.mobile.core

import kotlinx.serialization.json.*

val Message.hasStructuredPbtaResult: Boolean get() = dice?.let { it.text("type") == "pbta_move" && it.text("name").isNotEmpty() && ((it["rolls"] as? JsonArray).isNullOrEmpty() || it["total"] != null) } == true

/** Every outcome has its colour (the same palette as the web): success levels, plain rolls (ROLL) and sheet replies (NEUTRAL). */
enum class DiceTone { NEUTRAL, ROLL, SUCCESS, HARD, EXTREME, CRITICAL, FAILURE, FUMBLE, NOTICE }

private fun toneOf(roll: JsonObject?, fallback: DiceTone): DiceTone {
    when ((roll?.get("level") as? JsonPrimitive)?.contentOrNull) {
        "critical" -> return DiceTone.CRITICAL
        "extreme" -> return DiceTone.EXTREME
        "hard" -> return DiceTone.HARD
        "regular" -> return DiceTone.SUCCESS
        "failure" -> return DiceTone.FAILURE
        "fumble" -> return DiceTone.FUMBLE
    }
    if (roll?.get("critical") == JsonPrimitive(true)) return DiceTone.CRITICAL
    return when (roll?.get("success")) {
        JsonPrimitive(true) -> DiceTone.SUCCESS
        JsonPrimitive(false) -> DiceTone.FAILURE
        else -> fallback
    }
}
private val JsonObject.rollList: List<JsonObject> get() = (get("rolls") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
private val JsonObject.neutralTone: DiceTone get() = if (text("type") == "roll") DiceTone.ROLL else DiceTone.NEUTRAL

/** The roll's colour: the last roll's success level (else the result's), then whether it succeeded. */
val Message.diceTone: DiceTone get() {
    val dice = dice ?: return DiceTone.NEUTRAL
    if (dice.text("type") == "hidden_notice") return DiceTone.NOTICE
    val last = (dice["rolls"] as? JsonArray)?.lastOrNull() as? JsonObject
    val level = (last?.get("level") as? JsonPrimitive)?.contentOrNull ?: dice.text("level")
    if (level.isNotEmpty()) toneOf(JsonObject(mapOf("level" to JsonPrimitive(level))), DiceTone.NEUTRAL).let { if (it != DiceTone.NEUTRAL) return it }
    return when {
        dice["critical"] == JsonPrimitive(true) -> DiceTone.CRITICAL
        last?.get("success") == JsonPrimitive(true) || dice["success"] == JsonPrimitive(true) -> DiceTone.SUCCESS
        last?.get("success") == JsonPrimitive(false) || dice["success"] == JsonPrimitive(false) -> DiceTone.FAILURE
        else -> dice.neutralTone
    }
}
/** One colour per line of the result: a repeated check (".ra 3#str") has a line, and a roll, for each attempt. */
val Message.diceLines: List<Pair<String, DiceTone>> get() {
    val dice = dice ?: return emptyList()
    val lines = displayText.split('\n')
    val rolls = dice.rollList
    val tone = diceTone
    return lines.mapIndexed { i, line -> line to if (lines.size > 1 && rolls.size == lines.size) toneOf(rolls[i], dice.neutralTone) else tone }
}
val Message.diceCommand: String? get() = if (dice == null || diceTone == DiceTone.NOTICE) null else content

/** Who the dice spoke as (the channel's text group: nickname and avatar), recorded on the roll. */
data class DiceBot(val name: String, val groupId: String, val avatarVersion: Int)
val Message.diceBot: DiceBot? get() {
    val bot = dice?.get("bot") as? JsonObject ?: return null
    return DiceBot(bot.text("name"), bot.text("group_id"), bot.number("avatar_version"))
}
/** The account's choice: results as a separate message from the dice (default), or under the command ("inline"). */
object DiceDisplay {
    const val SEPARATE = "separate"
    const val INLINE = "inline"
    fun separate(user: User?) = user?.diceDisplay != INLINE
}
/** Numbers in a result to emphasise: totals, targets and the dice that fell; dice notation (D100, 3d6) stays plain. */
val diceNumberPattern = Regex("(?<![A-Za-z\\d])\\d+(?![A-Za-z\\d])")
