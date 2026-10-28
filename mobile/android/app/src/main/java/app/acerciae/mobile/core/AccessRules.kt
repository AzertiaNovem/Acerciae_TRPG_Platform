package app.acerciae.mobile.core
import kotlinx.serialization.json.*
object AccessRules {
    fun studio(channel: JsonObject, settings: JsonObject): String = when {
        settings.obj("features")["log_studio"] == JsonPrimitive(false) -> "disabled"
        channel.id.isEmpty() -> "hidden"
        channel.text("story_status") == "ended" -> "open"
        channel["studio_visible"] == JsonPrimitive(false) -> "hidden"
        channel.text("my_role") != "gm" && channel["studio_player_access"] == JsonPrimitive(false) -> "locked"
        else -> "open"
    }
    fun canCreateChannel(role: String, settings: JsonObject) = role.isNotEmpty() && role != "guest" && (role in listOf("owner", "admin") || settings.obj("policy").text("channel_creation") != "maintainers")
}
