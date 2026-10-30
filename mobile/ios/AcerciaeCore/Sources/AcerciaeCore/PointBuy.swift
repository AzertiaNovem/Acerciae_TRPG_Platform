import Foundation

/// UI preview of the server's point rules; saving always uses the authoritative server calculation.
public struct PointBuy: Sendable {
    public let card: JSONValue
    public let rules: JSONValue
    public init(card: JSONValue, rules: JSONValue) { self.card = card; self.rules = rules }
    public var career: JSONValue { rules["careers"].array.first { $0["name"].text == card["career"]["name"].text } ?? .null }
    public var characteristicTotal: Int { ["STR","CON","SIZ","DEX","APP","INT","POW","EDU"].reduce(0) { $0 + card["characteristics"][$1].int } }
    public var careerBudget: Int { career["points"].array.reduce(0) { sum, term in sum + term["mult"].int * max(0, term["attrs"].array.map { card["characteristics"][$0.text].int }.max() ?? 0) } }
    public var hobbyBudget: Int { card["characteristics"]["INT"].int * 2 }
    public func spent(_ kind: String) -> Int { card["skill_points"].object.values.reduce(0) { $0 + $1[kind].int } }
    public var skillNames: [String] { Set(rules["skills"].array.map { $0["name"].text } + Array(card["skills"].object.keys) + Array(card["skill_points"].object.keys)).sorted() }
    public func family(_ key: String) -> String {
        let name = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if name == "Fighting (Brawl)" { return "Fighting" }
        if name.hasPrefix("Firearms (") { return "Firearms" }
        // Longest family first: Language (Other) itself contains parentheses.
        for item in rules["families"].array.sorted(by: { $0["name"].text.count > $1["name"].text.count }) {
            let f = item["name"].text
            if name == f || name.hasPrefix(f + " (") || name.hasPrefix(f + "（") { return f }
        }
        return name
    }
    public func standard(_ key: String) -> Bool { rules["skills"].array.contains { $0["name"].text == key } || family(key) != key }
    public func base(_ key: String) -> Int {
        if let skill = rules["skills"].array.first(where: { $0["name"].text == key }) {
            switch skill["base"].text { case "DEX/2": return card["characteristics"]["DEX"].int / 2; case "EDU": return card["characteristics"]["EDU"].int; default: return skill["base"].int }
        }
        let f = family(key)
        if f == key { return card["skill_points"][key]["base"].int }
        let spec = String(key.dropFirst(f.count)).trimmingCharacters(in: CharacterSet(charactersIn: " ()（）")).lowercased()
        let special: [String: [String: Int]] = ["Fighting": ["brawl":25,"斗殴":25,"axe":15,"chainsaw":10,"链锯":10,"flail":10,"garrote":15,"spear":20,"矛":20,"sword":20,"剑":20,"whip":5,"鞭":5], "Firearms":["handgun":20,"手枪":20,"rifle/shotgun":25,"rifle":25,"shotgun":25,"步枪":25,"霰弹枪":25,"步/霰":25,"bow":15,"弓":15,"弓术":15,"smg":15,"submachine gun":15,"冲锋枪":15,"来复":25,"来复枪":25,"步枪/霰弹枪":25,"火焰喷射器":10,"重武器":10,"机枪":10,"flamethrower":10,"heavy weapons":10,"machine gun":10]]
        return special[f]?[spec] ?? rules["families"].array.first { $0["name"].text == f }?["base"].int ?? 0
    }
    public func covers(_ entry: JSONValue, _ key: String) -> Bool {
        let name = key.trimmingCharacters(in: .whitespacesAndNewlines), f = family(name), target = entry["skill"].text
        if entry["any"].bool { return f == target || name == target }
        let want = entry["spec"].text.trimmingCharacters(in: .whitespaces).lowercased()
        if !want.isEmpty {
            let have = RuleNames.split(name).1.lowercased()
            return f == target && !have.isEmpty && (have.contains(want) || want.contains(have))
        }
        return name == target || (f == target && RuleNames.split(name).1.isEmpty)
    }
    public func allowed(_ key: String) -> Bool {
        guard career != .null else { return false }
        var entries = career["fixed"].array + [.object(["skill": .string("Credit Rating")])]
        for (i, group) in card["career"]["choices"].array.enumerated() where i < career["choices"].array.count {
            for pick in group.array {
                guard let option = career["choices"].array[i]["from"].array.first(where: { covers($0, pick.text) }) else { continue }
                let spec = RuleNames.split(pick.text).1
                entries.append(.object(["skill": .string(family(pick.text)), "spec": .string(spec), "any": .bool(spec.isEmpty && option["any"].bool)]))
            }
        }
        for pick in card["career"]["specialties"].array where !pick.text.isEmpty {
            let spec = RuleNames.split(pick.text).1
            entries.append(.object(["skill": .string(spec.isEmpty ? pick.text : family(pick.text)), "spec": .string(spec)]))
        }
        return entries.contains { covers($0, key) }
    }
    public func total(_ key: String) -> Int {
        let p = card["skill_points"][key]
        return p == .null ? (card["skills"][key] == .null ? base(key) : card["skills"][key].int) : base(key) + p["growth"].int + p["career"].int + p["hobby"].int
    }
    public var issues: [String] {
        var list: [String] = []
        if career == .null && !card["career"]["name"].text.isEmpty { list.append("请选择列表中的职业") }
        if spent("career") > careerBudget { list.append("职业点超过预算") }
        if spent("hobby") > hobbyBudget { list.append("兴趣点超过 INT×2") }
        if card["career"]["specialties"].array.filter { !$0.text.isEmpty }.count > career["free"].int { list.append("自由特长超过职业允许数量") }
        for (i, picks) in card["career"]["choices"].array.enumerated() where i < career["choices"].array.count {
            let group = career["choices"].array[i]
            if picks.array.count > group["pick"].int { list.append("职业选项 \(i + 1) 超过可选数量") }
            if picks.array.contains(where: { pick in !group["from"].array.contains { covers($0, pick.text) } }) { list.append("职业选项 \(i + 1) 包含无效技能") }
        }
        for key in card["skill_points"].object.keys.sorted() {
            let p = card["skill_points"][key]
            if p["career"].int > 0 && !allowed(key) { list.append("\(key)：不能投入职业点，请先调整职业选项或移除点数") }
            if key == "Cthulhu Mythos" && (p["career"].int > 0 || p["hobby"].int > 0) { list.append("克苏鲁神话不能投入职业点或兴趣点") }
            if total(key) > 99 { list.append("\(key)：总值超过 99") }
        }
        return list
    }
    public var creditWarning: String? {
        let range = career["credit"].array
        guard range.count == 2 else { return nil }
        let credit = total("Credit Rating")
        return credit < range[0].int || credit > range[1].int ? "信用评级 \(credit) 不在职业建议范围 \(range[0].int)–\(range[1].int) 内（不阻止保存）" : nil
    }
}
