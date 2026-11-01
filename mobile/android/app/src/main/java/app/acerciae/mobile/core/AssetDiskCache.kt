package app.acerciae.mobile.core

import java.io.File
import java.security.MessageDigest

/**
 * Media the app has already downloaded (avatars, portraits, standees, backdrops, voice lines), kept in the app's cache
 * directory so each is fetched once. Only responses the server marks `immutable` are kept: a named version of
 * something a player may see. A stored object never changes, and the server never marks GM-private material, so it is
 * never written to disk. One directory per account and server; the least recently used files go first beyond
 * [capBytes]; signing out deletes them all.
 */
class AssetDiskCache(private val dir: File, private val capBytes: Long = 200L * 1024 * 1024) {
    @Synchronized fun get(key: String): ByteArray? {
        val f = file(key)
        if (!f.isFile) return null
        f.setLastModified(System.currentTimeMillis())
        return runCatching { f.readBytes() }.getOrNull()
    }

    @Synchronized fun put(key: String, bytes: ByteArray) {
        if (bytes.size > capBytes) return
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${name(key)}.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file(key))) tmp.delete()
            trim()
        }
    }

    @Synchronized fun clear() { dir.deleteRecursively() }

    private fun trim() {
        val files = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".tmp") }?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (f in files) { if (total <= capBytes) break; total -= f.length(); f.delete() }
    }

    private fun file(key: String) = File(dir, name(key))
    private fun name(key: String) = hex(key)

    companion object {
        fun keepable(cacheControl: String?): Boolean = cacheControl?.split(',')?.any { it.trim().equals("immutable", ignoreCase = true) } == true
        fun hex(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
