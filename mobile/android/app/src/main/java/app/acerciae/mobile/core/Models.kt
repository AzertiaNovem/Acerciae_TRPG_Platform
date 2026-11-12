package app.acerciae.mobile.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class Health(val status: String, @SerialName("llm_mode") val llmMode: String = "", val db: String = "")
@Serializable data class User(val id: String, val username: String, @SerialName("display_name") val displayName: String, @SerialName("ui_language") val uiLanguage: String? = null, @SerialName("atmosphere_enabled") val atmosphereEnabled: Boolean = false, @SerialName("has_avatar") val hasAvatar: Boolean? = null, @SerialName("avatar_data") val avatarData: String? = null, @SerialName("avatar_version") val avatarVersion: Int? = null, @SerialName("avatar_hash") val avatarHash: String? = null, @SerialName("dice_display") val diceDisplay: String? = null)
// Deliberately not a data class: never include a token in generated toString() output.
@Serializable class Session(val token: String, val user: User)
@Serializable data class Server(val id: String, val name: String)
@Serializable data class Channel(val id: String, val name: String, @SerialName("my_role") val myRole: String = "player")
@Serializable data class ChatWindow(val id: String, val name: String, val kind: String)
@Serializable data class ChatHistory(val messages: List<Message>, val hasOlder: Boolean) {
    companion object {
        fun merge(existing: List<Message>, incoming: List<Message>, recalled: Map<String, Message>) = (existing + incoming).associateBy { it.id }.values.map { recalled[it.id] ?: it }.sortedBy { it.seq }
    }
}
@Serializable data class Message(
    val id: String,
    val content: String,
    @SerialName("author_name") val authorName: String,
    @SerialName("character_name") val characterName: String? = null,
    val kind: String,
    val seq: Long,
    @SerialName("channel_id") val channelId: String? = null,
    @SerialName("media_asset_id") val mediaAssetId: String? = null,
    val visibility: String = "window",
    @SerialName("author_id") val authorId: String? = null,
    val dice: JsonObject? = null,
    @SerialName("character_id") val characterId: String? = null,
    @SerialName("character_avatar_asset_id") val characterAvatarAssetId: String? = null,
    @SerialName("character_avatar_version") val characterAvatarVersion: Int? = null,
    @SerialName("author_avatar_version") val authorAvatarVersion: Int? = null,
    @SerialName("character_avatar_hash") val characterAvatarHash: String? = null,
    @SerialName("author_avatar_hash") val authorAvatarHash: String? = null,
    @SerialName("reference_ids") val referenceIds: List<String>? = null,
    /** Recalled by its author: a tombstone (no text, dice or references) kept in the line's place. */
    @SerialName("recalled_at") val recalledAt: String? = null,
    /** Seconds left, when the message arrived, for its author to recall it; null when it cannot be recalled. */
    @SerialName("recall_seconds_left") val recallSecondsLeft: Int? = null,
    @SerialName("stand_in") val standIn: Boolean = false,
)
@Serializable data class DocumentSummary(
    val id: String,
    val title: String,
    @SerialName("doc_type") val docType: String,
    val version: Int,
    @SerialName("gm_only") val gmOnly: Boolean = false,
    val preview: String? = null,
)
@Serializable data class DocumentEntry(val id: String, val summary: String, val status: String)
@Serializable data class DocumentDetail(val id: String, val title: String, val entries: List<DocumentEntry>, val markdown: String)
@Serializable data class Highlight(
    val id: String,
    @SerialName("document_id") val documentId: String,
    @SerialName("target_entry_id") val targetEntryId: String? = null,
    val reason: String,
    @SerialName("source_event_ids") val sourceEventIds: List<String> = emptyList(),
    @SerialName("expires_at") val expiresAt: String,
)

// Local preview model, NOT a proposed server response or SeaLDice format.
@Serializable data class DemoCampaign(
    val title: String,
    val scene: String,
    val messages: List<Message>,
    val documents: List<DocumentSummary>,
    val highlights: List<Highlight>,
    val replay: List<ReplayFrame>,
)
@Serializable data class ReplayFrame(val id: String, val speaker: String, val text: String, val atmosphere: String)

val Message.displayText: String get() = if (recalledAt != null) "" else dice?.get("text")?.jsonPrimitive?.contentOrNull ?: if (diceTone == DiceTone.NOTICE) "" else content
val Message.recalled: Boolean get() = recalledAt != null
val Message.hasIllustration: Boolean get() = !recalled && !mediaAssetId.isNullOrEmpty()
val Message.illustrationCaption: String get() = ChatIllustrations.caption(content)
fun JsonObject.text(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
fun JsonObject.flag(key: String): Boolean = (get(key) as? JsonPrimitive)?.booleanOrNull ?: false
fun JsonObject.number(key: String): Int = (get(key) as? JsonPrimitive)?.intOrNull ?: 0
fun JsonObject.obj(key: String): JsonObject = get(key) as? JsonObject ?: JsonObject(emptyMap())
fun JsonObject.rows(key: String): List<JsonObject> = (get(key) as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
val JsonObject.id: String get() = text("id")
val JsonObject.name: String get() = text("name").ifEmpty { text("title") }
fun payload(vararg fields: Pair<String, String>) = buildJsonObject { fields.forEach { put(it.first, it.second) } }
