import SwiftUI
import AcerciaeCore

struct PointBuyEditor: View {
    @Binding var card: [String: JSONValue]
    let rules: JSONValue
    let editable: Bool
    let isKeeper: Bool
    let language: String
    private var names: RuleNames { RuleNames(rules: rules, language: language) }
    @State private var search = ""
    @State private var newSkill = ""
    private var preview: PointBuy { PointBuy(card: .object(card), rules: rules) }
    private var career: JSONValue { preview.career }
    var body: some View {
        Section(tr("CoC7 购点")) {
            Text(tr("Characteristics") + " \(preview.characteristicTotal) · LUK \(card["characteristics"]?["LUK"].int ?? 0)")
            NavigationLink(card["career"]?["name"].text.isEmpty == false ? tr("Career") + ": " + names.careerLabel(career) : tr("选择职业")) {
                CareerPicker(rules: rules, language: language) { name in
                    card["career"] = .object(["name": .string(name), "choices": .array([]), "specialties": .array([])])
                }
            }.disabled(!editable)
            if career != .null {
                Text(names.careerDescription(career)).font(.caption)
                Text(tr("Career points") + ": \(names.formula(career)) = \(preview.careerBudget)").font(.caption)
                Text(tr("固定职业技能：") + career["fixed"].array.map { names.optionLabel($0) }.joined(separator: "、")).font(.caption)
                if career["credit"].array.count == 2 { Text(tr("Credit Rating") + ": \(career["credit"].array[0].int)–\(career["credit"].array[1].int)").font(.caption) }
                ForEach(Array(career["choices"].array.enumerated()), id: \.offset) { i, group in
                    DisclosureGroup(tr("Career") + " \(i + 1) · " + tr("Pick {n} of:").replacingOccurrences(of: "{n}", with: String(group["pick"].int))) {
                        ForEach(Array(group["from"].array.enumerated()), id: \.offset) { _, option in
                            let key = option["skill"].text + (option["spec"].text.isEmpty ? "" : " (\(option["spec"].text))")
                            Toggle(names.optionLabel(option), isOn: Binding(get: { choices(i).contains(.string(key)) }, set: { on in
                                var picks = choices(i); if on { picks.append(.string(key)) } else { picks.removeAll { $0 == .string(key) } }; setChoices(i, picks)
                            })).disabled(!editable || (!choices(i).contains(.string(key)) && choices(i).count >= group["pick"].int))
                        }
                    }
                }
                ForEach(0..<max(0, career["free"].int), id: \.self) { i in
                    LabeledContent(tr("Skills") + " \(i + 1)") {
                        TextField(tr("技能名"), text: Binding(get: { let list = card["career"]?["specialties"].array ?? []; return i < list.count ? names.skillLabel(list[i].text) : "" }, set: { value in
                            var list = card["career"]?["specialties"].array ?? []; while list.count <= i { list.append(.string("")) }; list[i] = .string(names.skillKey(value))
                            while list.last?.text == "" { list.removeLast() }; setCareerField("specialties", .array(list))
                        })).multilineTextAlignment(.trailing)
                    }.disabled(!editable)
                }
                if career["free"].int > 0 { Text(tr("特长使用下方技能名，可填专长如 Science (Biology)。")).font(.caption) }
            }
            Text(tr("Career points") + " \(preview.spent("career")) / \(preview.careerBudget) · " + tr("Hobby points") + " \(preview.spent("hobby")) / \(preview.hobbyBudget)")
                .foregroundStyle(preview.issues.isEmpty ? Color.primary : Color.orange)
            ForEach(preview.issues, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
            if let warning = preview.creditWarning { Text(warning).font(.caption).foregroundStyle(.orange) }
            Text(tr("总值 = 基础 + 成长 + 职业 + 兴趣。这里显示预览，保存时由服务器重新校验。")).font(.caption).foregroundStyle(.secondary)
        }
        Section(tr("技能分配")) {
            TextField(tr("搜索技能"), text: $search)
            ForEach(preview.skillNames.filter { search.isEmpty || $0.localizedCaseInsensitiveContains(search) || names.skillLabel($0).localizedCaseInsensitiveContains(search) }, id: \.self) { key in
                DisclosureGroup("\(names.skillLabel(key)) · \(preview.total(key))\(preview.allowed(key) ? " · " + tr("Career") : "")") {
                    Text("½ \(preview.total(key) / 2) · ⅕ \(preview.total(key) / 5)").font(.caption)
                    if preview.standard(key) { LabeledContent(tr("基础"), value: String(preview.base(key))) }
                    else { pointField(key, "base", tr("基础")) }
                    pointField(key, "growth", tr("成长"), locked: !isKeeper || key == "Cthulhu Mythos")
                    pointField(key, "career", tr("职业"), locked: !preview.allowed(key) || key == "Cthulhu Mythos")
                    pointField(key, "hobby", tr("兴趣"), locked: key == "Cthulhu Mythos")
                    if editable && card["skill_points"]?[key] != nil {
                        Button(tr("清空此技能分配")) { var points = card["skill_points"]?.object ?? [:]; points[key] = .object(["growth": points[key]?["growth"] ?? .number(0), "base": points[key]?["base"] ?? .number(0)]); card["skill_points"] = .object(points) }
                    }
                    if editable && !preview.standard(key) && (isKeeper || (card["skill_points"]?[key]["growth"].int ?? 0) == 0) { Button(tr("移除自定义技能"), role: .destructive) { remove(key) } }
                }
            }
            if editable {
                TextField(tr("添加专长或自定义技能"), text: $newSkill)
                Button(tr("添加技能")) {
                    let key = names.skillKey(newSkill)
                    var points = card["skill_points"]?.object ?? [:]; if points[key] == nil { points[key] = .object(["growth": points[key]?["growth"] ?? .number(0), "base": points[key]?["base"] ?? .number(0)]) }; card["skill_points"] = .object(points); search = key; newSkill = ""
                }.disabled(newSkill.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || newSkill.count > 60)
            }
        }
    }
    private func pointField(_ key: String, _ kind: String, _ label: String, locked: Bool = false) -> some View {
        LabeledContent(label) {
            TextField(label, text: Binding(get: { String(card["skill_points"]?[key][kind].int ?? 0) }, set: { text in
                guard let value = Int(text.isEmpty ? "0" : text), (0...(kind == "base" ? 99 : 999)).contains(value) else { return }
                var points = card["skill_points"]?.object ?? [:]; var entry = points[key]?.object ?? [:]; entry[kind] = .number(Double(value)); points[key] = .object(entry); card["skill_points"] = .object(points)
            })).keyboardType(.numberPad).multilineTextAlignment(.trailing).disabled(!editable || locked)
        }
    }
    private func choices(_ i: Int) -> [JSONValue] { let groups = card["career"]?["choices"].array ?? []; return i < groups.count ? groups[i].array : [] }
    private func setCareerField(_ key: String, _ value: JSONValue) { var c = card["career"]?.object ?? [:]; c[key] = value; card["career"] = .object(c) }
    private func setChoices(_ i: Int, _ picks: [JSONValue]) { var groups = card["career"]?["choices"].array ?? []; while groups.count <= i { groups.append(.array([])) }; groups[i] = .array(picks); setCareerField("choices", .array(groups)) }
    private func remove(_ key: String) { for group in ["skills", "skill_points"] { var values = card[group]?.object ?? [:]; values.removeValue(forKey: key); card[group] = .object(values) } }
}
private struct CareerPicker: View {
    let rules: JSONValue
    let language: String
    private var names: RuleNames { RuleNames(rules: rules, language: language) }
    let select: (String) -> Void
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            Button(tr("暂不选择职业")) { select(""); dismiss() }
            ForEach(Array(rules["careers"].array.filter { search.isEmpty || $0["name"].text.localizedCaseInsensitiveContains(search) || names.careerLabel($0).localizedCaseInsensitiveContains(search) }.enumerated()), id: \.offset) { _, career in
                Button { select(career["name"].text); dismiss() } label: {
                    VStack(alignment: .leading) { Text(names.careerLabel(career)); Text(names.formula(career)).font(.caption).foregroundStyle(.secondary) }
                }
            }
        }.searchable(text: $search, prompt: tr("搜索职业")).navigationTitle(tr("选择职业"))
    }
}
