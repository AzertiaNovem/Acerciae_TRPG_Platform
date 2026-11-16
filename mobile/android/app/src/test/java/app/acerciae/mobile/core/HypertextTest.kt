package app.acerciae.mobile.core

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** Interactive messages: the Kotlin port of the card logic (core/Hypertext.kt) over the shared fixtures, which the web,
 *  iOS and (for hypertext.json) the C++ server read too. Every case is checked and a failure names it. */
class HypertextTest {
    companion object {
        private fun resource(name: String): JsonObject =
            Json.parseToJsonElement(HypertextTest::class.java.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }).jsonObject
        val shared by lazy { resource("hypertext.json") }
        val client by lazy { resource("hypertext-client.json") }
        val docs by lazy { client.getValue("docs").jsonObject.mapValues { (k, v) -> assertNotNull("docs.$k parses", Hypertext.parseDoc(v)); Hypertext.parseDoc(v)!! } }

        /** JSON equality as JavaScript's deepStrictEqual sees parsed JSON: numbers by value, objects by their keys. */
        fun jsonEq(a: JsonElement?, b: JsonElement?): Boolean = when {
            a == null || b == null -> a == null && b == null
            a is JsonObject -> b is JsonObject && a.keys == b.keys && a.all { (k, v) -> jsonEq(v, b[k]) }
            a is JsonArray -> b is JsonArray && a.size == b.size && a.indices.all { jsonEq(a[it], b[it]) }
            else -> b !is JsonObject && b !is JsonArray && Hypertext.same(a, b)
        }
        fun assertJson(name: String, expected: JsonElement?, actual: JsonElement?) {
            if (!jsonEq(expected, actual)) fail("$name\n  expected: $expected\n  actual:   $actual")
        }
        fun cases(root: JsonObject, section: String): List<JsonObject> {
            val list = root[section]?.jsonArray?.map { it.jsonObject }
            assertTrue("$section has cases", !list.isNullOrEmpty())
            return list!!
        }
        val JsonObject.name get() = text("name")
        fun action(o: JsonObject): HxAction = when (o.text("type")) {
            "toggle" -> HxAction.Toggle
            "select" -> HxAction.Select(o.text("value"))
            "submit" -> HxAction.Submit(o.text("value"))
            "commit" -> HxAction.Commit(o.text("value"))
            "click" -> HxAction.Click
            else -> error("unknown action ${o.text("type")}")
        }
        fun lockOf(o: JsonObject?): HxLockReason? {
            val wire = (o?.get("reason") as? JsonPrimitive)?.contentOrNull ?: return null
            return HxLockReason.of(wire) ?: error("unknown lock $wire")
        }
        /** A resolved node as the fixture projects it: {type, id, text?, label?, caption?, value?, options?, visible, disabled}. */
        fun project(r: HxResolved): JsonObject = buildJsonObject {
            put("type", r.node.type); put("id", r.node.id)
            r.text?.let { put("text", it) }; r.label?.let { put("label", it) }; r.caption?.let { put("caption", it) }; r.value?.let { put("value", it) }
            r.options?.let { o -> put("options", JsonArray(o.map { buildJsonObject { put("value", it.value); put("label", it.label); put("selected", it.selected); put("disabled", it.disabled) } })) }
            put("visible", r.visible); put("disabled", r.disabled)
        }
        fun effects(list: List<HxEffect>) = JsonArray(list.map { it.json() })
        fun parse(raw: String): JsonObject = Json.parseToJsonElement(raw).jsonObject
        // A state_decl case is the card {v: 1, state: state_decl, body: [{type: divider}]}; conditions put cond in its show_if.
        fun divider(decl: JsonElement, showIf: JsonElement? = null) = buildJsonObject {
            put("v", 1); put("state", decl); put("body", buildJsonArray { add(buildJsonObject { put("type", "divider"); showIf?.let { put("show_if", it) } }) })
        }
        fun sharedDoc(raw: JsonElement, name: String): HxDoc = Hypertext.parseDoc(raw) ?: throw AssertionError("hypertext.json: the document of \"$name\" does not parse")
    }

    // ---- shared fixture hypertext.json ----

    @Test fun sharedDicePolicy() {
        for (c in cases(shared, "dice_policy")) assertEquals(c.toString(), c.text("verdict"), Hypertext.verdict(c.text("text")))
    }
    @Test fun sharedDefaults() {
        for (c in cases(shared, "defaults")) assertJson(c.name, c["state"], Hypertext.defaultState(sharedDoc(divider(c.getValue("state_decl")), c.name)))
    }
    @Test fun sharedStateValidation() {
        for (c in cases(shared, "state_validation")) {
            val r = Hypertext.validateState(sharedDoc(c.getValue("hypertext"), c.name), c["state"])
            assertEquals("${c.name}: ${(r as? HxInvalidState)?.error ?: "ok"}", c.flag("ok"), r is HxValidState)
            if (!c.flag("ok")) assertEquals(c.name, c.text("error"), (r as HxInvalidState).key)
        }
    }
    @Test fun sharedConditions() {
        for (c in cases(shared, "conditions")) {
            val doc = sharedDoc(divider(c.getValue("state_decl"), c.getValue("cond")), c.name)
            // The parsed condition (the divider's show_if) is what the card evaluates.
            assertEquals(c.name, c.flag("result"), Hypertext.evalCondition(doc.body[0].showIf!!, doc, c.getValue("state").jsonObject))
        }
    }
    @Test fun sharedInterpolation() {
        for (c in cases(shared, "interpolation")) {
            val ht = c.getValue("hypertext").jsonObject
            val raw = JsonObject(ht + ("body" to JsonArray(ht.getValue("body").jsonArray + buildJsonObject { put("type", "text"); put("text", c.text("text")) })))
            assertEquals(c.name, c.text("result"), Hypertext.interpolate(c.text("text"), sharedDoc(raw, c.name), c.getValue("state").jsonObject))
        }
    }

    // ---- client fixture hypertext-client.json ----

    @Test fun clientBindings() {
        val all = cases(client, "bindings")
        assertTrue(all.size >= 20)
        for (c in all) {
            val r = Hypertext.applyAction(docs.getValue(c.text("doc")), c.getValue("state").jsonObject, c.text("node"), action(c.getValue("action").jsonObject), lockOf(c["lock"] as? JsonObject))
            assertJson(c.name, c["expect"], r?.let { buildJsonObject { put("state", it.state); put("event", it.event?.json() ?: JsonNull) } } ?: JsonNull)
        }
        assertTrue(all.any { it.containsKey("lock") } && all.any { it.getValue("action").jsonObject.text("type") == "commit" })
    }
    @Test fun clientResolveEveryLockReason() {
        val all = cases(client, "resolve")
        val reasons = all.map { lockOf(it.getValue("lock").jsonObject) }.toSet()
        assertEquals(setOf(null) + HxLockReason.entries, reasons)
        for (c in all) assertJson(c.name, c["expect"], JsonArray(Hypertext.resolve(docs.getValue(c.text("doc")), c.getValue("state").jsonObject, lockOf(c.getValue("lock").jsonObject)).map(::project)))
    }
    @Test fun clientAct() {
        for (c in cases(client, "act")) {
            val r = Hypertext.act(docs.getValue(c.text("doc")), c.getValue("state").jsonObject, c.text("node"))
            assertJson(c.name, c["expect"], r?.let { buildJsonObject { put("state", it.state); put("effects", effects(it.effects)) } } ?: JsonNull)
        }
    }
    @Test fun clientOverlay() {
        val all = cases(client, "overlay")
        assertTrue(all.size >= 20)
        for (c in all) assertJson(c.name, c["expect"], Hypertext.overlay(docs.getValue(c.text("doc")), c["stored"]))
        assertTrue("a case stores prototype names", all.any { (it["stored"] as? JsonObject)?.containsKey("__proto__") == true })
    }
    /** The engine runs only in the WebView, but what native code computes from a run is pinned here: the confirmation
     *  of every expected say, and `changed` for the runs whose whole result the fixture gives. */
    @Test fun clientRunsConfirmAndChangedAreComputedNatively() {
        var confirms = 0; var whole = 0
        for (c in cases(client, "runs")) {
            val e = c.getValue("expect").jsonObject
            if (!e.flag("ok") || !e.containsKey("effects")) continue
            val doc = docs.getValue(c.text("doc"))
            val fx = Hypertext.checkEffects(doc, e["effects"]) as? Hypertext.Good ?: throw AssertionError("${c.name}: effects do not check")
            if (e.containsKey("confirm")) {
                confirms++
                assertJson("${c.name}: confirm", e["confirm"], Hypertext.confirmFor(fx.value)?.let { buildJsonObject { put("text", it.text); put("kind", it.kind); if (it.sheet) put("sheet", true) } } ?: JsonNull)
            }
            if (e.containsKey("state") && e.containsKey("changed")) {
                whole++
                val prev = (c["prev"] ?: c.getValue("state")).jsonObject
                val out = buildJsonObject { put("ok", true); put("state", e.getValue("state")); put("effects", e.getValue("effects")); put("notices", e["notices"] ?: JsonArray(emptyList())); put("logs", e["logs"] ?: JsonArray(emptyList())); put("confirm", JsonNull); put("changed", false) }
                val r = Hypertext.validateOutput(doc, prev, out.toString()) as? HxRunOk ?: throw AssertionError("${c.name}: ${Hypertext.validateOutput(doc, prev, out.toString())}")
                assertEquals("${c.name}: changed", e.flag("changed"), r.changed)
            }
        }
        assertTrue(confirms >= 8); assertTrue(whole >= 2)
    }

    @Test fun theFixtureDocumentsParseKeepingKnownFieldsOnly() {
        assertEquals("heading", (docs.getValue("study").body[0] as HxTextNode).style)
        assertEquals("body", (docs.getValue("small").body[0] as HxTextNode).style)
        assertEquals("primary", (docs.getValue("small").body[2] as HxButton).style)
        assertEquals(1, docs.getValue("small").runsPerViewer)
        val small = client.getValue("docs").jsonObject.getValue("small").jsonObject
        assertEquals(docs["small"], Hypertext.parseDoc(JsonObject(small + ("extra" to buildJsonObject { put("x", 1) }))))
        assertTrue(Hypertext.scripted(Hypertext.parseDoc(JsonObject(client.getValue("docs").jsonObject.getValue("run").jsonObject + ("script" to JsonPrimitive("on('go', () => {})"))))!!))
        assertFalse("handlers without a script never start the engine", Hypertext.scripted(docs.getValue("run")))
    }

    // ---- the hand-written cases of frontend/tests/hypertext-bindings.test.cjs ----

    @Test fun defaultsAndValidateState() {
        val d = docs.getValue("study")
        val defaults = parse("""{"done":false,"lamp":false,"count":2,"path":null,"tools":[],"note":""}""")
        assertJson("defaults", defaults, Hypertext.defaultState(d))
        assertJson("overlay of nothing", defaults, Hypertext.overlay(d, null))
        assertJson("valid", defaults, (Hypertext.validateState(d, defaults) as HxValidState).state)
        fun key(raw: String) = (Hypertext.validateState(d, JsonObject(defaults + parse(raw))) as HxInvalidState).key
        assertEquals("tools", key("""{"tools":["rope","lamp","key"]}"""))
        assertEquals("note", key("""{"note":"\u2066x"}"""))
        assertEquals("count", key("""{"count":1.5}"""))
        assertEquals("extra", key("""{"extra":1}"""))
        assertJson("missing keys take defaults, sets in schema order", JsonObject(defaults + parse("""{"count":3,"tools":["rope","key"]}""")),
            (Hypertext.validateState(d, parse("""{"count":3,"tools":["key","rope"]}""")) as HxValidState).state)
        assertEquals("count", (Hypertext.validateState(d, parse("""{"zz":1,"count":99}""")) as HxInvalidState).key)
        assertEquals("", (Hypertext.validateState(d, JsonArray(listOf(JsonPrimitive(1)))) as HxInvalidState).key)
        assertJson("1.0 is 1", JsonObject(defaults + ("count" to JsonPrimitive(1))), (Hypertext.validateState(d, parse("""{"count":1.0}""")) as HxValidState).state)
        // At most 8 KiB serialized: five texts of 500 four-byte code points are each valid but too large together.
        val big = Hypertext.parseDoc(parse("""{"v":1,"title":"Big","state":{"t0":{"type":"text","max":500},"t1":{"type":"text","max":500},"t2":{"type":"text","max":500},"t3":{"type":"text","max":500},"t4":{"type":"text","max":500}},"body":[{"type":"input","id":"i","bind":"t0"}]}"""))!!
        val face = "😀".repeat(500)
        val four = buildJsonObject { put("t0", ""); put("t1", face); put("t2", face); put("t3", face); put("t4", face) }
        assertTrue(Hypertext.validateState(big, four) is HxValidState)
        assertTrue(Hypertext.validateState(big, JsonObject(four + ("t0" to JsonPrimitive(face)))) is HxInvalidState)
        assertNull(Hypertext.applyAction(big, four, "i", HxAction.Submit(face)))
        assertEquals("short", Hypertext.applyAction(big, four, "i", HxAction.Submit("short"))!!.state.text("t0"))
    }

    @Test fun conditionsAndInterpolation() {
        val d = docs.getValue("study")
        val s = parse("""{"done":false,"lamp":true,"count":3,"path":"door","tools":["rope"],"note":""}""")
        fun cond(raw: String): HxCond {
            val doc = Hypertext.parseDoc(JsonObject(client.getValue("docs").jsonObject.getValue("study").jsonObject + ("body" to buildJsonArray { add(buildJsonObject { put("type", "divider"); put("show_if", Json.parseToJsonElement(raw)) }) })))
            return doc!!.body[0].showIf!!
        }
        fun ev(raw: String, state: JsonObject = s) = Hypertext.evalCondition(cond(raw), d, state)
        assertTrue(ev("""{"key":"lamp","eq":true}""")); assertFalse(ev("""{"key":"path","eq":null}"""))
        assertTrue(ev("""{"key":"path","in":["window","door"]}""")); assertTrue(ev("""{"key":"tools","has":"rope"}"""))
        assertTrue(ev("""{"key":"count","gte":3}""")); assertFalse(ev("""{"key":"count","lte":2}"""))
        assertTrue(ev("""{"key":"note","empty":true}""")); assertFalse(ev("""{"key":"tools","empty":true}"""))
        assertTrue(ev("""{"all":[{"key":"lamp","eq":true},{"not":{"key":"done","eq":true}}]}"""))
        assertFalse(ev("""{"any":[{"key":"lamp","eq":false},{"key":"count","eq":4}]}"""))
        assertTrue("a missing value reads as its default", ev("""{"key":"count","eq":2}""", JsonObject(emptyMap())))
        assertTrue("an invalid value too", ev("""{"key":"path","empty":true}""", parse("""{"path":"nope"}""")))
        assertTrue(ev("""{"key":"count","eq":3.0}"""))
        fun ip(t: String, state: JsonObject = s) = Hypertext.interpolate(t, d, state)
        assertEquals("The door/Rope/3//{{lamp}}/{{nope}}/{{ path }}", ip("{{path}}/{{tools}}/{{count}}/{{note}}/{{lamp}}/{{nope}}/{{ path }}"))
        assertEquals("Rope, Key", ip("{{tools}}", JsonObject(s + ("tools" to parse("""{"x":["key","rope"]}""").getValue("x")))))
        assertEquals("0", ip("{{count}}", JsonObject(s + ("count" to Json.parseToJsonElement("-0")))))
        assertEquals("{{{count}}}", ip("{{{count}}}"))
        assertEquals("3 {{The door", ip("{{count}} {{{{path}}"))
        assertEquals("2//", ip("{{count}}/{{path}}/{{tools}}", parse("""{"note":"x"}""")))
        assertEquals("2", ip("{{count}}", parse("""{"count":"x"}""")))
    }

    @Test fun textRulesCodePointsRefusedCharactersTrimmingIds() {
        assertEquals(3, Hypertext.cpLength("a😀é"))
        assertEquals("😀😀", Hypertext.cpPrefix("😀😀😀", 2))
        assertEquals(1 + 2 + 4 + 3, Hypertext.utf8Bytes("aé😀中"))
        assertEquals(3, Hypertext.utf8Bytes("\ud800"))
        for (bad in listOf("\u0000", "\t", "\r", "\u001f", "\u202a", "\u202e", "\u2066", "\u2069", "\ud800", "x\udc00", "\ufdd0", "\ufffe", "\uffff", "\ud83f\udffe")) assertFalse(bad, Hypertext.textOk("a$bad"))
        for (good in listOf("plain", "中文 😀", "\u007f", "\u200f", "😀", "é")) assertTrue(good, Hypertext.textOk(good))
        assertFalse(Hypertext.textOk("a\nb")); assertTrue(Hypertext.textOk("a\nb", true))
        assertEquals("a\ufffdb\ufffdc", Hypertext.sanitize("a\u202eb\ud800c"))
        assertEquals(".r 1d6", Hypertext.asciiTrim(" \t\n.r 1d6\u000b\u000c\r "))
        assertEquals("\u3000.r\u00a0", Hypertext.asciiTrim("\u3000.r\u00a0"))
        for (id in listOf("a", "roll_2", "a".repeat(32))) assertTrue(id, Hypertext.isId(id))
        for (id in listOf("", "A", "1a", "_a", "a-b", "a".repeat(33), "__proto__", "constructor", "prototype", "valueof", "tostring", "hasownproperty", "isprototypeof", "propertyisenumerable", "tolocalestring", "__definegetter__", "toString", null)) assertFalse(id.toString(), Hypertext.isId(id))
        assertEquals(5, Hypertext.lineCount("a\nb\u2028c\u2029d\u0085e\rf"))
        assertEquals(2, Hypertext.jsonDepth("""[{"a":"[[["}]"""))
        assertEquals("\u2068Ada\u2069 · \u2068{text}\u2069 {n}", Hypertext.fill("{name} · {text} {n}", "name" to "Ada", "text" to "{text}"))
    }

    @Test fun malformedOrUnknownDocumentsAreNullNeverAThrow() {
        val base = client.getValue("docs").jsonObject.getValue("small").jsonObject
        fun with(vararg fields: Pair<String, String>) = JsonObject(base + fields.map { (k, v) -> k to Json.parseToJsonElement(v) })
        fun body(raw: String) = with("body" to raw)
        fun state(raw: String) = with("state" to raw)
        val malformed = mapOf(
            "not an object" to JsonPrimitive("card"), "array" to JsonArray(listOf(base)), "null" to JsonNull,
            "unknown version" to with("v" to "2"), "version as a string" to with("v" to "\"1\""),
            "title too long" to with("title" to "\"${"x".repeat(121)}\""), "bidi in the title" to with("title" to "\"a\\u202eb\""),
            "empty body" to body("[]"), "body not a list" to body("{}"),
            "a __proto__ key" to parse("""{"v":1,"title":"x","state":{"__proto__":{"type":"bool"}},"body":[{"type":"divider"}]}"""),
            "a constructor key" to state("""{"constructor":{"type":"bool"}}"""), "a valueof key" to state("""{"valueof":{"type":"bool"}}"""),
            "an uppercase key" to state("""{"Seen":{"type":"bool"}}"""),
            "too many keys" to state((0 until 33).joinToString(",", "{", "}") { "\"k$it\":{\"type\":\"bool\"}" }),
            "unknown state type" to state("""{"seen":{"type":"float"}}"""),
            "int bounds reversed" to state("""{"seen":{"type":"int","min":2,"max":1}}"""), "int beyond 1e9" to state("""{"seen":{"type":"int","min":0,"max":1000000001}}"""),
            "int default out of range" to state("""{"seen":{"type":"int","min":0,"max":3,"default":4}}"""),
            "enum with one value" to state("""{"seen":{"type":"enum","values":[{"value":"a","label":"A"}]}}"""),
            "enum duplicate values" to state("""{"seen":{"type":"enum","values":[{"value":"a","label":"A"},{"value":"a","label":"B"}]}}"""),
            "enum default not declared" to state("""{"seen":{"type":"enum","values":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"default":"c"}}"""),
            "set max 0" to state("""{"seen":{"type":"set","values":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"max":0}}"""),
            "text max 501" to state("""{"seen":{"type":"text","max":501}}"""),
            "unknown node type" to body("""[{"type":"image","id":"i"}]"""),
            "duplicate node ids" to body("""[{"type":"checkbox","id":"a","label":"A","bind":"seen"},{"type":"checkbox","id":"a","label":"B","bind":"seen"}]"""),
            "control without an id" to body("""[{"type":"checkbox","label":"A","bind":"seen"}]"""),
            "bind to an undeclared key" to body("""[{"type":"checkbox","id":"a","label":"A","bind":"gone"}]"""),
            "bind to a prototype name" to body("""[{"type":"checkbox","id":"a","label":"A","bind":"constructor"}]"""),
            "checkbox bound to a text" to with("state" to """{"t":{"type":"text","max":5}}""", "body" to """[{"type":"checkbox","id":"a","label":"A","bind":"t"}]"""),
            "button with on and act" to body("""[{"type":"button","id":"b","label":"B","on":"x","act":{"say":"hi"}}]"""),
            "button with neither" to body("""[{"type":"button","id":"b","label":"B"}]"""),
            "button label over 60" to body("""[{"type":"button","id":"b","label":"${"x".repeat(61)}","on":"x"}]"""),
            "act with nothing" to body("""[{"type":"button","id":"b","label":"B","act":{}}]"""),
            "act set of the wrong type" to body("""[{"type":"button","id":"b","label":"B","act":{"set":{"seen":1}}}]"""),
            "act reply not declared" to body("""[{"type":"button","id":"b","label":"B","act":{"reply":"nope"}}]"""),
            "act say_kind narration" to body("""[{"type":"button","id":"b","label":"B","act":{"say":"x","say_kind":"narration"}}]"""),
            "act say over 500" to body("""[{"type":"button","id":"b","label":"B","act":{"say":"${"x".repeat(501)}"}}]"""),
            "act say of only spaces" to body("""[{"type":"button","id":"b","label":"B","act":{"say":" \t\r\n"}}]"""),
            "act say with a line break inside" to body("""[{"type":"button","id":"b","label":"B","act":{"say":".r 1d6\r\nx"}}]"""),
            "a value label that is not a string" to state("""{"seen":{"type":"enum","values":[{"value":"a","label":1},{"value":"b"}]}}"""),
            "a row inside a row" to body("""[{"type":"row","children":[{"type":"row","children":[]}]}]"""),
            "a group inside a group" to body("""[{"type":"group","children":[{"type":"group","children":[]}]}]"""),
            "a group inside a row" to body("""[{"type":"row","children":[{"type":"group","children":[]}]}]"""),
            "more than 64 nodes" to body((0 until 65).joinToString(",", "[", "]") { """{"type":"divider"}""" }),
            "condition on an undeclared key" to body("""[{"type":"divider","show_if":{"key":"gone","eq":true}}]"""),
            "condition of the wrong type" to body("""[{"type":"divider","show_if":{"key":"seen","eq":1}}]"""),
            "condition with two operators" to body("""[{"type":"divider","show_if":{"key":"seen","eq":true,"empty":true}}]"""),
            "unknown condition operator" to body("""[{"type":"divider","show_if":{"key":"seen","like":true}}]"""),
            "condition deeper than 3" to body("""[{"type":"divider","show_if":{"not":{"not":{"not":{"key":"seen","eq":true}}}}}]"""),
            "more than 8 leaves" to body("""[{"type":"divider","show_if":{"any":[${(0 until 9).joinToString(",") { """{"key":"seen","eq":true}""" }}]}}]"""),
            "has on a bool" to body("""[{"type":"text","text":"x","show_if":{"key":"seen","has":"a"}}]"""),
            "enable_if of the wrong type" to body("""[{"type":"checkbox","id":"a","label":"A","bind":"seen","enable_if":{"key":"seen","gte":1}}]"""),
            "choice options not declared" to with("state" to """{"p":{"type":"enum","values":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}}""", "body" to """[{"type":"choice","id":"c","bind":"p","options":["c"]}]"""),
            "script over 16 KiB" to with("script" to "\"${"x".repeat(16385)}\""),
            "runs_per_viewer 0" to with("runs_per_viewer" to "0"), "runs_per_viewer 101" to with("runs_per_viewer" to "101"),
            "more than 10 actors" to with("actors" to (0 until 11).joinToString(",", "[", "]") { "\"$it\"" }),
            "reply stub with a bad slot" to with("replies" to """[{"id":"r","slots":{"n":{"type":"int","min":3,"max":1}}}]"""),
            "duplicate reply stubs" to with("replies" to """[{"id":"r","slots":{}},{"id":"r","slots":{}}]"""),
            "a null title" to with("title" to "null"), "a null label" to body("""[{"type":"checkbox","id":"a","label":null,"bind":"seen"}]"""),
        )
        for ((name, raw) in malformed) assertNull(name, Hypertext.parseDoc(raw))
        // Accepted: the same documents written correctly.
        assertNotNull(Hypertext.parseDoc(body("""[{"type":"row","children":[{"type":"text","text":"a"},{"type":"checkbox","id":"a","label":"A","bind":"seen","enable_if":{"key":"seen","eq":false}}]}]""")))
        assertNotNull(Hypertext.parseDoc(body("""[{"type":"divider","show_if":{"not":{"not":{"key":"seen","eq":true}}}}]""")))
        assertNotNull(Hypertext.parseDoc(with("script" to "\"${"é".repeat(8192)}\"", "closes_at" to "\"2026-11-21T00:00:00Z\"", "actors" to "[\"c1\"]", "runs_per_viewer" to "100")))
        assertNotNull("v 1.0 is v 1", Hypertext.parseDoc(with("v" to "1.0")))
        // What the server's normalize fills in, so a post body reads like the stored card: no title, labels from values.
        val post = Hypertext.parseDoc(parse("""{"v":1,"state":{"p":{"type":"enum","values":[{"value":"a"},{"value":"b","label":"Bee"}]}},"body":[{"type":"choice","id":"c","bind":"p"}]}"""))!!
        assertEquals("", post.title)
        assertEquals(listOf(HxEnumValue("a", "a"), HxEnumValue("b", "Bee")), (post.state["p"] as HxEnumDecl).values)
        assertEquals(listOf(null, "list"), (post.body[0] as HxChoice).let { listOf(it.label, it.display) })
        // act.say is checked and kept ASCII-trimmed, as the server checks the trimmed say and posts it.
        for (say in listOf(".ra Spot Hidden\r\n", "\t.r 1d6", ".r 1d6" + " ".repeat(600))) {
            val d = Hypertext.parseDoc(JsonObject(base + ("body" to buildJsonArray { add(buildJsonObject { put("type", "button"); put("id", "b"); put("label", "B"); putJsonObject("act") { put("say", say) } }) })))
            assertNotNull(say.take(30), d)
            assertEquals(Hypertext.asciiTrim(say), (d!!.body[0] as HxButton).act!!.say)
        }
    }

    @Test fun diceParseCommandMirrorsTheServerLiterals() {
        val cases = listOf(
            listOf(".r", "r", ""), listOf(".r1d6", "r", "1d6"), listOf(".rd20", "r", "d20"), listOf(".RD20", "r", "D20"), listOf(".rh", "r", "", true), listOf(".rh 1d4", "r", "1d4", true),
            listOf(".ra Spot Hidden", "ra", "Spot Hidden"), listOf(".RA spot", "ra", "spot"), listOf(".rah Listen", "ra", "Listen", true), listOf(".rch", "ra", "", true), listOf(".rc 50", "ra", "50"),
            listOf(".ri", "ri", ""), listOf(".rih", "ri", "", true), listOf(".ri+3", "ri", "+3"), listOf(".sc 1/1d6", "sc", "1/1d6"), listOf(".st STR 50", "st", "STR 50"), listOf(".en Library", "en", "Library"),
            listOf(".ds", "ds", ""), listOf(".ss", "ss", ""), listOf(".init", "init", ""), listOf(".move 3", "move", "3"), listOf("。ra 侦查", "ra", "侦查"), listOf("．r", "r", ""),
            listOf("  .r 2d6  ", "r", "2d6"), listOf(".ra侦查", "ra", "侦查"), listOf(".r(1d6)", "r", "(1d6)"), listOf(".r%", "r", "%"), listOf(".r#2", "r", "#2"), listOf(".r/2", "r", "/2"), listOf(".r-1", "r", "-1"),
            listOf(".ra\tx", "ra", "x"), listOf(".ri\u0000", "ri", "\u0000"),
        )
        for (c in cases) {
            val cmd = Hypertext.parseCommand(c[0] as String) ?: throw AssertionError("${c[0]} parses")
            assertEquals(c[0] as String, listOf(c[1], c[2], c.getOrElse(3) { false }), listOf(cmd.name, cmd.args, cmd.hidden))
        }
        for (t in listOf("", ".", "。", "r", "..r", "\u3000.r", ".rx", ".rcx", ".rhx", ".rend", ".endurance", ".inita", ".stx", ".r\u000bx", "hello .r", ".Ｒ")) assertNull(t, Hypertext.parseCommand(t))
        assertEquals(".rah", Hypertext.parseCommand(".rah")!!.raw)
    }

    @Test fun dicePolicyForLinesPostedAsTheClicker() {
        val policy = mapOf(
            "allowed" to listOf(".r", ".rh", ".r 1d100", ".r 2d6+3 for damage", ".ra Spot Hidden", ".rc 50", ".rah", ".rch", ".ri", ".rih", ".ri +2", ".ri -1 +3", ".ri+1", ".RI +10", "。ri",
                ".ri +9999", ".ri +12345", ".ri +1d4", ".ri -d6", ".ri adv", ".ri ADV", ".ri +2 adv", ".ri adv+2", ".ri disadvantage -1", ".ri dis", ".ri + 2"),
            "confirm" to listOf(".sc 1/1d6", ".ds", "．SC"),
            "refused" to listOf(".ri Bob", ".ri 3", ".ri +2 Bob", ".rih Alice", ".ri adv2", ".ri +2abc", ".ri +2d", ".ri +", ".ri advantages", ".ri #quick", ".ri 优势", ".ri adv\u00a0",
                ".st STR 50", ".en", ".ss", ".init", ".move", ".MOVE 2"),
            "none" to listOf("hello", "I open the door.", ".rx", "", "。", ". r", ".resume"),
        )
        for ((v, texts) in policy) for (t in texts) assertEquals(t, v, Hypertext.verdict(t))
        assertTrue(Hypertext.modifiersOnly("")); assertTrue(Hypertext.modifiersOnly(" +2\t-1 "))
    }

    @Test fun aBareRollRunsDirectlyAnyOtherTextRidingOnARollIsConfirmed() {
        val bare = listOf(".r", ".r 1d100", ".rd6", ".r(1d6+2)*3", ".r 3#1d6", ".r 3# 2d6", ".rh 1d20", ".r%", ".ra Spot Hidden", ".rah Listen", "。ra侦查",
            ".ra Fighting (Brawl) 50 +10", ".ra Operate Heavy Machinery 50 - 5", ".ra " + "x".repeat(32), ".ri", ".ri adv +2", "  .r 1d6  ")
        val riding = listOf(".r 2d6+3 for damage", ".r 1d6 +2", ".r I hand all my gold to the GM", ".r 1d6\nSigned, me", ".ra Spot Hidden\nand more",
            ".ra " + "x".repeat(33), ".ra I hand all my gold to the GM", ".ra Spot Hidden for the clue", ".r 1d6\u2028x", ".ra x\u2029y", ".ri +2\nadv", ".r１d6", ".sc 1/1d6", ".st x", "hello")
        for (t in bare) assertTrue(t, Hypertext.bareRoll(t))
        for (t in riding) assertFalse(t, Hypertext.bareRoll(t))
    }

    @Test fun engineOutputIsCheckedAgainNatively() {
        val doc = docs.getValue("run")
        val start = parse("""{"done":false,"n":0,"pick":null,"tags":[],"t":""}""")
        fun out(extra: String) = """{"ok":true,"state":{"done":true,"n":0,"pick":null,"tags":[],"t":""},$extra}"""
        fun code(raw: String?) = (Hypertext.validateOutput(doc, start, raw) as HxRunFailed).error.code
        fun ok(raw: String) = Hypertext.validateOutput(doc, start, raw) as? HxRunOk ?: throw AssertionError("$raw: ${Hypertext.validateOutput(doc, start, raw)}")
        // The page's own confirm and changed are allowed but recomputed: a free-text say is confirmed whatever it says.
        val said = ok(out(""""effects":[{"type":"say","text":"  I open the door. ","kind":"ic"}],"notices":["Creak."],"logs":["ran"],"confirm":null,"changed":false"""))
        assertEquals(HxConfirm("I open the door.", "ic"), said.confirm); assertTrue(said.changed)
        assertEquals(listOf<HxEffect>(HxSay("I open the door.", "ic")), said.effects); assertEquals(listOf("Creak."), said.notices); assertEquals(listOf("ran"), said.logs)
        assertEquals(HxConfirm(".sc 1/1d6", "ooc", sheet = true), ok(out(""""effects":[{"type":"say","text":".sc 1/1d6","kind":"ooc"}]""")).confirm)
        assertNull(ok(out(""""effects":[{"type":"say","text":".ra Spot Hidden","kind":"ic"}]""")).confirm)
        assertEquals(listOf<HxEffect>(HxReply("num", buildJsonObject { put("n", 2) })), ok(out(""""effects":[{"type":"reply","id":"num","slots":{"n":2.0}}]""")).effects)
        assertFalse(ok("""{"ok":true,"state":{"done":false,"n":0,"pick":null,"tags":[],"t":""}}""").changed)
        assertEquals("engine", code(null))
        assertEquals("invalid_effect", code("not json"))
        assertEquals("invalid_effect", code("""{"ok":"yes"}"""))
        assertEquals("invalid_effect", code(out(""""extra":1""")))
        assertEquals("invalid_effect", code("[".repeat(17) + "]".repeat(17)))
        assertEquals("invalid_effect", code(out(""""logs":["${"x".repeat(17000)}"]""")))
        // The page's result repeats the say text in `confirm`, so a script output just under 16 KiB gives a larger
        // result: only the 64 KiB message cap applies to it.
        val emoji = "\uD83D\uDE00"
        val full = out(""""effects":[{"type":"say","text":"${emoji.repeat(500)}","kind":"ic"}],"logs":[${List(20) { "\"${emoji.repeat(200)}\"" }.joinToString(",")}],"confirm":{"text":"${emoji.repeat(500)}","kind":"ic"},"changed":true""")
        assertTrue(Hypertext.utf8Bytes(full) in 16385..HypertextPipeline.MESSAGE_BYTES)
        assertEquals(20, ok(full).logs.size)
        assertEquals("invalid_state", code("""{"ok":true,"state":{"done":true}}"""))
        assertEquals("invalid_state", code("""{"ok":true,"state":{"done":true,"n":11,"pick":null,"tags":[],"t":""}}"""))
        assertEquals("invalid_effect", code(out(""""effects":[{"type":"say","text":".st STR 90","kind":"ic"}]""")))
        assertEquals("invalid_effect", code(out(""""effects":[{"type":"say","text":"a\nb\nc\nd\ne\nf","kind":"ic"}]""")))
        assertEquals("invalid_effect", code(out(""""effects":[{"type":"say","text":"hi","kind":"narration"}]""")))
        assertEquals("invalid_effect", code(out(""""effects":[{"type":"say","text":"a","kind":"ic"},{"type":"say","text":"b","kind":"ic"}]""")))
        assertEquals("invalid_effect", code(out(""""effects":[{"type":"reply","id":"clue","slots":{"mark":"99"}}]""")))
        assertEquals("invalid_effect", code(out(""""effects":[{"type":"reply","id":"door","slots":{"x":1}}]""")))
        assertEquals("invalid_effect", code(out(""""effects":[{"type":"reply","id":"secret"}]""")))
        assertEquals("invalid_effect", code(out(""""notices":["a","b","c","d"]""")))
        assertEquals("invalid_effect", code(out(""""notices":["\u202e"]""")))
        assertEquals("invalid_effect", code(out(""""logs":null""")))
        // A failure keeps a known code (else script_error), a positive line and its logs, cut and sanitized.
        val f = Hypertext.validateOutput(doc, start, """{"ok":false,"error":{"code":"budget","message":"${"y".repeat(300)}\u202e","line":3},"logs":["a\u0000b",{"x":1}]}""") as HxRunFailed
        assertEquals(listOf("budget", 200, 3L), listOf(f.error.code, f.error.message.length, f.error.line)); assertEquals(listOf("a\ufffdb", """{"x":1}"""), f.logs)
        val g = Hypertext.validateOutput(doc, start, """{"ok":false,"error":{"code":"made_up","line":-1}}""") as HxRunFailed
        assertEquals(HxEngineError("script_error", "the script failed"), g.error); assertEquals(emptyList<String>(), g.logs)
    }

    @Test fun declarativeEffectsAreCheckedLikeAScriptsBeforeTheyAreSent() {
        val study = docs.getValue("study")
        val st = parse("""{"done":false,"lamp":false,"count":2,"path":null,"tools":[],"note":""}""")
        val acted = Hypertext.act(study, st, "ask")!!
        assertTrue("a null enum slot is refused", Hypertext.checkEffects(study, acted.effects) is Hypertext.Bad)
        val filled = Hypertext.act(study, JsonObject(st + ("path" to JsonPrimitive("door"))), "ask")!!
        assertEquals(listOf<HxEffect>(HxReply("hint", buildJsonObject { put("path", "door"); put("count", 2) })), (Hypertext.checkEffects(study, filled.effects) as Hypertext.Good).value)
        assertEquals(HypertextView.POSTS_OOC, HypertextView.captionKey(Hypertext.findNode(study, "tell")!!))
    }

    @Test fun theEngineBundleIsTheOneTheFixturePins() {
        // Read from the checkout, as the APK packages it (Gradle runs unit tests in the module's directory).
        val here = File(System.getProperty("user.dir") ?: ".").absoluteFile
        val dir = generateSequence(here) { it.parentFile }.map { File(it, "contracts/hypertext") }.firstOrNull { it.isDirectory }
            ?: throw AssertionError("mobile/contracts/hypertext not found from $here")
        val pins = Json.parseToJsonElement(File(dir, "hypertext-engine.sha256.json").readText()).jsonObject
        val bundle = File(dir, "hypertext-engine.js").readBytes()
        val sha = MessageDigest.getInstance("SHA-256").digest(bundle).joinToString("") { "%02x".format(it) }
        assertEquals(pins.text("bundle_sha256"), sha)
        assertEquals(pins.getValue("bytes").jsonPrimitive.long, bundle.size.toLong())
        val engine = shared.getValue("engine").jsonObject
        assertEquals(engine.text("wasm_sha256"), pins.text("wasm_sha256"))
        assertEquals(client.getValue("engine").jsonObject.text("wasm_sha256"), pins.text("wasm_sha256"))
        assertTrue(bundle.size <= engine.getValue("max_bundle_bytes").jsonPrimitive.long)
        val page = File(dir, "hypertext-engine.html").readText()
        assertTrue(page.contains("<script src=\"hypertext-engine.js\"></script>") && page.contains("default-src 'none'") && page.contains("worker-src blob:"))
    }
}
