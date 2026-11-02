package app.acerciae.mobile.core

import java.io.File
import java.security.MessageDigest

/** Bounded account-local durable storage; clear prevents older requests from repopulating it. */
class AssetDiskCache(private val dir: File, private val capBytes: Long = 512L * 1024 * 1024, private val legacyDir: File? = null) {
    private var revision = 0
    private var sequence = 0L
    private val latest = mutableMapOf<String,Long>()
    @Synchronized fun reserve(key: String): Long { sequence++; latest[key] = sequence; return sequence }
    private var enabled = true
    @Synchronized fun generation() = revision
    @Synchronized fun invalidate() { enabled = false; clear() }
    @Synchronized fun get(key: String): ByteArray? {
        if (!enabled) return null
        migrate()
        val f = file(key)
        if (!f.isFile) return null
        f.setLastModified(System.currentTimeMillis())
        return runCatching { f.readBytes() }.getOrNull()
    }

    @Synchronized fun put(key: String, bytes: ByteArray, generation: Int? = null, ticket: Long? = null) {
        if (!enabled || bytes.size > capBytes || (generation != null && generation != revision) || (ticket != null && latest[key] != ticket)) return
        migrate()
        if (file(key).isFile && runCatching { file(key).readBytes().contentEquals(bytes) }.getOrDefault(false)) { file(key).setLastModified(System.currentTimeMillis()); return }
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${name(key)}.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file(key))) tmp.delete()
            trim()
        }
    }

    @Synchronized fun clear() { revision++; latest.clear(); dir.deleteRecursively(); legacyDir?.deleteRecursively() }
    @Synchronized fun remove(key: String) { revision++; file(key).delete() }
    private fun migrate() { if (!dir.exists() && legacyDir?.isDirectory == true) { dir.parentFile?.mkdirs(); legacyDir.renameTo(dir) } }

    private fun trim() {
        val files = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".tmp") }?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (f in files) { if (total <= capBytes) break; total -= f.length(); f.delete() }
    }

    private fun file(key: String) = File(dir, name(key))
    private fun name(key: String) = hex(key)

    companion object {
        fun keepable(cacheControl: String?): Boolean { val directives = cacheControl.orEmpty().split(',').map { it.trim().lowercase() }; return "immutable" in directives && "no-store" !in directives }
        fun hex(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
