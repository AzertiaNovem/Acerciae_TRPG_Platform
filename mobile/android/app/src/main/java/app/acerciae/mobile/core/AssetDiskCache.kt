package app.acerciae.mobile.core

import java.io.File
import java.security.MessageDigest

/**
 * Bounded account-local durable storage; clear prevents older requests from repopulating it.
 *
 * An entry is keyed by the picture's content hash when the server named one ([key]), else by its URL. Each use renews
 * its lifespan (the file's modification time): an entry not used for [maxAgeMs] is dropped, and beyond [capBytes] the
 * least recently used go first. A picture whose hash did not change is therefore never downloaded again while it lives.
 */
class AssetDiskCache(private val dir: File, private val capBytes: Long = 512L * 1024 * 1024, private val legacyDir: File? = null, private val maxAgeMs: Long = DEFAULT_MAX_AGE_MS, private val clock: () -> Long = System::currentTimeMillis) {
    private var revision = 0
    private var sequence = 0L
    private val latest = mutableMapOf<String,Long>()
    @Synchronized fun reserve(key: String): Long { sequence++; latest[key] = sequence; return sequence }
    private var enabled = true
    @Synchronized fun generation() = revision
    @Synchronized fun invalidate() { enabled = false; clear() }
    private var swept = false
    @Synchronized fun get(key: String): ByteArray? {
        if (!enabled) return null
        migrate()
        if (!swept) { swept = true; runCatching { trim() } }   // once per process: what expired goes before anything is read
        val f = file(key)
        if (!f.isFile) return null
        if (expired(f)) { f.delete(); return null }   // not used for maxAgeMs: downloaded again
        f.setLastModified(clock())                    // used: the lifespan starts over
        return runCatching { f.readBytes() }.getOrNull()
    }

    @Synchronized fun put(key: String, bytes: ByteArray, generation: Int? = null, ticket: Long? = null) {
        if (!enabled || bytes.size > capBytes || (generation != null && generation != revision) || (ticket != null && latest[key] != ticket)) return
        migrate()
        if (file(key).isFile && runCatching { file(key).readBytes().contentEquals(bytes) }.getOrDefault(false)) { file(key).setLastModified(clock()); return }
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${name(key)}.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file(key))) tmp.delete() else file(key).setLastModified(clock())
            trim()
        }
    }

    @Synchronized fun clear() { revision++; latest.clear(); dir.deleteRecursively(); legacyDir?.deleteRecursively() }
    @Synchronized fun remove(key: String) { revision++; file(key).delete() }
    private fun migrate() { if (!dir.exists() && legacyDir?.isDirectory == true) { dir.parentFile?.mkdirs(); legacyDir.renameTo(dir) } }

    private fun expired(f: File) = clock() - f.lastModified() > maxAgeMs
    /** Drops what expired, then the least recently used beyond the cap. Also runs on [sweep] at app start. */
    private fun trim() {
        val files = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".tmp") }?.sortedBy { it.lastModified() } ?: return
        val kept = files.filter { if (expired(it)) { it.delete(); false } else true }
        var total = kept.sumOf { it.length() }
        for (f in kept) { if (total <= capBytes) break; total -= f.length(); f.delete() }
    }
    @Synchronized fun sweep() { if (enabled) runCatching { trim() } }

    private fun file(key: String) = File(dir, name(key))
    private fun name(key: String) = hex(key)

    companion object {
        const val DEFAULT_MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000
        /** The cache key for a picture: its content hash when the server named one, else the URL it is fetched from. */
        fun key(hash: String?, url: String): String = hash?.takeIf { it.isNotEmpty() }?.let { "sha:$it" } ?: url
        fun keepable(cacheControl: String?): Boolean { val directives = cacheControl.orEmpty().split(',').map { it.trim().lowercase() }; return "immutable" in directives && "no-store" !in directives }
        fun hex(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
