package app.acerciae.mobile.core

import kotlinx.serialization.json.*
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

// What an interactive message shows for this viewer: the decisions of the web card (frontend/src/components/
// HypertextCard.tsx and its row in MessageList.tsx), so the Compose card only draws them. Every sentence here is a
// catalog key: translate it with tr(), then put card or user text in with Hypertext.fill (isolated, as the web's <bdi>).

/** Why a card's controls are disabled, first match wins; [lock] is what Hypertext.resolve gets. */
enum class HxReason(val text: String, val lock: HxLockReason) {
    SPECTATOR("Spectators cannot use interactive messages.", HxLockReason.SPECTATOR),
    RECALLED("This message was recalled.", HxLockReason.RECALLED),
    HISTORY("This message belongs to an earlier chat window.", HxLockReason.HISTORY),
    MISSING("This server does not support interactive messages yet.", HxLockReason.CLOSED),
    DISABLED("Interactive messages are turned off on this server.", HxLockReason.CLOSED),
    CLOSED("This message is closed.", HxLockReason.CLOSED),
    ARCHIVED("This window is archived.", HxLockReason.ARCHIVED),
    PAUSED("Your participation in this window is paused.", HxLockReason.PAUSED),
    MEMBER("Join this chat window to use this message.", HxLockReason.NOT_ACTOR),
    NOT_ACTOR("This message is for other characters.", HxLockReason.NOT_ACTOR),
    LOADING("Loading…", HxLockReason.LOADING),
}

/** What the app knows when it draws a card. [spectator]: a spectator view or the demo (drawn from the document alone:
 *  no status, no state, no engine). [window]: the card's chat window (by the message's chat_window_id) with its
 *  `members`, null when it is not loaded. [speakAs]: the character the composer speaks as ("" for none). [engine]:
 *  whether a script can run on this device ([HypertextStore.engine]). */
data class HxViewerFacts(
    val spectator: Boolean,
    val gm: Boolean,
    val userId: String?,
    val displayName: String,
    val openWindowId: String,
    val window: JsonObject?,
    val characters: List<JsonObject>,
    val speakAs: String,
    val engine: Boolean,
    val nowMillis: Long,
)

/** One card as drawn. Each node of [resolved] is drawn disabled when [off] says so, and looks and acts disabled while
 *  [waiting] (an action is under way: keep it focusable). */
data class HxCardView(
    val reason: HxReason?,
    val state: JsonObject,
    val resolved: List<HxResolved>,
    /** The viewer as a script sees them, and the character a line is posted as when it is not the window's. */
    val viewer: HxViewer,
    val sayCharacterId: String?,
    val engine: Boolean,
    val busy: Boolean,
    val spent: Boolean,
    /** Any control runs the script; any control can post (a handler, or an act that says or replies). */
    val scriptControls: Boolean,
    val posting: Boolean,
    val closed: Boolean,
    /** Footer, in this order: the reason's sentence; NO_ENGINE; "Working…"; "Uses left: {n}"; "You already used this.". */
    val noEngineShown: Boolean,
    val working: Boolean,
    val usesLeft: Int?,
    val spentShown: Boolean,
    /** GMs: the Close button (hint CLOSE_HINT), and the "Script details" box (marked "GM only"). */
    val closeShown: Boolean,
    val detailsShown: Boolean,
    val footerShown: Boolean,
    /** The name in the confirmation: the composer's character in character, the account's name out of character. */
    val confirmName: String,
    /** Milliseconds until closes_at, to draw the card again then; null when it has passed or is not set. */
    val closesInMillis: Long?,
) {
    val lock: HxLockReason? get() = reason?.lock
    fun off(r: HxResolved): Boolean = r.disabled || (HypertextView.hasOn(r.node) && !engine) || (spent && HypertextView.postsSomething(r.node))
    fun waiting(r: HxResolved): Boolean = !off(r) && busy
    /** The context an action of this card runs with ([HypertextStore.interact]). */
    fun context(channelId: String, message: Message, doc: HxDoc, dice: Boolean) = HxContext(channelId, message, doc, lock, viewer, engine, sayCharacterId, dice)
}

object HypertextView {
    const val PILL = "Interactive message"
    const val VIA = "via interactive message"
    const val VIA_HINT = "Posted from an interactive message"
    const val ANSWERING = "answering {name}"
    const val POSTS = "Posts:"
    const val POSTS_OOC = "Posts (out of character):"
    const val CONFIRM_LABEL = "Confirm"
    const val CONFIRM = "Post as {name}: {text}"
    const val CONFIRM_OOC = "Post as {name} (out of character): {text}"
    const val SHEET = "This changes your character sheet."
    const val POST = "Post"
    const val CANCEL = "Cancel"
    const val DETAILS = "Script details"
    const val GM_ONLY = "GM only"
    const val LINE = "Line {n}"
    const val WORKING = "Working…"
    const val USES_LEFT = "Uses left: {n}"
    const val SPENT = "You already used this."
    const val CLOSE = "Close"
    const val CLOSE_HINT = "Stop everyone from using this message"
    const val CHOOSE = "Choose…"
    const val SEND = "Send"
    const val AT_MOST = "At most {n} characters."
    const val SHARED = "Anything you type here may be shared in the chat."

    fun hasOn(n: HxNode) = (n as? HxControl)?.on != null
    fun postsSomething(n: HxNode) = n is HxButton && n.act != null && (n.act.say != null || n.act.reply != null)
    /** The caption key before a button's declarative say: an out-of-character line is posted under the account's name. */
    fun captionKey(n: HxNode): String? = (n as? HxButton)?.act?.takeIf { it.say != null }?.let { if (it.sayKind == "ooc") POSTS_OOC else POSTS }
    fun confirmKey(c: HxConfirm) = if (c.kind == "ooc") CONFIRM_OOC else CONFIRM
    /** An input's limit, for "At most {n} characters." while the draft is longer (it cannot be submitted then). */
    fun inputMax(doc: HxDoc, n: HxInput): Int = (doc.state[n.bind] as? HxTextDecl)?.max ?: 0
    fun tooLong(doc: HxDoc, n: HxInput, draft: String) = Hypertext.cpLength(draft) > inputMax(doc, n)

    /** The row's `↳ via interactive message`, followed by ` · answering {name}` when someone else acted (a reply the
     *  card's sender said for the player who clicked); null on a line no card produced. */
    fun via(m: Message): Boolean = !m.viaHypertextId.isNullOrEmpty()
    fun answering(m: Message): String? = m.viaUserName?.takeIf { via(m) && !m.viaUserId.isNullOrEmpty() && m.viaUserId != m.authorId && it.isNotEmpty() }

    /** An ISO time from the server ("2026-11-14T14:25:47.149433+00:00", "…Z") in epoch milliseconds; null if unreadable. */
    fun timeOf(iso: String?): Long? {
        if (iso.isNullOrEmpty()) return null
        return try { OffsetDateTime.parse(iso.replace(' ', 'T')).toInstant().toEpochMilli() } catch (_: DateTimeParseException) { null }
    }

    fun of(message: Message, doc: HxDoc, card: HxCard?, unavailable: HxUnavailable?, facts: HxViewerFacts): HxCardView {
        val entry = if (facts.spectator) null else card
        val off = if (facts.spectator) null else unavailable
        val gm = facts.gm
        // Who may act: GMs, and the actors by their character in the card's window (as the server checks).
        val member = facts.window?.rows("members")?.firstOrNull { !facts.userId.isNullOrEmpty() && it.text("user_id") == facts.userId }
        val characterId = member?.text("character_id")?.ifEmpty { null }
        val actors = doc.actors
        val actor = gm || actors.isNullOrEmpty() || (characterId != null && actors.any { it.lowercase() == characterId.lowercase() })
        // A line as the viewer is posted as the composer's character: the one picked, else the window's, else (not cast
        // in the window) their first own character.
        val sayCharacter = facts.speakAs.ifEmpty { characterId ?: facts.characters.firstOrNull { !facts.userId.isNullOrEmpty() && it.text("user_id") == facts.userId }?.id.orEmpty() }
        val sayCharacterName = if (sayCharacter.isEmpty()) null
            else facts.characters.firstOrNull { it.id == sayCharacter }?.let { Hypertext.stringOf(it["name"]) } ?: (if (sayCharacter == characterId) Hypertext.stringOf(member?.get("character_name")) else null)
        val viewer = HxViewer(gm, actor, sayCharacterName)

        // Closed by a GM, or at closes_at (drawn again when that time comes while the card is on screen).
        val closesAt = entry?.closesAt ?: doc.closesAt
        val closesTime = timeOf(closesAt)
        val closed = !entry?.closedAt.isNullOrEmpty() || entry?.closed == true || entry?.gone == true || (closesTime != null && closesTime <= facts.nowMillis)
        val reason = when {
            facts.spectator -> HxReason.SPECTATOR
            message.recalled -> HxReason.RECALLED
            message.chatWindowId != facts.openWindowId -> HxReason.HISTORY
            off == HxUnavailable.MISSING -> HxReason.MISSING
            off == HxUnavailable.DISABLED -> HxReason.DISABLED
            closed -> HxReason.CLOSED
            !facts.window?.text("archived_at").isNullOrEmpty() -> HxReason.ARCHIVED
            !gm && member?.flag("visibility_paused") == true -> HxReason.PAUSED
            !gm && member == null -> HxReason.MEMBER
            !actor -> HxReason.NOT_ACTOR
            entry?.loaded != true -> HxReason.LOADING
            else -> null
        }
        val state = HypertextPipeline.shownState(doc, entry)
        val resolved = Hypertext.resolve(doc, state, reason?.lock)
        val busy = entry?.pending == true || entry?.confirm != null
        val spent = entry?.runsLeft == 0
        var on = false; var posts = false
        Hypertext.walk(doc.body) { n, _ -> if (hasOn(n)) on = true; if (postsSomething(n)) posts = true }
        posts = posts || on
        val runsLeft = entry?.runsLeft
        val usesLeft = runsLeft?.takeIf { reason == null && posts && doc.runsPerViewer > 1 && it != 0 }
        val spentShown = reason == null && posts && spent
        val noEngine = reason == null && on && !facts.engine
        val working = reason == null && entry?.pending == true && entry.confirm == null
        val ownView = gm && !facts.spectator
        val closeShown = ownView && !closed && reason != HxReason.HISTORY && off == null && entry?.loaded == true
        val detailsShown = ownView && (entry?.failure != null || entry?.logs?.isNotEmpty() == true)
        val ooc = entry?.confirm?.kind == "ooc"
        return HxCardView(
            reason = reason, state = state, resolved = resolved, viewer = viewer,
            sayCharacterId = sayCharacter.takeIf { it.isNotEmpty() && it != characterId },
            engine = facts.engine, busy = busy, spent = spent, scriptControls = on, posting = posts, closed = closed,
            noEngineShown = noEngine, working = working, usesLeft = usesLeft, spentShown = spentShown,
            closeShown = closeShown, detailsShown = detailsShown,
            footerShown = reason != null || (on && !facts.engine) || usesLeft != null || spentShown || busy || ownView,
            confirmName = (if (ooc) null else sayCharacterName) ?: facts.displayName,
            closesInMillis = closesTime?.let { it - facts.nowMillis }?.takeIf { it > 0 && it <= Int.MAX_VALUE },
        )
    }
}
