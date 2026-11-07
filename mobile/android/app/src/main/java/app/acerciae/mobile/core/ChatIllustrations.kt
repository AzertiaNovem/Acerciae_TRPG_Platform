package app.acerciae.mobile.core

object ChatIllustrations {
    /** The line, rather than the asset library, grants permission to see a picture. */
    fun path(channel: String, message: String) = listOf("channels", channel, "messages", message, "image")
    fun key(server: String, account: String, channel: String, message: String) = listOf("chat-image", server, account, channel, message).joinToString("|")
    fun caption(content: String): String = if (content.startsWith("\uD83D\uDDBC")) content.removePrefix("\uD83D\uDDBC").removePrefix("\uFE0F").trim() else content
    /** A message's picture never changes; its endpoint permits private caching without immutable. */
    fun keepable(cacheControl: String?, path: List<String>): Boolean {
        val parts = cacheControl.orEmpty().split(',').map { it.trim().lowercase() }
        if ("no-store" in parts || "no-cache" in parts) return false
        if (AssetDiskCache.keepable(cacheControl)) return true
        if (path.size != 5 || path[0] != "channels" || path[2] != "messages" || path[4] != "image") return false
        return parts.any { it.substringBefore('=').trim() == "max-age" && (it.substringAfter('=', "").trim().toLongOrNull() ?: 0) > 0 }
    }
}
