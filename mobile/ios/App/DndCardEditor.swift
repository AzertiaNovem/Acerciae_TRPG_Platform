import SwiftUI
import AcerciaeCore

struct DndCardEditor: View {
    @Binding var card: [String: JSONValue]
    let rules: JSONValue
    let editable: Bool
    let gm: Bool
    let points: Bool
    let language: String
    private let abilities = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]
    private var dnd: JSONValue { card["dnd"] ?? .object(["level": .number(1), "method": .string("point_buy"), "base": .object(Dictionary(uniqueKeysWithValues: abilities.map { ($0, .number(8)) })), "ac": .number(10), "speed": .number(30)]) }
    private func local(_ value: JSONValue) -> String { value["names"][language].string ?? value["name"].text }
    var body: some View {
        Section("D&D 2024 · SRD 5.2") {
            ForEach([("class", "classes"), ("species", "species"), ("background", "backgrounds")], id: \.0) { field, collection in
                Picker(tr(field), selection: text(field)) {
                    Text(tr("— choose —")).tag("")
                    ForEach(Array(rules[collection].array.enumerated()), id: \.offset) { _, value in Text(local(value)).tag(value["name"].text) }
                }
            }
            TextField(tr("Subclass"), text: text("subclass"))
            number("level", label: tr("Level"))
            Picker(tr("Ability scores"), selection: text("method")) {
                Text(tr("Point buy (27 points)")).tag("point_buy"); Text(tr("Standard array (15, 14, 13, 12, 10, 8)")).tag("standard_array")
                if !points { Text(tr("Manual values")).tag("manual") }
            }
            Text(tr("Point buy for role cards") + " · \(abilities.reduce(0) { $0 + rules["point_buy"]["costs"][String(dnd["base"][$1].int)].int }) / \(rules["point_buy"]["budget"].int)").font(.caption)
            ForEach(abilities, id: \.self) { key in
                DisclosureGroup(rules["names"][key][language].string ?? key) {
                    number(key, label: tr("Base"), group: "base")
                    number(key, label: tr("Background increase"), group: "increases")
                    number(key, label: tr("Ability Score Improvements and feats after level 1"), group: "improvements").disabled(points && !gm)
                    Text(tr("Total") + " · \(dnd["base"][key].int + dnd["increases"][key].int + dnd["improvements"][key].int)")
                    Toggle(tr("Saving throw proficiency"), isOn: Binding(get: { dnd["saves"].array.contains(.string(key)) }, set: { on in var saves = dnd["saves"].array.filter { $0 != .string(key) }; if on { saves.append(.string(key)) }; set("saves", .array(saves)) }))
                }
            }
            DisclosureGroup(tr("Skills")) {
                ForEach(Array(rules["skills"].array.enumerated()), id: \.offset) { _, skill in
                    let key = skill["name"].text
                    Picker(rules["names"][key][language].string ?? key, selection: Binding(get: { dnd["skills"][key].int }, set: { set(key, .number(Double($0)), group: "skills") })) {
                        Text(tr("None")).tag(0); Text(tr("Proficient")).tag(1); Text(tr("Expertise")).tag(2)
                    }
                }
            }
            DisclosureGroup(tr("Combat and spellcasting")) {
                ForEach(["ac", "hp_max", "speed", "initiative"], id: \.self) { number($0, label: tr($0)) }
                TextField(tr("Hit Dice"), text: text("hit_dice"))
                Picker(tr("Spellcasting ability"), selection: text("spellcasting_ability")) {
                    Text(tr("None")).tag(""); ForEach(abilities, id: \.self) { Text($0).tag($0) }
                }
                Text(tr("Empty slot limits use the class and level defaults.")).font(.caption)
                ForEach(1...9, id: \.self) { number(String($0), label: tr("Spell level") + " \($0)", group: "slots", optional: true) }
            }
            ForEach(["features", "spells", "notes"], id: \.self) { TextField(tr($0), text: text($0), axis: .vertical) }
        }.disabled(!editable)
    }
    private func text(_ key: String) -> Binding<String> { Binding(get: { dnd[key].text }, set: { value in
        let previous = dnd
        set(key, .string(value))
        if key == "class", let c = rules["classes"].array.first(where: { $0["name"].text == value }) { if c["caster"].text == "none" { set("spellcasting_ability",.string("")) }; set("saves", c["saves"]); set("hit_dice", .string("\(max(1,dnd["level"].int))d\(c["hit_die"].int)")) }
        if key == "species", let s = rules["species"].array.first(where: { $0["name"].text == value }) { set("speed", s["speed"]) }
        if key == "background", let b = rules["backgrounds"].array.first(where: { $0["name"].text == value }) { set("increases", .object([:])); var skills=previous["skills"].object; if let old=rules["backgrounds"].array.first(where: { $0["name"] == previous["background"] }) { for skill in old["skills"].array where skills[skill.text]?.int == 1 { skills.removeValue(forKey:skill.text) } }; for skill in b["skills"].array { skills[skill.text] = .number(Double(max(1,skills[skill.text]?.int ?? 0))) }; set("skills",.object(skills)) }
    }) }
    private func set(_ key: String, _ value: JSONValue, group: String = "") {
        var fields = dnd.object
        if group.isEmpty { fields[key] = value } else { var section = fields[group]?.object ?? [:]; if value == .null { section.removeValue(forKey: key) } else { section[key] = value }; fields[group] = .object(section) }
        card["dnd"] = .object(fields)
    }
    private func number(_ key: String, label: String, group: String = "", optional: Bool = false) -> some View {
        LabeledContent(label) { TextField(label, text: Binding(get: { let v = group.isEmpty ? dnd[key] : dnd[group][key]; return optional && v == .null ? "" : String(v.int) }, set: { if optional && $0.isEmpty { set(key, .null, group: group) } else if let n = Int($0), (-999...9999).contains(n) { set(key, .number(Double(n)), group: group) } })).multilineTextAlignment(.trailing).keyboardType(.numbersAndPunctuation) }
    }
}
