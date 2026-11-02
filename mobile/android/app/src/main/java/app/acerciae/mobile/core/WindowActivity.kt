package app.acerciae.mobile.core
import kotlinx.serialization.json.*
object WindowActivity {
    fun shouldNotify(previous: JsonObject?, current: JsonObject, user: String, viewing: String) = current.id != viewing && previous != null && current.number("last_seq") > previous.number("last_seq") && current.number("unread") > 0 && (current.text("kind") == "main" || current.rows("members").any { it.text("user_id") == user })
    fun speaker(m: Message) = if(m.kind == "ooc") m.authorName else m.characterName ?: m.authorName
}
