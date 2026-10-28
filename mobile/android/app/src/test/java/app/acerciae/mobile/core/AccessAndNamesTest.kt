package app.acerciae.mobile.core
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*
class AccessAndNamesTest {
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject
    @Test fun allLanguagesAndCanonicalKeys() {
        val rules = obj(javaClass.classLoader!!.getResourceAsStream("localized-rules.json")!!.bufferedReader().use { it.readText() })
        InterfaceLanguage.codes.forEach { language ->
            val names = RuleNames(rules, language)
            listOf("Accounting", "Dodge", "Science (Biology)", "Language (Other) (Latin)", "Firearms (Bow)").forEach { key -> assertEquals(language, key, names.skillKey(names.skillLabel(key))) }
            val career = rules.rows("careers").first(); assertTrue(names.careerLabel(career).isNotEmpty()); assertTrue(names.careerDescription(career).isNotEmpty())
            if (language != "zh-CN") assertNotEquals(career.name, names.careerLabel(career))
        }
        assertEquals("Science (生物学)", RuleNames(rules, "zh-CN").skillKey("科学（生物学）"))
    }
    @Test fun accessMatrixAndMinimalHealth() {
        listOf("owner", "admin", "member", "guest", "").forEach { role -> assertEquals(role in listOf("owner", "admin"), AccessRules.canCreateChannel(role, obj("""{"policy":{"channel_creation":"maintainers"}}"""))) }
        for (gm in listOf(true,false)) for (ended in listOf(true,false)) for (visible in listOf(true,false)) for (player in listOf(true,false)) {
            val channel = buildJsonObject { put("id", "test"); put("my_role", if (gm) "gm" else "player"); put("story_status", if (ended) "ended" else "ongoing"); put("studio_visible", visible); put("studio_player_access", player) }
            assertEquals(if (ended) "open" else if (!visible) "hidden" else if (!gm && !player) "locked" else "open", AccessRules.studio(channel, obj("{}")))
            assertEquals("disabled", AccessRules.studio(channel, obj("""{"features":{"log_studio":false}}""")))
        }
        assertEquals("ok", Json.decodeFromString<Health>("""{"status":"ok"}""").status)
    }
    @Test fun specializationAndEmptySlots() {
        val rules = obj("""{"families":[{"name":"Science","base":1}],"careers":[{"name":"Test","free":1,"fixed":[{"skill":"Science","spec":"Biology"}]}]}""")
        val points = PointBuy(obj("""{"career":{"name":"Test","specialties":["",""]}}"""), rules)
        assertTrue(points.allowed("Science (Biology)")); assertFalse(points.allowed("Science (Chemistry)")); assertTrue(points.issues.isEmpty())
        assertTrue(points.covers(obj("""{"skill":"Science","any":true}"""), "Science（Chemistry）"))
    }
}
