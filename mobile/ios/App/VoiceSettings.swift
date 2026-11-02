import SwiftUI
import AcerciaeCore

struct VoiceSettings: View {
    @ObservedObject var model: AppModel
    @State private var status: JSONValue = .null
    @State private var profiles: [Resource] = []
    @State private var presets: [Resource] = []
    @State private var selected = ""
    @State private var fields: [String: JSONValue] = [:]
    private var base: [String] { ["channels", model.channelId, "studio"] }
    private var features: JSONValue { status["features"] }
    private var canEdit: Bool { status != .null && !model.busy && (selected.isEmpty || profiles.first { $0.id == selected }?["editable"] != .bool(false)) }
    var body: some View {
        Form {
            Section(tr("Voice")) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(features["label"].string ?? status["provider"].text).font(.headline)
                    Text(status["official_model"].text).font(.caption).foregroundStyle(.secondary)
                }
                if status["mock"].bool { Text(tr("示例服务，无真实配音费用")) }
                Picker(tr("Voice"), selection: $selected) {
                    Text(tr("添加预设音色")).tag("")
                    ForEach(profiles.filter { $0["provider"].text == status["provider"].text }) { v in Text(v.name).tag(v.id) }
                }.onChange(of: selected) { _, _ in reset() }
                TextField(tr("Name"), text: binding("name"))
                Picker(tr("Voice"), selection: binding("voice_id")) {
                    ForEach(presets) { p in Text(p.name).tag(p.id) }
                    if !presets.contains(where: { $0.id == fields["voice_id"]?.text }), let value = fields["voice_id"]?.text, !value.isEmpty { Text(value).tag(value) }
                }
                if !features["models"].array.isEmpty {
                    Picker(tr("Model"), selection: binding("model_id")) { ForEach(features["models"].array.map(\.text), id: \.self) { Text($0).tag($0) } }
                }
                if !features["languages"].array.isEmpty {
                    Picker(tr("Language"), selection: binding("language")) { ForEach(Array(features["languages"].array.enumerated()), id: \.offset) { _, l in Text(tr(l["label"].text)).tag(l["id"].text) } }
                    Text(tr(features["language_note"].text)).font(.caption)
                }
                if features["dialect"] != .null { TextField(tr(features["dialect"]["label"].text), text: binding("dialect")) }
                if features["instructions"].bool {
                    TextField(tr("identity instruction"), text: binding("style_instruction"), axis: .vertical)
                    Text(tr(features["instruction_note"].text)).font(.caption)
                }
                ForEach(Array(features["params"].array.enumerated()), id: \.offset) { _, p in
                    let key = p["key"].text
                    if number(p["max"]) > number(p["min"]) {
                        VStack(alignment: .leading) {
                            Text(tr(p["label"].text) + " · " + String(format: "%.2f", number(fields["synthesis_parameters"]?[key] ?? p["default"])))
                            Slider(value: Binding(get: { min(number(p["max"]), max(number(p["min"]), number(fields["synthesis_parameters"]?[key] ?? p["default"]))) }, set: { value in var params = fields["synthesis_parameters"]?.object ?? [:]; params[key] = .number(value); fields["synthesis_parameters"] = .object(params) }), in: number(p["min"])...number(p["max"]), step: max(0.01, number(p["step"])))
                        }
                    }
                }
                Button(tr("Save")) { Task { await model.run {
                    var body = fields
                    if selected.isEmpty { body["voice_type"] = .string("preset") }
                    let value = try await model.get(base + ["voices"] + (selected.isEmpty ? [] : [selected]), body: .object(body), method: selected.isEmpty ? "POST" : "PUT")
                    profiles = try await model.typed(base + ["voices"]); selected = value["id"].text; reset(); model.notice = tr("Saved")
                } } }.disabled(!canEdit || fields["name"]?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false || fields["voice_id"]?.text.isEmpty != false)
            }
        }.navigationTitle(tr("Voice settings")).task { await model.run {
            status = try await model.get(base + ["tts", "status"]); profiles = try await model.typed(base + ["voices"]); presets = try await model.typed(base + ["tts", "available-voices"]); reset()
        } }
    }
    private func number(_ v: JSONValue) -> Double { if case .number(let x) = v { return x }; return 0 }
    private func binding(_ key: String) -> Binding<String> { Binding(get: { fields[key]?.text ?? "" }, set: { fields[key] = .string($0) }) }
    private func reset() {
        let v = profiles.first { $0.id == selected }?.value ?? .null
        fields = ["name": .string(v["name"].text), "voice_id": .string(v["voice_id"].string ?? presets.first?.id ?? ""), "model_id": .string(v["model_id"].string ?? status["official_model"].text)]
        fields["language"] = .string(v["language"].string ?? features["languages"].array.first?["id"].text ?? "auto")
        if features["dialect"] != .null { fields["dialect"] = .string(v["dialect"].text) }
        if features["instructions"].bool { fields["style_instruction"] = .string(v["style_instruction"].text) }
        var params: [String: JSONValue] = [:]
        for p in features["params"].array { params[p["key"].text] = v["synthesis_parameters"][p["key"].text] == .null ? p["default"] : v["synthesis_parameters"][p["key"].text] }
        fields["synthesis_parameters"] = .object(params)
    }
}
