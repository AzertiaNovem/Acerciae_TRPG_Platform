package app.acerciae.mobile.core
import kotlinx.serialization.json.*
object FeatureAccess {
    fun enabled(feature: String, server: JsonObject, channel: JsonObject): Boolean = server.obj("features").flag(feature) &&
        (feature !in listOf("consistency", "inspiration", "atmosphere") || channel[feature + "_enabled"] != JsonPrimitive(false))
}
