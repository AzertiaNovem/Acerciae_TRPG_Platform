package app.acerciae.mobile.core

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Typing flags, vitals, Inspiration options and pins, against contracts/fixtures/table-status.json (a live capture). */
class TableStatusTest {
    private val fixture: JsonObject by lazy {
        Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("table-status.json")!!.bufferedReader().use { it.readText() }).jsonObject
    }

    @Test fun flagsFollowTheStreamsSnapshotAndChanges() {
        var now = 1_000_000L
        val flags = TypingFlags { now }
        val frames = fixture["typing_frames"]!!.jsonArray.map { RealtimeEvent.parse(it.toString())!! }
        assertEquals(listOf("typing.snapshot", "typing.changed", "typing.changed"), frames.map { it.type })
        assertTrue(flags.apply(frames[0])); assertEquals(mapOf("ada" to "w1"), flags.byCharacter)   // whoever was typing when we subscribed
        assertTrue(flags.apply(frames[1])); assertEquals(emptyMap<String, String>(), flags.byCharacter)   // lowered
        assertTrue(flags.apply(frames[2])); assertEquals(mapOf("ada" to "w1"), flags.byCharacter)   // raised again
        assertFalse("other events are not typing events", flags.apply(RealtimeEvent.parse("""{"type":"message.posted","channel_id":"c1"}""")!!))
        // The server relays no heartbeats: a flag stays up for as long as nothing lowers it, well past a long paragraph.
        now += 5 * 60_000L; assertFalse(flags.prune()); assertEquals(setOf("ada"), flags.byCharacter.keys)
        now += TypingFlags.STALE_MS; assertTrue(flags.prune()); assertTrue(flags.byCharacter.isEmpty())
        // A new snapshot replaces everything known before it.
        flags.apply(frames[2]); flags.apply(RealtimeEvent.parse("""{"type":"typing.snapshot","channel_id":"c1","typing":[{"character_id":"mo","chat_window_id":"w2"}]}""")!!)
        assertEquals(mapOf("mo" to "w2"), flags.byCharacter)
        flags.clear(); assertTrue(flags.byCharacter.isEmpty())
    }

    @Test fun theComposerRaisesKeepsUpAndLowersItsFlag() {
        var now = 0L
        val sent = mutableListOf<String>()
        val signal = TypingSignal({ sent.add(it.text("character_id") + "@" + it.text("chat_window_id") + (if (it.flag("active")) "+" else "-")) }, { now })
        val ada = TypingTarget.of("c1", "w1", "ada")!!
        assertNull("as oneself there is no character to flag", TypingTarget.of("c1", "w1", ""))
        assertEquals("""{"type":"typing","channel_id":"c1","chat_window_id":"w1","character_id":"ada","active":true}""", ada.pack(true).toString())

        signal.edited(ada, "   "); signal.edited(null, "I open the door"); signal.tick()
        assertEquals("blank text, or nobody to write as, raises nothing", emptyList<String>(), sent)
        signal.edited(ada, "I"); assertEquals(listOf("ada@w1+"), sent); assertEquals("ada", signal.raisedFor)
        now = 1_000; signal.edited(ada, "I op"); signal.tick()
        assertEquals("one pack raises it; edits in between send nothing", 1, sent.size)
        now = 4_000; signal.tick(); assertEquals(listOf("ada@w1+", "ada@w1+"), sent)            // the heartbeat
        now = 7_900; signal.tick(); assertEquals(2, sent.size)
        now = 8_000; signal.tick(); assertEquals(3, sent.size)
        // A pause of more than IDLE_MS since the last edit (at 1 s) lowers it; later ticks send nothing.
        now = 9_001; signal.tick(); assertEquals("ada@w1-", sent.last()); assertNull(signal.raisedFor)
        now = 20_000; signal.tick(); assertEquals(4, sent.size)
        // Typing again raises it; sending the line (text cleared) lowers it at once.
        signal.edited(ada, "I open the door"); signal.edited(ada, ""); assertEquals(listOf("ada@w1+", "ada@w1-"), sent.takeLast(2))
        // Another window or character: the old flag falls before the new one goes up.
        signal.edited(ada, "x"); signal.edited(TypingTarget.of("c1", "w2", "ada"), "xy")
        assertEquals(listOf("ada@w1+", "ada@w1-", "ada@w2+"), sent.takeLast(3))
        signal.lower(); signal.lower(); assertEquals("ada@w2-", sent.last()); assertEquals(10, sent.size)
        // A closed stream took the flag with it: nothing to send, and the next edit raises it afresh.
        signal.edited(ada, "again"); signal.forget(); signal.tick(); assertEquals(11, sent.size)
        signal.edited(ada, "again!"); assertEquals(12, sent.size)
    }

    @Test fun vitalsReadAsTheSidebarShowsThem() {
        for (case in fixture["vitals"]!!.jsonArray.map { it.jsonObject }) {
            val parts = Vitals.parts(case["vitals"] as? JsonObject)
            val expected = case["parts"]!!.jsonArray.map { row -> row.jsonArray.let { VitalPart(it[0].jsonPrimitive.content, it[1].jsonPrimitive.content, it[2].jsonPrimitive.boolean) } }
            assertEquals(case.text("name"), expected, parts)
            assertEquals(case.text("name"), case.text("line"), parts.joinToString(" · ") { it.text })
        }
        assertEquals(listOf("HP", "SAN", "DEX"), Vitals.of(buildJsonObject { put("id", "x"); put("vitals", buildJsonObject { put("rule_system", "coc7e") }) }).map { it.label })
        assertTrue(Vitals.of(buildJsonObject { put("id", "x"); put("vitals", JsonNull) }).isEmpty())
    }

    @Test fun inspirationOffersItsOptionsAndRemembersWhatWasShown() {
        val result = fixture["inspiration"]!!.jsonObject
        val options = Inspiration.options(result)
        assertEquals(3, options.size)
        assertEquals(result.text("draft"), options[0].text)
        assertEquals(listOf("probing", "measured", "aside to the table"), options.map { it.angle })
        assertEquals(listOf("", ".ra Spot Hidden", ""), options.map { it.roll })
        assertEquals(listOf("ic", "ic", "ooc"), options.map { it.kind })
        // A result with only a draft is one option; nothing at all is none.
        assertEquals(listOf(InspirationOption("I wait.", "ic", "", "")), Inspiration.options(buildJsonObject { put("draft", "I wait.") }))
        assertTrue(Inspiration.options(buildJsonObject { put("draft", " ") }).isEmpty())
        val shown = Inspiration.shown(emptyList(), result)
        assertEquals(options.map { it.text }, shown)
        assertEquals("shown twice is remembered once", shown, Inspiration.shown(shown, result))
        val many = Inspiration.shown((1..20).map { "line $it" }, result)
        assertEquals(Inspiration.REMEMBERED, many.size); assertEquals(options.last().text, many.last())
    }

    @Test fun pinsAreFoundByTheirLineAndTakenDownByPinnerOrGm() {
        val reminders = fixture["reminders"]!!.jsonArray.map { it.jsonObject }
        val viewer = fixture["viewer"]!!.jsonObject
        val pin = Pins.of(reminders, "m1")!!
        assertEquals("r-pin", pin.id); assertEquals("Sam", pin.text("pinned_by_name"))
        assertNull(Pins.of(reminders, "m2")); assertNull("an AI reminder is no pin", Pins.of(reminders.drop(1), "m1"))
        assertTrue(Pins.canUnpin(pin, viewer.text("id"), false))
        assertFalse(Pins.canUnpin(pin, viewer.text("other"), false)); assertFalse(Pins.canUnpin(pin, null, false))
        assertTrue("the GM takes any pin down", Pins.canUnpin(pin, viewer.text("other"), true))
        assertFalse(Pins.canUnpin(reminders[1], viewer.text("id"), true))
        fun line(kind: String, recalled: String? = null) = Message(id = "m", content = "x", authorName = "Ann", kind = kind, seq = 1, recalledAt = recalled)
        assertTrue(Pins.canPin(line("ic"))); assertTrue(Pins.canPin(line("narration")))
        assertFalse(Pins.canPin(line("system"))); assertFalse(Pins.canPin(line("ic", "2026-11-07T00:00:00Z")))
    }
}
