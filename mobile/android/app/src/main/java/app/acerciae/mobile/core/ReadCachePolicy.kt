package app.acerciae.mobile.core

object ReadCachePolicy {
    fun keep(path: List<String>): Boolean {
        val first = path.firstOrNull() ?: return false
        if (first == "servers") return path.size == 1 || (path.size == 3 && path[2] in listOf("channels", "settings"))
        if (first in listOf("coc7", "dnd")) return path.last() == "rules"
        if (first != "channels" || path.size < 2) return false
        return path.size == 2 || (path[2] in listOf("windows", "characters", "scenes", "documents", "highlights", "reminders", "atmosphere", "world", "pbta") && "assets" !in path)
    }
}
