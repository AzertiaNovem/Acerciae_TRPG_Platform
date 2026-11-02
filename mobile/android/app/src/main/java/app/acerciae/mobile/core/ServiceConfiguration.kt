package app.acerciae.mobile.core

object ServiceConfiguration {
    // Change this constant and rebuild to connect the app to another service.
    const val BACKEND_ROOT = "https://trpg.missazertia.com"
    fun acceptsSavedEndpoint(endpoint: String): Boolean {
        val saved=endpoint.trimEnd('/'); val current=BACKEND_ROOT.trimEnd('/')
        if(saved==current) return true
        // Only the explicitly migrated production service may reuse its existing login.
        return current=="https://trpg.missazertia.com" && saved in listOf("https://trpg.missazertia.com:15510","https://trpg.missazertia.com:443")
    }
}
