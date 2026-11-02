import Foundation
public enum WindowActivity {
    public static func shouldNotify(previous: JSONValue, current: JSONValue, user: String, viewing: String) -> Bool {
        current["id"].text != viewing && previous != .null && current["last_seq"].int > previous["last_seq"].int && current["unread"].int > 0 && (current["kind"].text == "main" || current["members"].array.contains { $0["user_id"].text == user })
    }
    public static func speaker(_ message: Message) -> String { message.kind == "ooc" ? message.authorName : message.characterName ?? message.authorName }
}
