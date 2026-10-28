package app.acerciae.mobile.core
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*
class PointBuyTest {
    private fun fixture() = Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("point-buy.json")!!.bufferedReader().use { it.readText() }).jsonObject
    @Test fun budgetsBasesAndEligibility() {
        val f = fixture(); val p = PointBuy(f.obj("card"), f.obj("rules"))
        assertEquals(475, p.characteristicTotal); assertEquals(230, p.careerBudget); assertEquals(130, p.hobbyBudget)
        assertEquals(27, p.base("Dodge")); assertEquals(60, p.base("Language (Own)")); assertEquals(20, p.base("Fighting (Sword)")); assertEquals(1, p.base("Science (Biology)")); assertEquals(1, p.base("Language (Other) (Latin)"))
        assertEquals(62, p.total("Listen")); assertEquals(40, p.spent("career")); assertFalse(p.allowed("Fighting (Sword)")); assertTrue(p.allowed("Spot Hidden")); assertFalse(p.allowed("Dodge")); assertNull(p.creditWarning)
    }
    @Test fun violationsAndWarnings() {
        val f = fixture()
        f.rows("cases").forEach { assertEquals(it.name, it.number("issues"), PointBuy(it.obj("card"), f.obj("rules")).issues.size) }
        val p = PointBuy(JsonObject(f.obj("card") + ("skill_points" to JsonObject(emptyMap()))), f.obj("rules"))
        assertNotNull(p.creditWarning); assertTrue(p.issues.isEmpty())
    }
}
