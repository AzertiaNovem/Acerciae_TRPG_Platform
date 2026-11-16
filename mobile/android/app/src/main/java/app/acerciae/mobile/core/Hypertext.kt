package app.acerciae.mobile.core

import kotlinx.serialization.json.*

// Interactive messages (messages.kind = "hypertext", docs/HYPERTEXT.md), card format v1: a port of the web app's pure
// card logic (frontend/src/hypertext/types.ts, text.ts, format.ts, bindings.ts, dice.ts, effects.ts), which is the
// reference. The shared fixtures mobile/contracts/fixtures/hypertext.json and hypertext-client.json pin the port, so
// keep it as close to the TypeScript as Kotlin allows, and change the fixture first.
//
// Values stay JSON (kotlinx JsonElement), as on the wire: a state is a JsonObject of every declared key. Two things
// differ from JavaScript and are handled here: an absent key is Kotlin null while JSON null is JsonNull (JavaScript's
// undefined and null), and numbers keep their written form, so every integer is copied as a Long (1.0 is 1, -0 is 0).
// Strings are compared and scanned in UTF-16 units as JavaScript does; lengths count code points.

// ---- types (types.ts) ----

data class HxEnumValue(val value: String, val label: String)
sealed interface HxStateDecl { val type: String }
data object HxBoolDecl : HxStateDecl { override val type = "bool" }
data class HxIntDecl(val min: Long, val max: Long, val default: Long? = null) : HxStateDecl { override val type get() = "int" }
data class HxEnumDecl(val values: List<HxEnumValue>, val default: String? = null) : HxStateDecl { override val type get() = "enum" }
data class HxSetDecl(val values: List<HxEnumValue>, val max: Int) : HxStateDecl { override val type get() = "set" }
data class HxTextDecl(val max: Int) : HxStateDecl { override val type get() = "text" }

/** Conditions (`show_if`, `enable_if`): typed at post time, depth ≤3, ≤8 leaves. A leaf's [op] is eq, in, has, gte,
 *  lte or empty, its [arg] the literal it compares with. */
sealed interface HxCond
data class HxAll(val all: List<HxCond>) : HxCond
data class HxAny(val any: List<HxCond>) : HxCond
data class HxNot(val not: HxCond) : HxCond
data class HxLeaf(val key: String, val op: String, val arg: JsonElement) : HxCond

/** A button's declarative action, run natively without the engine: set first, then say (from the new state), then reply. */
data class HxAct(val set: JsonObject? = null, val say: String? = null, val sayKind: String? = null, val reply: String? = null)

sealed interface HxNode { val id: String?; val showIf: HxCond?; val type: String }
/** A control: it has an id, may be disabled by [enableIf] and may run the script handler [on]. */
sealed interface HxControl : HxNode { override val id: String; val enableIf: HxCond?; val on: String? }
data class HxTextNode(override val id: String?, override val showIf: HxCond?, val text: String, val style: String, val tone: String) : HxNode { override val type get() = "text" }
data class HxDivider(override val id: String?, override val showIf: HxCond?) : HxNode { override val type get() = "divider" }
data class HxCheckbox(override val id: String, override val showIf: HxCond?, override val enableIf: HxCond?, override val on: String?, val label: String, val bind: String) : HxControl { override val type get() = "checkbox" }
data class HxChoice(override val id: String, override val showIf: HxCond?, override val enableIf: HxCond?, override val on: String?, val label: String?, val bind: String, val display: String, val options: List<String>?) : HxControl { override val type get() = "choice" }
data class HxInput(override val id: String, override val showIf: HxCond?, override val enableIf: HxCond?, override val on: String?, val label: String?, val placeholder: String?, val bind: String, val submitLabel: String?) : HxControl { override val type get() = "input" }
data class HxButton(override val id: String, override val showIf: HxCond?, override val enableIf: HxCond?, override val on: String?, val label: String, val style: String, val act: HxAct?) : HxControl { override val type get() = "button" }
data class HxRow(override val id: String?, override val showIf: HxCond?, val children: List<HxNode>) : HxNode { override val type get() = "row" }
data class HxGroup(override val id: String?, override val showIf: HxCond?, val title: String?, val children: List<HxNode>) : HxNode { override val type get() = "group" }

/** Public stub of a private reply template: the text, kind, character and limits never leave the server. */
sealed interface HxSlotDecl
data class HxIntSlot(val min: Long, val max: Long) : HxSlotDecl
data class HxEnumSlot(val values: List<String>) : HxSlotDecl
data class HxReplyStub(val id: String, val slots: Map<String, HxSlotDecl>, val audience: String, val group: String?)

data class HxDoc(
    val title: String,
    val state: Map<String, HxStateDecl>,
    val body: List<HxNode>,
    val script: String?,
    val actors: List<String>?,
    val runsPerViewer: Int,
    val closesAt: String?,
    val replies: List<HxReplyStub>,
)

/** Why every control is disabled; null (no lock) when the viewer may act. */
enum class HxLockReason(val wire: String) {
    CLOSED("closed"), RECALLED("recalled"), NOT_ACTOR("not_actor"), SPECTATOR("spectator"), HISTORY("history"),
    ARCHIVED("archived"), PAUSED("paused"), LOADING("loading");
    companion object { fun of(wire: String?): HxLockReason? = entries.firstOrNull { it.wire == wire } }
}
data class HxOption(val value: String, val label: String, val selected: Boolean, val disabled: Boolean)
/** One node as drawn, in document order (containers before their children). [value] is null when the state has no
 *  such key (JavaScript's undefined); a null enum is JsonNull. */
data class HxResolved(
    val node: HxNode,
    val text: String? = null,
    val label: String? = null,
    val caption: String? = null,
    val value: JsonElement? = null,
    val options: List<HxOption>? = null,
    val visible: Boolean,
    val disabled: Boolean,
)

/** UI actions on a control. Toggle: checkbox. Select: a choice option (an enum selects, a set toggles). Submit: an input
 *  (fires its handler). Commit: an input's draft written on blur, which fires no handler. Click: a button. */
sealed interface HxAction {
    data object Toggle : HxAction
    data class Select(val value: String) : HxAction
    data class Submit(val value: String) : HxAction
    data class Commit(val value: String) : HxAction
    data object Click : HxAction
}
/** What a script handler gets: [type] change, submit or click. */
data class HxEvent(val type: String, val node: String, val value: JsonElement) {
    fun json() = buildJsonObject { put("type", type); put("node", node); put("value", value) }
}
data class HxApplied(val state: JsonObject, val event: HxEvent?)

sealed interface HxEffect { fun json(): JsonObject }
/** A line as the viewer; [kind] ic or ooc. */
data class HxSay(val text: String, val kind: String) : HxEffect {
    override fun json() = buildJsonObject { put("type", "say"); put("text", text); put("kind", kind) }
}
/** One of the sender's declared replies, with its slots filled. */
data class HxReply(val id: String, val slots: JsonObject) : HxEffect {
    override fun json() = buildJsonObject { put("type", "reply"); put("id", id); put("slots", slots) }
}
data class HxActed(val state: JsonObject, val effects: List<HxEffect>)

data class HxViewer(val gm: Boolean, val actor: Boolean, val character: String?) {
    fun json() = buildJsonObject { put("gm", gm); put("actor", actor); put("character", character) }
}
/** What a say needs before it is sent: the viewer's confirmation ([sheet]: the command changes their sheet). */
data class HxConfirm(val text: String, val kind: String, val sheet: Boolean = false)
data class HxEngineError(val code: String, val message: String, val line: Long? = null)
sealed interface HxRunResult
data class HxRunOk(val state: JsonObject, val effects: List<HxEffect>, val notices: List<String>, val logs: List<String>, val confirm: HxConfirm?, val changed: Boolean) : HxRunResult
data class HxRunFailed(val error: HxEngineError, val logs: List<String> = emptyList()) : HxRunResult

sealed interface HxValidated
data class HxValidState(val state: JsonObject) : HxValidated
/** [key]: the offending key, "" for the whole state. */
data class HxInvalidState(val key: String, val error: String) : HxValidated

object Hypertext {
    const val KIND = "hypertext"
    /** Shown under a card's plain text when this app cannot read the card. */
    const val UPDATE_APP = "Update the app to use this message."

    // ---- JSON values ----

    private val NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")
    /** A JSON number's value; null for anything else (a string "1" is not a number). */
    fun numberOf(e: JsonElement?): Double? {
        val p = e as? JsonPrimitive ?: return null
        if (p is JsonNull || p.isString || !NUMBER.matches(p.content)) return null
        return p.content.toDoubleOrNull()
    }
    /** Number.isInteger: a number with no fraction (any size). */
    fun integerOf(e: JsonElement?): Double? = numberOf(e)?.takeIf { !it.isInfinite() && it == Math.floor(it) }
    fun isBool(e: JsonElement?): Boolean = e is JsonPrimitive && e !is JsonNull && !e.isString && (e.content == "true" || e.content == "false")
    fun boolOf(e: JsonElement?): Boolean? = if (isBool(e)) (e as JsonPrimitive).content == "true" else null
    fun stringOf(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun isInt(e: JsonElement?, lim: Double = LIMITS.int): Boolean = integerOf(e)?.let { Math.abs(it) <= lim } ?: false

    /** A value as JavaScript would hold it: integers as Longs, so they print and compare as the web's do. */
    fun canon(e: JsonElement): JsonElement = when {
        e is JsonArray -> JsonArray(e.map(::canon))
        e is JsonObject -> JsonObject(e.mapValues { canon(it.value) })
        else -> integerOf(e)?.takeIf { Math.abs(it) < 9.0e15 }?.let { JsonPrimitive(it.toLong()) } ?: e
    }
    /** JavaScript `===` on two state values: primitives by value, arrays never (they are compared item by item where
     *  that is meant). Null is an absent key. */
    fun same(a: JsonElement?, b: JsonElement?): Boolean {
        if (a == null || b == null) return a == null && b == null
        if (a !is JsonPrimitive || b !is JsonPrimitive) return false
        if (a is JsonNull || b is JsonNull) return a is JsonNull && b is JsonNull
        if (a.isString || b.isString) return a.isString && b.isString && a.content == b.content
        val x = numberOf(a); val y = numberOf(b)
        if (x != null || y != null) return x != null && y != null && x == y
        return a.content == b.content
    }
    // JavaScript truthiness, for a checkbox's `!value`.
    private fun truthy(e: JsonElement?): Boolean = when {
        e == null || e is JsonNull -> false
        e is JsonPrimitive && e.isString -> e.content.isNotEmpty()
        e is JsonPrimitive -> numberOf(e)?.let { it != 0.0 && !it.isNaN() } ?: (e.content == "true")
        else -> true
    }
    private fun obj(map: Map<String, JsonElement>) = JsonObject(LinkedHashMap(map))

    // ---- text rules (text.ts) ----
    // Lengths count code points. Refused: C0 controls (except \n where the text is multi-line), bidi embeddings,
    // overrides and isolates (U+202A–202E, U+2066–2069) so a card cannot spoof its frame or the provenance pill, lone
    // surrogates and noncharacters.

    fun cpLength(s: String): Int = s.codePointCount(0, s.length)
    fun cpPrefix(s: String, n: Int): String = if (cpLength(s) <= n) s else s.substring(0, s.offsetByCodePoints(0, n))

    /** UTF-8 byte length (lone surrogates count as the 3 bytes of U+FFFD, as TextEncoder writes them). */
    fun utf8Bytes(s: String): Int {
        var n = 0; var i = 0
        while (i < s.length) {
            val c = s[i].code
            when {
                c < 0x80 -> n += 1
                c < 0x800 -> n += 2
                c in 0xd800..0xdbff && i + 1 < s.length && (s[i + 1].code and 0xfc00) == 0xdc00 -> { n += 4; i++ }
                else -> n += 3
            }
            i++
        }
        return n
    }

    /** The first refused code point's index (in UTF-16 units), or -1 when the text is allowed. */
    fun badCharAt(s: String, multiline: Boolean = false): Int {
        var i = 0
        while (i < s.length) {
            val c = s[i].code
            if (c < 0x20) { if (c == 0x0a && multiline) { i++; continue }; return i }
            if (c in 0x202a..0x202e || c in 0x2066..0x2069) return i
            if (c in 0xd800..0xdbff) {
                val d = if (i + 1 < s.length) s[i + 1].code else 0
                if ((d and 0xfc00) != 0xdc00) return i
                val cp = ((c - 0xd800) shl 10) + (d - 0xdc00) + 0x10000
                if ((cp and 0xfffe) == 0xfffe) return i
                i += 2; continue
            }
            if (c in 0xdc00..0xdfff) return i
            if (c in 0xfdd0..0xfdef || c == 0xfffe || c == 0xffff) return i
            i++
        }
        return -1
    }
    fun textOk(s: String, multiline: Boolean = false) = badCharAt(s, multiline) < 0
    /** An allowed string of [min] to [max] code points. */
    fun boundedText(s: String, max: Int, multiline: Boolean = false, min: Int = 0): Boolean = textOk(s, multiline) && cpLength(s).let { it >= min && it <= max }
    fun boundedText(e: JsonElement?, max: Int, multiline: Boolean = false, min: Int = 0): Boolean = stringOf(e)?.let { boundedText(it, max, multiline, min) } ?: false

    /** Refused characters become U+FFFD: for diagnostics (logs, error messages) that are shown, never sent. */
    fun sanitize(text: String, multiline: Boolean = true): String {
        val out = StringBuilder(); var s = text
        while (true) {
            val i = badCharAt(s, multiline)
            if (i < 0) break
            val pair = (s[i].code and 0xfc00) == 0xd800 && i + 1 < s.length && (s[i + 1].code and 0xfc00) == 0xdc00
            out.append(s, 0, i).append('\ufffd'); s = s.substring(i + if (pair) 2 else 1)
        }
        return out.append(s).toString()
    }

    /** Lines as a reader sees them: \n, and the breaks the text rules let through (U+0085, U+2028, U+2029). */
    fun lineCount(s: String): Int = 1 + s.count { it == '\n' || it == '\u0085' || it == '\u2028' || it == '\u2029' }

    /** Nesting depth of a JSON text, scanned before parsing so a deep document cannot exhaust the parser's stack. */
    fun jsonDepth(raw: String): Int {
        var depth = 0; var max = 0; var str = false; var i = 0
        while (i < raw.length) {
            val c = raw[i]
            if (str) { if (c == '\\') i++ else if (c == '"') str = false; i++; continue }
            when (c) {
                '"' -> str = true
                '[', '{' -> { depth++; if (depth > max) max = depth }
                ']', '}' -> depth--
                else -> {}
            }
            i++
        }
        return max
    }

    /** Trim as the server does (C++ text::trim: ASCII whitespace only, so a full-width space is kept). */
    fun asciiTrim(s: String): String {
        fun ws(c: Char) = c == ' ' || c.code in 0x09..0x0d
        var a = 0; var b = s.length
        while (a < b && ws(s[a])) a++
        while (b > a && ws(s[b - 1])) b--
        return s.substring(a, b)
    }

    // Ids, state keys and handler names: ^[a-z][a-z0-9_]{0,31}$, never a JavaScript prototype name (the server's
    // kReserved list; the names that start with "_" already fail the pattern).
    private val ID = Regex("[a-z][a-z0-9_]{0,31}")
    private val RESERVED = setOf("constructor", "prototype", "hasownproperty", "isprototypeof", "propertyisenumerable", "tolocalestring", "tostring", "valueof")
    fun isId(s: String?): Boolean = s != null && ID.matches(s) && s !in RESERVED
    fun isId(e: JsonElement?): Boolean = isId(stringOf(e))

    /** U+2068 … U+2069 around a card or user string, so it cannot reorder the sentence, frame or pill it is placed in. */
    fun isolate(s: String) = "\u2068$s\u2069"
    private val PLACEHOLDER = Regex("\\{(\\w+)\\}")
    /** A translated sentence with its `{placeholders}` replaced by isolated values (the app's tr() has none). One pass,
     *  so an inserted value is never read as a placeholder; an unknown one is left as written. */
    fun fill(translated: String, vararg values: Pair<String, String>): String {
        val map = values.toMap()
        return PLACEHOLDER.replace(translated) { m -> map[m.groupValues[1]]?.let(::isolate) ?: m.value }
    }

    // ---- reading a stored card (format.ts) ----
    // The server is the validator: it accepts only v1 and refuses unknown keys. A client only needs to know whether it
    // can draw and run the card safely, so parseDoc returns a normalized copy (known fields only) or null for an unknown
    // `v` or anything malformed; the message then shows its plain-text `content` with UPDATE_APP. It never throws.
    // What it fills in, as the server's normalize does: title "", a value's label = its value, text style body and tone
    // neutral, choice display list, button style primary, enum default null, script null, actors null, runs_per_viewer
    // 1, closes_at null, replies [], a stub's slots {}, audience card and group null; act.say is kept ASCII-trimmed.

    object LIMITS {
        const val title = 120; const val stateKeys = 32; const val enumValues = 20; const val valueLen = 64; const val labelLen = 120
        const val setMax = 20; const val textMax = 500; const val int = 1e9; const val nodes = 64; const val text = 2000; const val label = 120
        const val buttonLabel = 60; const val submitLabel = 40; const val groupTitle = 80; const val script = 16384; const val actors = 10
        const val runs = 100; const val replies = 16; const val slots = 4; const val condDepth = 3; const val condLeaves = 8; const val say = 500
        const val stateBytes = 8192
    }

    private class Malformed : RuntimeException(null, null, false, false)
    private fun fail(): Nothing = throw Malformed()
    private fun need(ok: Boolean) { if (!ok) fail() }
    private fun optText(v: JsonElement?, max: Int) = v == null || boundedText(v, max)
    private fun pick(v: JsonElement?, allowed: List<String>, dflt: String): String {
        if (v == null) return dflt
        val s = stringOf(v); need(s != null && s in allowed); return s!!
    }
    private class Counter { var n = 0 }

    private fun enumValues(v: JsonElement?): List<HxEnumValue> {
        val list = v as? JsonArray ?: fail()
        need(list.size >= 2 && list.size <= LIMITS.enumValues)
        val seen = HashSet<String>()
        return list.map { x ->
            val o = x as? JsonObject ?: fail()
            val value = o["value"]; val label = o["label"]
            need(boundedText(value, LIMITS.valueLen, false, 1) && (label == null || boundedText(label, LIMITS.labelLen)) && stringOf(value)!! !in seen)
            seen.add(stringOf(value)!!)
            HxEnumValue(stringOf(value)!!, stringOf(label) ?: stringOf(value)!!)
        }
    }
    private fun stateDecl(v: JsonElement?): HxStateDecl {
        val d = v as? JsonObject ?: fail()
        when (stringOf(d["type"])) {
            "bool" -> return HxBoolDecl
            "int" -> {
                need(isInt(d["min"]) && isInt(d["max"]) && integerOf(d["min"])!! <= integerOf(d["max"])!!)
                val min = integerOf(d["min"])!!.toLong(); val max = integerOf(d["max"])!!.toLong()
                if (d["default"] == null) return HxIntDecl(min, max)
                need(isInt(d["default"]) && integerOf(d["default"])!! >= min && integerOf(d["default"])!! <= max)
                return HxIntDecl(min, max, integerOf(d["default"])!!.toLong())
            }
            "enum" -> {
                val values = enumValues(d["values"]); val dflt = d["default"]
                if (dflt == null || dflt is JsonNull) return HxEnumDecl(values, null)
                need(values.any { same(JsonPrimitive(it.value), dflt) }); return HxEnumDecl(values, stringOf(dflt))
            }
            "set" -> { val values = enumValues(d["values"]); need(isInt(d["max"]) && integerOf(d["max"])!! >= 1 && integerOf(d["max"])!! <= LIMITS.setMax); return HxSetDecl(values, integerOf(d["max"])!!.toInt()) }
            "text" -> { need(isInt(d["max"]) && integerOf(d["max"])!! >= 1 && integerOf(d["max"])!! <= LIMITS.textMax); return HxTextDecl(integerOf(d["max"])!!.toInt()) }
        }
        fail()
    }
    private fun names(d: HxStateDecl): List<String> = when (d) { is HxEnumDecl -> d.values.map { it.value }; is HxSetDecl -> d.values.map { it.value }; else -> emptyList() }
    private fun valuesOf(d: HxStateDecl): List<HxEnumValue> = when (d) { is HxEnumDecl -> d.values; is HxSetDecl -> d.values; else -> emptyList() }

    /** Whether a value fits a reply slot: a declared enum string, or an integer within the slot's range. */
    fun slotOk(d: HxSlotDecl, v: JsonElement?): Boolean = when (d) {
        is HxEnumSlot -> stringOf(v)?.let { it in d.values } ?: false
        is HxIntSlot -> integerOf(v)?.let { it >= d.min && it <= d.max } ?: false
    }

    /** Whether a literal is a valid value of a declaration (also the check of validateState, per key). */
    fun validValue(d: HxStateDecl, v: JsonElement?): Boolean = when (d) {
        is HxBoolDecl -> isBool(v)
        is HxIntDecl -> integerOf(v)?.let { it >= d.min && it <= d.max } ?: false
        is HxEnumDecl -> v is JsonNull || (stringOf(v)?.let { s -> d.values.any { it.value == s } } ?: false)
        is HxSetDecl -> v is JsonArray && v.size <= d.max && v.all { x -> stringOf(x)?.let { s -> d.values.any { it.value == s } } ?: false } && v.map { stringOf(it) }.toSet().size == v.size
        is HxTextDecl -> boundedText(v, d.max)
    }

    private fun declOf(decls: Map<String, HxStateDecl>, key: JsonElement?): HxStateDecl = declOf(decls, stringOf(key))
    private fun declOf(decls: Map<String, HxStateDecl>, key: String?): HxStateDecl { need(isId(key) && decls.containsKey(key)); return decls[key]!! }
    private fun isValue(d: HxStateDecl, v: JsonElement?): Boolean = when (d) {
        is HxEnumDecl -> stringOf(v)?.let { s -> d.values.any { it.value == s } } ?: false
        is HxIntDecl -> isInt(v)
        else -> false
    }

    private fun cond(v: JsonElement?, decls: Map<String, HxStateDecl>, depth: Int, leaves: Counter): HxCond {
        val c = v as? JsonObject; need(c != null && depth <= LIMITS.condDepth); c!!
        fun list(x: JsonElement?): List<HxCond> { val a = x as? JsonArray; need(a != null && a.size >= 1); return a!!.map { cond(it, decls, depth + 1, leaves) } }
        if (c.containsKey("all")) { need(c.size == 1); return HxAll(list(c["all"])) }
        if (c.containsKey("any")) { need(c.size == 1); return HxAny(list(c["any"])) }
        if (c.containsKey("not")) { need(c.size == 1); return HxNot(cond(c["not"], decls, depth + 1, leaves)) }
        need(++leaves.n <= LIMITS.condLeaves)
        val ops = c.keys.filter { it != "key" }; need(ops.size == 1)
        val d = declOf(decls, c["key"]); val key = stringOf(c["key"])!!; val op = ops[0]; val x = c[op]!!
        when (op) {
            "eq" -> {
                need(when (d) { is HxBoolDecl -> isBool(x); is HxIntDecl -> isInt(x); is HxEnumDecl -> x is JsonNull || isValue(d, x); is HxTextDecl -> boundedText(x, d.max); is HxSetDecl -> false })
                return HxLeaf(key, op, canon(x))
            }
            "in" -> { need((d is HxEnumDecl || d is HxIntDecl) && x is JsonArray && x.size >= 1 && x.size <= LIMITS.enumValues && x.all { isValue(d, it) }); return HxLeaf(key, op, canon(x)) }
            "has" -> { need(d is HxSetDecl && stringOf(x)?.let { it in names(d) } == true); return HxLeaf(key, op, x) }
            "gte", "lte" -> { need(d is HxIntDecl && isInt(x)); return HxLeaf(key, op, canon(x)) }
            "empty" -> { need((d is HxTextDecl || d is HxSetDecl || d is HxEnumDecl) && isBool(x)); return HxLeaf(key, op, x) }
        }
        fail()
    }

    private fun slotDecl(v: JsonElement?): HxSlotDecl {
        val s = v as? JsonObject ?: fail()
        if (stringOf(s["type"]) == "int") {
            need(isInt(s["min"]) && isInt(s["max"]) && integerOf(s["min"])!! <= integerOf(s["max"])!!)
            return HxIntSlot(integerOf(s["min"])!!.toLong(), integerOf(s["max"])!!.toLong())
        }
        val values = s["values"] as? JsonArray
        need(stringOf(s["type"]) == "enum" && values != null && values.size >= 1 && values.size <= LIMITS.enumValues && values.all { boundedText(it, LIMITS.valueLen, false, 1) })
        return HxEnumSlot(values!!.map { stringOf(it)!! })
    }
    private fun replyStub(v: JsonElement?): HxReplyStub {
        val r = v as? JsonObject ?: fail()
        need(isId(r["id"]) && (r["slots"] == null || r["slots"] is JsonObject))
        val raw = r["slots"] as? JsonObject ?: JsonObject(emptyMap())
        need(raw.size <= LIMITS.slots)
        val slots = LinkedHashMap<String, HxSlotDecl>()
        for ((k, s) in raw) { need(isId(k)); slots[k] = slotDecl(s) }
        val group = r["group"]
        need(group == null || group is JsonNull || isId(group))
        return HxReplyStub(stringOf(r["id"])!!, slots, pick(r["audience"], listOf("card", "viewer", "gm"), "card"), stringOf(group))
    }

    private fun act(v: JsonElement?, decls: Map<String, HxStateDecl>, replies: List<HxReplyStub>): HxAct {
        val a = v as? JsonObject ?: fail()
        var set: JsonObject? = null; var say: String? = null; var sayKind: String? = null; var reply: String? = null
        a["set"]?.let { raw ->
            val o = raw as? JsonObject ?: fail()
            set = JsonObject(o.entries.associateTo(LinkedHashMap()) { (k, x) -> need(validValue(declOf(decls, k), x)); k to canon(x) })
        }
        // Checked and kept as posted: ASCII-trimmed, as the server checks it (sayError) and the say is posted.
        a["say"]?.let { raw -> val s = stringOf(raw); need(s != null && boundedText(asciiTrim(s), LIMITS.say, true, 1)); say = asciiTrim(s!!) }
        a["say_kind"]?.let { raw -> need(a["say"] != null); sayKind = pick(raw, listOf("ic", "ooc"), "ic") }
        a["reply"]?.let { raw ->
            val stub = stringOf(raw)?.let { id -> replies.firstOrNull { it.id == id } } ?: fail()
            // Each slot is filled from the state key of the same name.
            for ((k, s) in stub.slots) { val d = declOf(decls, k); need(if (s is HxIntSlot) d is HxIntDecl else d is HxEnumDecl) }
            reply = stub.id
        }
        need(set != null || say != null || reply != null)
        return HxAct(set, say, sayKind, reply)
    }

    private fun node(v: JsonElement?, decls: Map<String, HxStateDecl>, replies: List<HxReplyStub>, level: Int, ids: MutableSet<String>, count: Counter): HxNode {
        val n = v as? JsonObject; need(n != null && ++count.n <= LIMITS.nodes); n!!
        var id: String? = null
        n["id"]?.let { raw -> need(isId(raw) && stringOf(raw)!! !in ids); id = stringOf(raw); ids.add(id!!) }
        val showIf = n["show_if"]?.let { cond(it, decls, 1, Counter()) }
        fun controlId(): String { need(id != null); return id!! }
        fun enableIf() = n["enable_if"]?.let { cond(it, decls, 1, Counter()) }
        fun on() = n["on"]?.let { raw -> need(isId(raw)); stringOf(raw) }
        fun bound(vararg types: String): HxStateDecl { val d = declOf(decls, n["bind"]); need(d.type in types); return d }
        fun children(lv: Int): List<HxNode> { val list = n["children"] as? JsonArray ?: fail(); return list.map { node(it, decls, replies, lv, ids, count) } }
        val bind = stringOf(n["bind"]).orEmpty()
        when (stringOf(n["type"])) {
            "text" -> {
                need(boundedText(n["text"], LIMITS.text, true))
                return HxTextNode(id, showIf, stringOf(n["text"])!!, pick(n["style"], listOf("body", "muted", "heading", "strong"), "body"), pick(n["tone"], listOf("neutral", "good", "bad", "warn"), "neutral"))
            }
            "divider" -> return HxDivider(id, showIf)
            "checkbox" -> {
                val cid = controlId(); val ei = enableIf(); val on = on(); bound("bool"); need(boundedText(n["label"], LIMITS.label))
                return HxCheckbox(cid, showIf, ei, on, stringOf(n["label"])!!, bind)
            }
            "choice" -> {
                val cid = controlId(); val ei = enableIf(); val on = on(); val d = bound("enum", "set")
                need(optText(n["label"], LIMITS.label))
                val display = pick(n["display"], listOf("list", "buttons", "menu"), "list")
                val options = n["options"]?.let { raw ->
                    val list = raw as? JsonArray
                    need(list != null && list.size >= 1 && list.all { o -> stringOf(o)?.let { it in names(d) } == true } && list.map { stringOf(it) }.toSet().size == list.size)
                    list!!.map { stringOf(it)!! }
                }
                return HxChoice(cid, showIf, ei, on, stringOf(n["label"]), bind, display, options)
            }
            "input" -> {
                val cid = controlId(); val ei = enableIf(); val on = on(); bound("text")
                need(optText(n["label"], LIMITS.label) && optText(n["placeholder"], LIMITS.label) && optText(n["submit_label"], LIMITS.submitLabel))
                return HxInput(cid, showIf, ei, on, stringOf(n["label"]), stringOf(n["placeholder"]), bind, stringOf(n["submit_label"]))
            }
            "button" -> {
                val cid = controlId(); val ei = enableIf(); val on = on()
                need(boundedText(n["label"], LIMITS.buttonLabel) && (on == null) != (n["act"] == null))
                val style = pick(n["style"], listOf("primary", "secondary", "danger"), "primary")
                return HxButton(cid, showIf, ei, on, stringOf(n["label"])!!, style, n["act"]?.let { act(it, decls, replies) })
            }
            "row" -> { need(level < 2); return HxRow(id, showIf, children(2)) }
            "group" -> { need(level == 0 && optText(n["title"], LIMITS.groupTitle)); return HxGroup(id, showIf, stringOf(n["title"]), children(1)) }
        }
        fail()
    }

    /** A stored card (messages.hypertext) or a post body, normalized; null for an unknown `v` or anything malformed. */
    fun parseDoc(raw: JsonElement?): HxDoc? = try {
        val r = raw as? JsonObject ?: fail()
        need(numberOf(r["v"]) == 1.0 && (r["title"] == null || boundedText(r["title"], LIMITS.title)))
        need(r["state"] == null || r["state"] is JsonObject)
        val stateRaw = r["state"] as? JsonObject ?: JsonObject(emptyMap())
        need(stateRaw.size <= LIMITS.stateKeys)
        val decls = LinkedHashMap<String, HxStateDecl>()
        for ((k, d) in stateRaw) { need(isId(k)); decls[k] = stateDecl(d) }
        need(r["replies"] == null || (r["replies"] is JsonArray && (r["replies"] as JsonArray).size <= LIMITS.replies))
        val replies = ((r["replies"] as? JsonArray) ?: JsonArray(emptyList())).map(::replyStub)
        need(replies.map { it.id }.toSet().size == replies.size)
        val bodyRaw = r["body"] as? JsonArray; need(bodyRaw != null && bodyRaw.size >= 1)
        val ids = HashSet<String>(); val count = Counter()
        val body = bodyRaw!!.map { node(it, decls, replies, 0, ids, count) }
        val script = r["script"]; val actors = r["actors"]; val runs = r["runs_per_viewer"]; val closes = r["closes_at"]
        need(script == null || script is JsonNull || (stringOf(script) != null && utf8Bytes(stringOf(script)!!) <= LIMITS.script))
        need(actors == null || actors is JsonNull || (actors is JsonArray && actors.size <= LIMITS.actors && actors.all { stringOf(it) != null }))
        need(runs == null || (isInt(runs) && integerOf(runs)!! >= 1 && integerOf(runs)!! <= LIMITS.runs))
        need(closes == null || closes is JsonNull || stringOf(closes) != null)
        HxDoc(
            title = stringOf(r["title"]) ?: "", state = decls, body = body, script = stringOf(script)?.ifEmpty { null },
            actors = (actors as? JsonArray)?.map { stringOf(it)!! }, runsPerViewer = integerOf(runs)?.toInt() ?: 1,
            closesAt = stringOf(closes), replies = replies,
        )
    } catch (_: Exception) { null }

    /** Every node, depth first in document order. */
    fun walk(body: List<HxNode>, depth: Int = 0, visit: (HxNode, Int) -> Unit) {
        for (n in body) { visit(n, depth); when (n) { is HxRow -> walk(n.children, depth + 1, visit); is HxGroup -> walk(n.children, depth + 1, visit); else -> {} } }
    }
    fun findNode(doc: HxDoc, id: String): HxNode? { var found: HxNode? = null; walk(doc.body) { n, _ -> if (found == null && n.id == id) found = n }; return found }
    /** Whether any control runs a script handler (only such cards ever start the engine). */
    fun scripted(doc: HxDoc): Boolean { var s = false; walk(doc.body) { n, _ -> if ((n as? HxControl)?.on != null) s = true }; return s && doc.script != null }

    // ---- state, conditions, interpolation, drawing, actions (bindings.ts) ----

    fun defaultOf(d: HxStateDecl): JsonElement = when (d) {
        is HxBoolDecl -> JsonPrimitive(false)
        is HxIntDecl -> JsonPrimitive(d.default ?: d.min)
        is HxEnumDecl -> d.default?.let(::JsonPrimitive) ?: JsonNull
        is HxSetDecl -> JsonArray(emptyList())
        is HxTextDecl -> JsonPrimitive("")
    }
    fun defaultState(doc: HxDoc): JsonObject = JsonObject(doc.state.entries.associateTo(LinkedHashMap()) { (k, d) -> k to defaultOf(d) })
    /** A stored state laid over the defaults: undeclared keys are dropped, a bad value falls back to its default. */
    fun overlay(doc: HxDoc, stored: JsonElement?): JsonObject {
        val s = LinkedHashMap(defaultState(doc))
        if (stored !is JsonObject) return JsonObject(s)
        for (k in s.keys) { val v = stored[k]; if (v != null && validValue(doc.state[k]!!, v)) s[k] = canon(v) }
        return JsonObject(s)
    }

    /** A state as the server's validateState reads it (PUT /hypertext/state, /act): only declared keys, each a valid
     *  value; a missing key takes its default. The state given back is complete (sets in schema order), at most 8 KiB
     *  serialized. On failure the key is the first offending one in sorted order, as on the server. */
    fun validateState(doc: HxDoc, state: JsonElement?): HxValidated {
        val o = state as? JsonObject ?: return HxInvalidState("", "state must be an object")
        val full = LinkedHashMap(defaultState(doc))
        for (k in o.keys.sorted()) {
            val d = doc.state[k] ?: return HxInvalidState(k, "state.${k.take(40)}: not declared")
            val v = o[k]
            if (!validValue(d, v)) return HxInvalidState(k, "state.$k: not a valid ${d.type}")
            full[k] = if (d is HxSetDecl) JsonArray(d.values.map { it.value }.filter { x -> (v as JsonArray).any { stringOf(it) == x } }.map(::JsonPrimitive)) else canon(v!!)
        }
        if (utf8Bytes(JsonObject(full).toString()) > LIMITS.stateBytes) return HxInvalidState("", "state is larger than 8 KiB")
        return HxValidState(JsonObject(full))
    }

    // A key's value for conditions and interpolation: the state's when it is valid, else the default (C++ valueOf).
    private fun valueAt(doc: HxDoc, state: JsonObject, key: String): JsonElement {
        val d = doc.state[key]!!; val v = state[key]
        return if (v != null && validValue(d, v)) v else defaultOf(d)
    }

    fun evalCondition(c: HxCond, doc: HxDoc, state: JsonObject): Boolean = when (c) {
        is HxAll -> c.all.all { evalCondition(it, doc, state) }
        is HxAny -> c.any.any { evalCondition(it, doc, state) }
        is HxNot -> !evalCondition(c.not, doc, state)
        is HxLeaf -> {
            val d = doc.state[c.key]
            if (d == null) false else {
                val v = valueAt(doc, state, c.key)
                when (c.op) {
                    "eq" -> same(v, c.arg)
                    "in" -> (c.arg as? JsonArray)?.any { same(it, v) } ?: false
                    "has" -> v is JsonArray && v.any { same(it, c.arg) }
                    "gte" -> numberOf(v)?.let { x -> numberOf(c.arg)?.let { x >= it } } ?: false
                    "lte" -> numberOf(v)?.let { x -> numberOf(c.arg)?.let { x <= it } } ?: false
                    "empty" -> {
                        val empty = when (d) { is HxTextDecl -> stringOf(v) == ""; is HxSetDecl -> v is JsonArray && v.isEmpty(); is HxEnumDecl -> v is JsonNull; else -> false }
                        empty == boolOf(c.arg)
                    }
                    else -> false
                }
            }
        }
    }

    private fun keyChar(c: Char) = c in 'a'..'z' || c in '0'..'9' || c == '_'
    /** `{{key}}`: an enum's label ("" when null), a set's labels in schema order joined with ", ", an int in decimal, a
     *  text as is. A bool or an unknown key is a post-time error, so it is left as written. The server's scan: each
     *  "{{" either starts a declared key followed by "}}" or is kept, and the scan resumes after it. */
    fun interpolate(text: String, doc: HxDoc, state: JsonObject): String {
        val out = StringBuilder(); var start = 0
        while (true) {
            val i = text.indexOf("{{", start)
            if (i < 0) break
            out.append(text, start, i)
            var j = i + 2
            while (j < text.length && keyChar(text[j])) j++
            val key = text.substring(i + 2, j)
            val d = if (j > i + 2 && text.startsWith("}}", j)) doc.state[key] else null
            if (d == null || d is HxBoolDecl) { out.append("{{"); start = i + 2; continue }
            val v = valueAt(doc, state, key)
            out.append(when (d) {
                is HxEnumDecl -> d.values.firstOrNull { same(JsonPrimitive(it.value), v) }?.label ?: ""
                is HxSetDecl -> d.values.filter { x -> (v as? JsonArray)?.any { stringOf(it) == x.value } == true }.joinToString(", ") { it.label }
                is HxIntDecl -> integerOf(v)!!.toLong().toString()
                else -> stringOf(v).orEmpty()
            })
            start = j + 2
        }
        return out.append(text, start, text.length).toString()
    }

    private fun optionsOf(doc: HxDoc, n: HxChoice): List<HxEnumValue> {
        val values = valuesOf(doc.state[n.bind]!!)
        return n.options?.map { o -> values.first { it.value == o } } ?: values
    }

    /** Every node as drawn, in document order. Any lock disables every control; show_if hides (with the node's
     *  children), enable_if disables; a set's unselected options are disabled once it holds `max` values; a button
     *  whose act replies is disabled while a slot cannot be filled from the state (a null enum, or a value the slot
     *  does not list). */
    fun resolve(doc: HxDoc, state: JsonObject, lock: HxLockReason?): List<HxResolved> {
        val out = ArrayList<HxResolved>(); val locked = lock != null
        fun visit(nodes: List<HxNode>, shown: Boolean) {
            for (n in nodes) {
                val visible = shown && (n.showIf == null || evalCondition(n.showIf!!, doc, state))
                var disabled = n is HxControl && (locked || (n.enableIf != null && !evalCondition(n.enableIf!!, doc, state)))
                var r = HxResolved(n, visible = visible, disabled = disabled)
                when (n) {
                    is HxTextNode -> r = r.copy(text = interpolate(n.text, doc, state))
                    is HxGroup -> if (n.title != null) r = r.copy(label = interpolate(n.title, doc, state))
                    is HxCheckbox -> r = r.copy(label = interpolate(n.label, doc, state), value = state[n.bind])
                    is HxInput -> r = r.copy(label = n.label?.let { interpolate(it, doc, state) }, value = state[n.bind])
                    is HxChoice -> {
                        val v = state[n.bind]; val d = doc.state[n.bind]
                        val full = d is HxSetDecl && v is JsonArray && v.size >= d.max
                        r = r.copy(label = n.label?.let { interpolate(it, doc, state) }, value = v, options = optionsOf(doc, n).map { o ->
                            val selected = if (v is JsonArray) v.any { same(it, JsonPrimitive(o.value)) } else same(v, JsonPrimitive(o.value))
                            HxOption(o.value, o.label, selected, disabled || (full && !selected))
                        })
                    }
                    is HxButton -> {
                        var caption: String? = null
                        val a = if (n.act != null) act(doc, state, n.id) else null
                        for (e in a?.effects.orEmpty()) when (e) {
                            is HxSay -> caption = e.text
                            is HxReply -> if (!replyFits(doc, e.id, e.slots)) disabled = true
                        }
                        r = r.copy(label = interpolate(n.label, doc, state), caption = caption, disabled = disabled)
                    }
                    else -> {}
                }
                out.add(r)
                when (n) { is HxRow -> visit(n.children, visible); is HxGroup -> visit(n.children, visible); else -> {} }
            }
        }
        visit(doc.body, true)
        return out
    }

    private fun replyFits(doc: HxDoc, id: String, slots: JsonObject): Boolean {
        val stub = doc.replies.firstOrNull { it.id == id } ?: return false
        return stub.slots.all { (k, s) -> slotOk(s, slots[k]) }
    }

    /** A UI action on a control → the new state and the event its `on` handler gets (null for a commit, which fires no
     *  handler), or null when the action does not apply: an unknown, hidden or disabled control (under [lock] as well),
     *  the wrong action, a value that is not allowed, no change of a choice. */
    fun applyAction(doc: HxDoc, state: JsonObject, nodeId: String, action: HxAction, lock: HxLockReason? = null): HxApplied? {
        val r = resolve(doc, state, lock).firstOrNull { it.node.id == nodeId } ?: return null
        if (!r.visible || r.disabled) return null
        val s = LinkedHashMap(state)
        when (val n = r.node) {
            is HxCheckbox -> {
                if (action !is HxAction.Toggle) return null
                s[n.bind] = JsonPrimitive(!truthy(s[n.bind]))
                return HxApplied(JsonObject(s), HxEvent("change", n.id, s[n.bind]!!))
            }
            is HxChoice -> {
                if (action !is HxAction.Select) return null
                val o = r.options!!.firstOrNull { it.value == action.value } ?: return null
                if (o.disabled) return null
                val d = doc.state[n.bind]
                if (d is HxSetDecl) {
                    val v = (s[n.bind] as? JsonArray).orEmpty().mapNotNull(::stringOf)
                    val next = if (o.selected) v.filter { it != o.value } else v + o.value
                    s[n.bind] = JsonArray(d.values.map { it.value }.filter { it in next }.map(::JsonPrimitive))   // schema order
                } else {
                    if (o.selected) return null                                                                // no deselect
                    s[n.bind] = JsonPrimitive(o.value)
                }
                return HxApplied(JsonObject(s), HxEvent("change", n.id, s[n.bind]!!))
            }
            is HxInput -> {
                val value = when (action) { is HxAction.Submit -> action.value; is HxAction.Commit -> action.value; else -> return null }
                if (!validValue(doc.state[n.bind]!!, JsonPrimitive(value))) return null
                s[n.bind] = JsonPrimitive(value)
                if (validateState(doc, JsonObject(s)) !is HxValidState) return null
                return HxApplied(JsonObject(s), if (action is HxAction.Commit) null else HxEvent("submit", n.id, JsonPrimitive(value)))
            }
            is HxButton -> {
                if (action !is HxAction.Click) return null
                return HxApplied(JsonObject(s), HxEvent("click", n.id, JsonNull))
            }
            else -> return null
        }
    }

    /** A button's declarative act: `set` first, then `say` interpolated from the new state, then `reply`, whose slots
     *  are filled from the state keys of the same names. Null when the node has no act. It does not check the lock,
     *  show_if or enable_if: call it only for a click that applyAction accepted. Check the effects with checkEffects
     *  (as a script's) before anything is sent. */
    fun act(doc: HxDoc, state: JsonObject, nodeId: String): HxActed? {
        val n = findNode(doc, nodeId) as? HxButton ?: return null
        val a = n.act ?: return null
        val s = LinkedHashMap(state); val effects = ArrayList<HxEffect>()
        a.set?.forEach { (k, v) -> s[k] = v }
        a.say?.let { effects.add(HxSay(interpolate(it, doc, JsonObject(s)), a.sayKind ?: "ic")) }
        a.reply?.let { id ->
            val stub = doc.replies.first { it.id == id }; val slots = LinkedHashMap<String, JsonElement>()
            for (k in stub.slots.keys) s[k]?.let { slots[k] = it }
            effects.add(HxReply(stub.id, JsonObject(slots)))
        }
        return HxActed(JsonObject(s), effects)
    }

    // ---- dice (dice.ts) ----
    // Which dot commands a card may post as the clicker: a mirror of dice::parseCommand (backend/src/dice/Dice.cpp).
    // The C++ hypertext::diceVerdict is authoritative (the server re-checks every line); the shared fixture section
    // dice_policy pins both.

    data class HxCommand(val name: String, val args: String, val raw: String, val hidden: Boolean)
    private val LITERALS = listOf(
        "move" to "move", "init" to "init", "rah" to "ra", "rch" to "ra", "ra" to "ra", "rc" to "ra", "rih" to "ri", "ri" to "ri", "rh" to "r", "r" to "r",
        "sc" to "sc", "st" to "st", "en" to "en", "ds" to "ds", "ss" to "ss",
    )
    private fun lower(c: Int) = if (c in 0x41..0x5a) c + 32 else c

    fun parseCommand(content: String): HxCommand? {
        var s = asciiTrim(content)
        if (s.startsWith("。") || s.startsWith("．")) s = "." + s.substring(1)
        if (s.length < 2 || s[0] != '.') return null
        val rest = s.substring(1)
        for ((lit, name) in LITERALS) {
            val n = lit.length
            if (rest.length < n) continue
            if ((0 until n).any { lower(rest[it].code) != lit[it].code }) continue
            if (rest.length > n) {
                val c = rest[n]; val code = c.code
                // As in C++: ASCII space, a digit, any non-ASCII character, one of "(%#+-/" (strchr also finds the NUL
                // terminator), or a d after the bare r.
                val ok = c == ' ' || c == '\t' || c == '\n' || c == '\r' || code in 0x30..0x39 || code >= 0x80 || code == 0 || c in "(%#+-/" || (lit == "r" && (c == 'd' || c == 'D'))
                if (!ok) continue
            }
            return HxCommand(name, asciiTrim(rest.substring(n)), ".$lit", lit == "rah" || lit == "rch" || lit == "rh" || lit == "rih")
        }
        return null
    }

    private fun space(c: Int) = c == 0x20 || c in 0x09..0x0d   // C isspace in the C locale
    private fun digit(c: Int) = c in 0x30..0x39
    private fun alpha(c: Int) = (c or 0x20) in 0x61..0x7a          // ASCII letters only, as C isalpha

    /** ri/rih join the initiative order as the speaking character only when nothing in the arguments names someone
     *  else: signed modifiers (+2, - 1, +1d4, +d6) and the words adv/advantage/dis/disadvantage (any case), each ending
     *  at a space, a sign or the end. A port of hypertext::modifiersOnly. */
    fun modifiersOnly(args: String): Boolean {
        val n = args.length
        fun at(k: Int) = args[k].code
        fun boundary(k: Int) = k >= n || space(at(k)) || at(k) == 0x2b || at(k) == 0x2d
        var i = 0
        while (true) {
            while (i < n && space(at(i))) i++
            if (i >= n) return true
            if (at(i) == 0x2b || at(i) == 0x2d) {
                i++; while (i < n && space(at(i))) i++
                val a = i; while (i < n && digit(at(i))) i++
                val count = i > a
                if (i < n && (at(i) or 0x20) == 0x64) {                     // NdM, or dM
                    i++; val b = i; while (i < n && digit(at(i))) i++
                    if (i == b) return false
                } else if (!count) return false
                if (!boundary(i)) return false
            } else {
                val a = i; while (i < n && alpha(at(i))) i++
                val w = args.substring(a, i).lowercase()
                if ((w != "adv" && w != "advantage" && w != "dis" && w != "disadvantage") || !boundary(i)) return false
            }
        }
    }

    /** allowed: r/rh, ra/rc/rah/rch, ri/rih with modifiers only. confirm (the server answers 428): sc, ds, which change
     *  the sheet. refused: ri with a name, st, en, ss, init, move. none: not a command (free text, confirmed by the
     *  viewer). The same verdicts as hypertext::diceVerdict. */
    fun verdict(text: String): String {
        val cmd = parseCommand(text) ?: return "none"
        return when (cmd.name) {
            "r", "ra" -> "allowed"
            "ri" -> if (modifiersOnly(cmd.args)) "allowed" else "refused"
            "sc", "ds" -> "confirm"
            else -> "refused"
        }
    }

    // r/rh arguments that are only an expression: an optional "N#" repeat, then the characters of dice::parseRoll's
    // expression prefix with no space. Anything after it is posted as the roll's reason. (Whole-string matches: no
    // anchors, since Java's $ also matches before a final line break.)
    private val EXPRESSION = Regex("([0-9]+#[ \t\n\u000b\u000c\r]*)?[0-9dD%+\\-*/()kKhHlL]*")
    private val SIGNED_NUMBER = Regex("[+-]?[0-9]*")
    private val WORDS = Regex("[ \t]+")
    private fun breaksLine(c: Char) = c == '\n' || c == '\u000b' || c == '\u000c' || c == '\r' || c == '\u0085' || c == '\u2028' || c == '\u2029'
    /** Whether an allowed roll is nothing but the roll, so a script may post it as the clicker without asking: one line,
     *  and for r/rh only an expression; for ra/rc/rah/rch at most 32 code points and 3 words after the command, numbers
     *  and signed numbers not counted; for ri/rih modifiers only. */
    fun bareRoll(text: String): Boolean {
        val t = asciiTrim(text); val cmd = parseCommand(t)
        if (cmd == null || t.any(::breaksLine)) return false
        return when (cmd.name) {
            "r" -> EXPRESSION.matches(cmd.args)
            "ra" -> cpLength(cmd.args) <= 32 && cmd.args.split(WORDS).count { it.isNotEmpty() && !SIGNED_NUMBER.matches(it) } <= 3
            "ri" -> modifiersOnly(cmd.args)
            else -> false
        }
    }

    // ---- host validation of a run (effects.ts) ----
    // The bundle checks a run's output with the same effects.ts, but native code never trusts the page: everything is
    // checked again here before anything is shown or sent, and again by the server.

    object OUTPUT_LIMITS { const val depth = 16; const val sayCp = 500; const val sayLines = 5; const val notices = 3; const val noticeCp = 200; const val logs = 20; const val logCp = 200; const val messageCp = 200 }
    val CODES = listOf("script_error", "no_handler", "budget", "memory", "stack", "timeout", "invalid_state", "invalid_effect", "engine_unavailable", "engine")
    // What a run's result may hold. The page's own `confirm` and `changed` are allowed but never used: they are
    // computed again here.
    private val OUTPUT_KEYS = setOf("ok", "state", "effects", "notices", "logs", "confirm", "changed")

    fun failure(code: String, message: String, line: Long? = null) = HxRunFailed(HxEngineError(code, cpPrefix(sanitize(message), OUTPUT_LIMITS.messageCp), line))

    sealed interface Checked<out T>
    data class Good<T>(val value: T) : Checked<T>
    data class Bad(val error: String) : Checked<Nothing>

    /** The say's text as it will be posted (ASCII-trimmed, as the server trims), or an error message. */
    fun checkSay(text: JsonElement?, kind: JsonElement?): Checked<String> {
        val k = stringOf(kind)
        if (k != "ic" && k != "ooc") return Bad("say: kind must be 'ic' or 'ooc'")
        val raw = stringOf(text) ?: return Bad("say: text must be a string")
        val t = asciiTrim(raw)
        if (!boundedText(t, OUTPUT_LIMITS.sayCp, true, 1)) return Bad("say: 1 to 500 characters, no control or direction characters")
        if (lineCount(t) > OUTPUT_LIMITS.sayLines) return Bad("say: at most 5 lines")   // U+0085, U+2028 and U+2029 break lines too
        if (verdict(t) == "refused") return Bad("say: this command cannot be posted from an interactive message")
        return Good(t)
    }

    /** At most one say and one reply; a reply only to a declared stub, with exactly its slots and allowed values. */
    fun checkEffects(doc: HxDoc, raw: JsonElement?): Checked<List<HxEffect>> {
        if (raw !is JsonArray || raw.size > 2) return Bad("effects: at most one say and one reply")
        val effects = ArrayList<HxEffect>()
        for (e in raw) {
            if (e !is JsonObject) return Bad("effects: each effect must be an object")
            when (stringOf(e["type"])) {
                "say" -> {
                    if (effects.any { it is HxSay }) return Bad("say: at most once per action")
                    if (e.keys.any { it != "type" && it != "text" && it != "kind" }) return Bad("say: unknown field")
                    when (val s = checkSay(e["text"], e["kind"])) { is Bad -> return s; is Good -> effects.add(HxSay(s.value, stringOf(e["kind"])!!)) }
                }
                "reply" -> {
                    if (effects.any { it is HxReply }) return Bad("reply: at most once per action")
                    if (e.keys.any { it != "type" && it != "id" && it != "slots" }) return Bad("reply: unknown field")
                    val stub = stringOf(e["id"])?.let { id -> doc.replies.firstOrNull { it.id == id } } ?: return Bad("reply: not one of this message's replies")
                    val slots = e["slots"] ?: JsonObject(emptyMap())
                    if (slots !is JsonObject) return Bad("reply: slots must be an object")
                    val names = stub.slots.keys.toList()
                    if (slots.size != names.size || !names.all { slots.containsKey(it) }) return Bad("reply ${stub.id}: slots must be exactly ${names.joinToString(", ").ifEmpty { "(none)" }}")
                    val out = LinkedHashMap<String, JsonElement>()
                    for (k in names) {
                        val v = slots[k]
                        if (!slotOk(stub.slots[k]!!, v)) return Bad("reply ${stub.id}: slot $k is not an allowed value")
                        out[k] = canon(v!!)
                    }
                    effects.add(HxReply(stub.id, JsonObject(out)))
                }
                else -> return Bad("effects: unknown effect type")
            }
        }
        return Good(effects)
    }
    fun checkEffects(doc: HxDoc, effects: List<HxEffect>): Checked<List<HxEffect>> = checkEffects(doc, JsonArray(effects.map { it.json() }))

    /** Free text (not a command) needs the viewer's confirmation; sc/ds too, with a sheet warning. An allowed roll runs
     *  directly only when it is a bare roll; any other text riding on a roll is confirmed like free text. */
    fun confirmFor(effects: List<HxEffect>): HxConfirm? {
        val say = effects.firstOrNull { it is HxSay } as? HxSay ?: return null
        val v = verdict(say.text)
        if (v == "confirm") return HxConfirm(say.text, say.kind, sheet = true)
        return if (v == "allowed" && bareRoll(say.text)) null else HxConfirm(say.text, say.kind)
    }

    private fun logList(raw: JsonElement?): List<String> =
        (raw as? JsonArray)?.take(OUTPUT_LIMITS.logs)?.map { x -> cpPrefix(sanitize(stringOf(x) ?: x.toString()), OUTPUT_LIMITS.logCp) } ?: emptyList()

    /** The engine's output (the result JSON of the page) → a validated result. `changed`: whether the state differs from
     *  [prevState], the state shown before the action (no effects and no change: nothing to save). */
    fun validateOutput(doc: HxDoc, prevState: JsonObject, raw: String?): HxRunResult {
        if (raw == null) return failure("engine", "the engine returned no output")
        // The page already held the script's own output to 16 KiB. Its result adds `confirm` (which repeats the say
        // text) and `changed`, so it may be a little larger: only the 64 KiB message cap applies to it here.
        if (utf8Bytes(raw) > HypertextPipeline.MESSAGE_BYTES) return failure("invalid_effect", "the engine sent a reply that is too large or not valid")
        if (jsonDepth(raw) > OUTPUT_LIMITS.depth) return failure("invalid_effect", "the script output is nested too deeply")
        val out = try { Json.parseToJsonElement(raw) } catch (_: Exception) { return failure("invalid_effect", "the script output is not JSON") }
        if (out !is JsonObject || !isBool(out["ok"])) return failure("invalid_effect", "the script output has no result")
        if (boolOf(out["ok"]) == false) {
            val e = out["error"] as? JsonObject ?: JsonObject(emptyMap())
            val code = stringOf(e["code"])?.takeIf { it in CODES } ?: "script_error"
            val line = integerOf(e["line"])?.takeIf { it > 0 && it < 9.0e15 }?.toLong()
            val f = failure(code, stringOf(e["message"]) ?: "the script failed", line); val logs = logList(out["logs"])
            return if (logs.isNotEmpty()) f.copy(logs = logs) else f
        }
        for (k in out.keys) if (k !in OUTPUT_KEYS) return failure("invalid_effect", "unknown output field ${cpPrefix(k, 40)}")
        // The prelude hands the script every key and returns them all: a missing one was deleted by the script.
        val missing = (out["state"] as? JsonObject)?.let { st -> doc.state.keys.firstOrNull { !st.containsKey(it) } }
        if (missing != null) return failure("invalid_state", "state.$missing: missing")
        val state = when (val st = validateState(doc, out["state"])) { is HxInvalidState -> return failure("invalid_state", st.error); is HxValidState -> st.state }
        val effects = when (val fx = checkEffects(doc, out["effects"]?.takeUnless { it is JsonNull } ?: JsonArray(emptyList()))) { is Bad -> return failure("invalid_effect", fx.error); is Good -> fx.value }
        val notices = out["notices"]?.takeUnless { it is JsonNull } ?: JsonArray(emptyList())
        if (notices !is JsonArray || notices.size > OUTPUT_LIMITS.notices) return failure("invalid_effect", "notify: at most 3 per action")
        if (!notices.all { boundedText(it, OUTPUT_LIMITS.noticeCp, true, 1) }) return failure("invalid_effect", "notify: 1 to 200 characters, no control or direction characters")
        val logs = out["logs"]
        if (logs != null && (logs !is JsonArray || logs.size > OUTPUT_LIMITS.logs || !logs.all { l -> stringOf(l)?.let { cpLength(it) <= OUTPUT_LIMITS.logCp } == true })) {
            return failure("invalid_effect", "log: at most 20 entries of 200 characters")
        }
        val changed = doc.state.keys.any { k -> val p = prevState[k]; p == null || canon(state[k]!!).toString() != canon(p).toString() }
        return HxRunOk(state, effects, notices.map { stringOf(it)!! }, logList(logs), confirmFor(effects), changed)
    }
}
