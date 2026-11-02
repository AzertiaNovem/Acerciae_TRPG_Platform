import Foundation

public enum ServiceConfiguration {
    // Change this constant and rebuild to connect the app to another service.
    public static let backendRoot = "https://trpg.missazertia.com"
    public static func acceptsSavedEndpoint(_ endpoint: String) -> Bool {
        let saved = endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let current = backendRoot.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if saved == current { return true }
        // Only the explicitly migrated production service may reuse its existing login.
        return current == "https://trpg.missazertia.com" && ["https://trpg.missazertia.com:15510", "https://trpg.missazertia.com:443"].contains(saved)
    }
}
