import Foundation
public enum FeatureAccess {
    public static func enabled(_ feature: String, server: JSONValue, channel: JSONValue) -> Bool {
        guard server["features"][feature].bool else { return false }
        return !["consistency", "inspiration", "atmosphere"].contains(feature) || channel[feature + "_enabled"] != .bool(false)
    }
}
