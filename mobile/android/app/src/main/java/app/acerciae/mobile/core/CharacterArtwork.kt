package app.acerciae.mobile.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

data class CharacterArtwork(val id: String, val version: Int, val hash: String) {
    val query: Map<String, String> get() = if (version > 0) mapOf("v" to version.toString()) else emptyMap()
    companion object {
        fun avatar(character: JsonObject?, message: Message? = null): CharacterArtwork? {
            if (character != null) {
                val id = character.text("avatar_asset_id").takeIf { it.isNotEmpty() } ?: return null
                return CharacterArtwork(id, character.number("avatar_asset_version"), character.text("avatar_asset_hash"))
            }
            val id = message?.characterAvatarAssetId?.takeIf { it.isNotEmpty() } ?: return null
            return CharacterArtwork(id, message.characterAvatarVersion ?: 0, message.characterAvatarHash.orEmpty())
        }
        fun inSpace(space: JsonObject): List<CharacterArtwork> =
            (listOf(space.obj("avatar"), space.obj("portrait")) + space.rows("subtitles")).mapNotNull {
                it.id.takeIf(String::isNotEmpty)?.let { id -> CharacterArtwork(id, it.number("version"), it.text("hash").ifEmpty { it.text("content_hash") }) }
            }
    }
}

/** A single background queue. Replaced on account, channel or permission changes. */
class CharacterArtworkPrefetcher(private val now: () -> Long = System::currentTimeMillis) {
    private data class Space(val revision: String, val date: Long, val value: JsonObject)
    private val spaces = mutableMapOf<String, Space>()
    private val attempts = mutableMapOf<String, Long>()
    private val lock = Mutex()

    suspend fun warm(channel: String, characters: List<JsonObject>, client: BackendClient, token: String) = withContext(Dispatchers.IO) {
        lock.withLock {
            val cache = client.assets ?: return@withLock
            val generation = cache.generation()
            suspend fun active(): Boolean { currentCoroutineContext().ensureActive(); return cache.generation() == generation }
            for (character in characters) {
                if (!active()) return@withLock
                CharacterArtwork.avatar(character)?.let { warm(it, channel, client, token) }
            }
            for (character in characters) {
                if (!active()) return@withLock
                val revision = character.toString()
                val kept = spaces[character.id]
                val space = if (kept != null && kept.revision == revision && now() - kept.date < 60_000) kept.value else {
                    val key = "space:${character.id}:$revision"
                    if ((attempts[key] ?: 0) > now()) continue
                    attempts[key] = now() + 60_000
                    try {
                        val fresh = client.resource(listOf("channels", channel, "characters", character.id, "space"), token)
                        if (!active()) return@withLock
                        spaces[character.id] = Space(revision, now(), fresh)
                        fresh
                    } catch (e: CancellationException) { throw e } catch (_: Exception) { continue }
                }
                for (asset in CharacterArtwork.inSpace(space)) {
                    if (!active()) return@withLock
                    warm(asset, channel, client, token)
                }
            }
            spaces.keys.retainAll(characters.map { it.id }.toSet())
            attempts.entries.removeAll { it.value <= now() }
        }
    }

    private suspend fun warm(asset: CharacterArtwork, channel: String, client: BackendClient, token: String) {
        currentCoroutineContext().ensureActive()
        if (asset.version <= 0) return
        val key = AssetDiskCache.key(asset.hash, "$channel/${asset.id}?v=${asset.version}")
        if ((attempts[key] ?: 0) > now()) return
        try {
            client.bytes(listOf("channels", channel, "media", asset.id), token, asset.query, asset.hash)
            currentCoroutineContext().ensureActive()
            // Also throttle non-persistable private images; never override the server's cache policy.
            attempts[key] = now() + 300_000
        } catch (e: CancellationException) { throw e } catch (_: Exception) { attempts[key] = now() + 60_000 }
    }
}
