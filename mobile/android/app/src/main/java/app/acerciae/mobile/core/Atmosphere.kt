package app.acerciae.mobile.core
import kotlinx.serialization.json.JsonObject
object Atmosphere {
    val variants = listOf("day_landscape", "night_landscape", "day_portrait", "night_portrait")
    fun variant(dark: Boolean, portrait: Boolean) = (if (dark) "night" else "day") + (if (portrait) "_portrait" else "_landscape")
    fun asset(current: JsonObject, dark: Boolean, portrait: Boolean): String? = if (current.flag("enabled") && variants.all { current.obj("assets").text(it).isNotEmpty() }) current.obj("assets").text(variant(dark, portrait)) else null
}
