import Foundation

public enum ServiceConfiguration {
    // Change this constant and rebuild to connect the app to another service.
    public static let backendRoot = "https://trpg.missazertia.com:15510"
    public static func acceptsSavedEndpoint(_ endpoint: String) -> Bool {
        endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == backendRoot.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
