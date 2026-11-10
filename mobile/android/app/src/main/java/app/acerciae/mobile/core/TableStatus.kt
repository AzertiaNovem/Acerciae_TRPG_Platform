package app.acerciae.mobile.core

import kotlinx.serialization.json.*

/** One number of a character's entry in the list ("HP 9/12"); [low] marks hit points at a third or less. */
data class VitalPart(val label: String, val value: String, val low: Boolean = false) {
    val text get() = if (value.isEmpty()) label else "$label $value"
}

/**
 * The few numbers that matter at the table, from `vitals` in a row of `GET /channels/{id}/characters`: Call of
 * Cthulhu HP, SAN and DEX; D&D HP, AC and DEX; PbtA the pack's resources and the marked conditions. A value the sheet
 * leaves blank reads "—"; a row without vitals (an older server) has no parts.
 */
object Vitals {
    private fun JsonObject.num(key: String): Int? = (get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.toInt()
    private fun show(value: Int?) = value?.toString() ?: "—"
    private fun pair(value: Int?, max: Int?) = if (max != null && max != 0) "${show(value)}/$max" else show(value)
    fun parts(vitals: JsonObject?): List<VitalPart> {
        if (vitals == null || vitals.isEmpty()) return emptyList()
        if (vitals.text("rule_system") == "pbta")
            return vitals.rows("resources").map { VitalPart(it.text("name"), show(it.num("value"))) } + vitals.rows("conditions").map { VitalPart(it.text("name"), "") }
        val hp = vitals.num("hp"); val max = vitals.num("hp_max")
        // A third of the maximum, rounded up; with no maximum on the card, only "down" counts.
        val low = hp != null && if (max != null && max != 0) hp <= (max + 2) / 3 else hp <= 0
        val first = VitalPart("HP", pair(hp, max), low)
        return if (vitals.text("rule_system") == "dnd2024") listOf(first, VitalPart("AC", show(vitals.num("ac"))), VitalPart("DEX", show(vitals.num("dex"))))
        else listOf(first, VitalPart("SAN", pair(vitals.num("san"), vitals.num("san_max"))), VitalPart("DEX", show(vitals.num("dex"))))
    }
    fun of(character: JsonObject): List<VitalPart> = parts(character["vitals"] as? JsonObject)
}

/** One way to play the moment: the line in the character's voice, its kind, a dice command that may go with it, its stance. */
data class InspirationOption(val text: String, val kind: String, val roll: String, val angle: String)

object Inspiration {
    const val REMEMBERED = 12
    /** The options of a `POST /channels/{id}/inspiration` result; a result with only `draft` reads as one option. */
    fun options(result: JsonObject): List<InspirationOption> {
        val listed = result.rows("options").map { InspirationOption(it.text("text"), it.text("kind").ifEmpty { "ic" }, it.text("roll"), it.text("angle")) }.filter { it.text.isNotBlank() }
        if (listed.isNotEmpty()) return listed
        return result.text("draft").takeIf { it.isNotBlank() }?.let { listOf(InspirationOption(it, "ic", "", "")) }.orEmpty()
    }
    /** What was shown so far, newest last: "Another take" sends it as `avoid` so the next three differ. */
    fun shown(before: List<String>, result: JsonObject): List<String> = (before + options(result).map { it.text }).distinct().takeLast(REMEMBERED)
}

/** Pinned lines: reminders of kind `pinned`, kept among a group's hints until their pinner or the GM unpins them. */
object Pins {
    fun of(reminders: List<JsonObject>, messageId: String): JsonObject? = reminders.firstOrNull { it.text("kind") == "pinned" && it.text("pinned_message_id") == messageId }
    fun canPin(message: Message): Boolean = !message.recalled && message.kind != "system"
    fun canUnpin(pin: JsonObject, userId: String?, gm: Boolean): Boolean = pin.text("kind") == "pinned" && (gm || (!userId.isNullOrEmpty() && pin.text("pinned_by") == userId))
}
