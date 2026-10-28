package app.acerciae.mobile.core

object ServiceConfiguration {
    // Change this constant and rebuild to connect the app to another service.
    const val BACKEND_ROOT = "https://trpg.missazertia.com:15510"
    fun acceptsSavedEndpoint(endpoint: String) = endpoint.trimEnd('/') == BACKEND_ROOT.trimEnd('/')
}
