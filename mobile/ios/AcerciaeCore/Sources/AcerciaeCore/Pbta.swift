import Foundation

public enum Pbta {
    public static func validSheet(_ sheet: JSONValue, pack: JSONValue) -> Bool {
        guard pack["books"].array.contains(where: { $0["id"].text == sheet["book"].text }) else { return false }
        for group in ["stats", "resources", "conditions"] {
            if sheet[group] != .null { guard case .object = sheet[group] else { return false } }
            let known = Set(pack[group].array.map { $0["id"].text })
            for (key, value) in sheet[group].object {
                guard known.contains(key) else { return false }
                if group == "conditions" { if case .bool = value {} else { return false } }
                else { guard case .number(let n) = value, n.isFinite, n.rounded() == n, abs(n) <= 9999 else { return false } }
            }
        }
        return true
    }
    public static func moves(pack: JSONValue, sheet: JSONValue) -> [JSONValue] {
        pack["moves"].array.filter { $0["book"].text.isEmpty || $0["book"].text == sheet["book"].text }
    }
    public static func moveBody(character: String, move: JSONValue, modifier: Int) throws -> JSONValue {
        let id = move["id"].text
        guard id.range(of: "^[a-z][a-z0-9_-]{0,39}$", options: .regularExpression) == id.startIndex..<id.endIndex, (-99...99).contains(modifier) else { throw ClientError.invalidResponse }
        let extra = !move["stat"].text.isEmpty && modifier != 0 ? " \(modifier)" : ""
        return .object(["character_id":.string(character),"kind":.string("ic"),"visibility":.string("window"),"content":.string(".move " + id + extra)])
    }
}
