import Foundation
public enum AccessRules {
    public static func studio(_ channel: JSONValue, _ settings: JSONValue) -> String {
        if settings["features"]["log_studio"] == .bool(false) { return "disabled" }
        if channel == .null || channel["id"].text.isEmpty { return "hidden" }
        if channel["story_status"].text == "ended" { return "open" }
        if channel["studio_visible"] == .bool(false) { return "hidden" }
        if channel["my_role"].text != "gm" && channel["studio_player_access"] == .bool(false) { return "locked" }
        return "open"
    }
    public static func canCreateChannel(role: String, settings: JSONValue) -> Bool {
        !role.isEmpty && role != "guest" && (["owner", "admin"].contains(role) || settings["policy"]["channel_creation"].text != "maintainers")
    }
}
