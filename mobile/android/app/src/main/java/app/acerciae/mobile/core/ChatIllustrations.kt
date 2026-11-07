package app.acerciae.mobile.core

object ChatIllustrations {
    /** The line, rather than the asset library, grants permission to see a picture. */
    fun path(channel: String, message: String) = listOf("channels", channel, "messages", message, "image")
    fun key(server: String, account: String, channel: String, message: String) = listOf("chat-image", server, account, channel, message).joinToString("|")
    fun caption(content: String): String = if (content.startsWith("\uD83D\uDDBC")) content.removePrefix("\uD83D\uDDBC").removePrefix("\uFE0F").trim() else content
    /** The name a saved copy gets, as the server names a download but without its date (a line here carries none):
     *  "illustration-<description>.png" (the line's text without its mark, at most 40 characters, any script kept,
     *  characters file systems refuse replaced by "-"); the extension follows the picture's bytes. */
    fun fileName(content: String, bytes: ByteArray): String {
        val text = caption(content)
        val refused = " \t/\\:*?\"<>|.,;!'`#%&{}[]()=+~$@^"
        val slug = StringBuilder()
        var i = 0; var count = 0
        while (i < text.length && count < 40) {
            val cp = text.codePointAt(i); i += Character.charCount(cp); count++
            if (cp < 0x20 || cp == 0x7F || Character.isWhitespace(cp) || (cp < 0x80 && refused.indexOf(cp.toChar()) >= 0)) {
                if (slug.isNotEmpty() && slug.last() != '-') slug.append('-')
            } else slug.appendCodePoint(cp)
        }
        val name = slug.toString().trim('-')
        return "illustration" + (if (name.isEmpty()) "" else "-$name") + extension(bytes)
    }
    fun extension(bytes: ByteArray): String = when (mime(bytes)) { "image/jpeg" -> ".jpg"; "image/webp" -> ".webp"; else -> ".png" }
    fun mime(bytes: ByteArray): String = when {
        bytes.size >= 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte() -> "image/jpeg"
        bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
        else -> "image/png"
    }
    /** A message's picture never changes; its endpoint permits private caching without immutable. */
    fun keepable(cacheControl: String?, path: List<String>): Boolean {
        val parts = cacheControl.orEmpty().split(',').map { it.trim().lowercase() }
        if ("no-store" in parts || "no-cache" in parts) return false
        if (AssetDiskCache.keepable(cacheControl)) return true
        if (path.size != 5 || path[0] != "channels" || path[2] != "messages" || path[4] != "image") return false
        return parts.any { it.substringBefore('=').trim() == "max-age" && (it.substringAfter('=', "").trim().toLongOrNull() ?: 0) > 0 }
    }
}
