import XCTest
@testable import AcerciaeCore

final class AiProvidersTests: XCTestCase {
    private func json(_ s: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
    private func catalog() throws -> JSONValue { try json(#"""
    {"kinds": [
      {"id": "openai", "label": "OpenAI-compatible", "capabilities": ["text", "embedding", "image_generation", "image_edit", "tts"],
       "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}], "models": {"text": ["gpt-5.1"]}},
      {"id": "stability", "label": "Stability AI", "capabilities": ["image_generation", "image_edit"],
       "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}], "models": {}},
      {"id": "aws", "label": "AWS", "capabilities": ["embedding", "tts"],
       "fields": [{"key": "region", "label": "Region", "type": "text", "required": true}, {"key": "access_key_id", "label": "Access key ID", "type": "text", "required": true},
                  {"key": "api_key", "label": "Secret access key", "type": "secret", "required": true}, {"key": "session_token", "label": "Session token", "type": "secret", "required": false}], "models": {}}],
     "uses": [
      {"id": "text", "capability": "text", "modes": ["provider", "mock"], "default": "mock", "label": "Text"},
      {"id": "image_edit", "capability": "image_edit", "modes": ["inherit", "provider", "mock", "disabled"], "default": "inherit", "label": "Image editing"}]}
    """#) }

    func testUsesOnlyOfferProvidersThatCanDoThem() throws {
        let c = try catalog()
        let providers = try json(#"[{"id": "p1", "name": "Gateway", "kind": "openai"}, {"id": "p2", "name": "Stability", "kind": "stability"}]"#).array
        let uses = AiProviders.uses(c)
        XCTAssertEqual(AiProviders.fitting(c, providers: providers, use: uses[0]).map { $0["id"].text }, ["p1"])
        XCTAssertEqual(AiProviders.fitting(c, providers: providers, use: uses[1]).map { $0["id"].text }, ["p1", "p2"])
        XCTAssertEqual(AiProviders.modes(uses[0]), ["mock"])
        XCTAssertEqual(AiProviders.modeLabel(uses[1], "inherit"), "Same as image generation")
        XCTAssertEqual(AiProviders.optionKeys(capability: "text", providerKind: "anthropic"), [])
        XCTAssertEqual(AiProviders.optionKeys(capability: "image_edit", providerKind: "openai"), ["size", "quality"])
        XCTAssertEqual(AiProviders.suggestions(c, kind: "openai", capability: "text"), ["gpt-5.1"])
    }

    func testProviderBodiesKeepStoredSecretsUnlessReplacedOrRemoved() throws {
        let c = try catalog(); let aws = AiProviders.kind(c, "aws")!
        var d = AiProviders.draft(of: nil, kind: aws)
        XCTAssertFalse(AiProviders.ready(d, kind: aws, stored: nil))
        d.options = ["region": " us-west-2 ", "access_key_id": "AKID"]; d.apiKey = "secret"; d.secrets = ["session_token": ""]
        XCTAssertTrue(AiProviders.ready(d, kind: aws, stored: nil))
        let body = AiProviders.body(d)
        XCTAssertEqual(body["kind"].text, "aws"); XCTAssertEqual(body["options"]["region"].text, "us-west-2")
        XCTAssertEqual(body["api_key"].text, "secret"); XCTAssertTrue(body["secrets"].object.isEmpty)
        let stored = try json(#"{"id": "p3", "name": "AWS", "kind": "aws", "api_base": "", "api_key_set": true, "options": {"region": "us-west-2", "access_key_id": "AKID"}, "secrets": {"session_token": {"set": true, "hint": "set"}}}"#)
        var edit = AiProviders.draft(of: stored, kind: aws)
        XCTAssertTrue(AiProviders.ready(edit, kind: aws, stored: stored))
        edit.removedSecrets = ["session_token"]
        let update = AiProviders.body(edit)
        XCTAssertEqual(update["kind"], .null); XCTAssertEqual(update["api_key"], .null)
        XCTAssertEqual(update["secrets"].object["session_token"], .null)
        edit.clearApiKey = true
        XCTAssertFalse(AiProviders.ready(edit, kind: aws, stored: stored))
    }

    func testOnlyChangedUsesAreSent() throws {
        let saved = try json(#"{"text": {"provider": "mock", "model": "", "options": {}}, "embedding": {"provider": "disabled", "model": "", "options": {}}}"#)
        var chosen = AiProviders.choose(saved["text"], "p1").object
        XCTAssertEqual(chosen["model"], .string(""))
        chosen["model"] = .string("gpt-5.1")
        var edited = saved.object; edited["text"] = .object(chosen)
        let body = AiProviders.usesBody(saved: saved, edited: edited)["uses"]
        XCTAssertEqual(Array(body.object.keys), ["text"]); XCTAssertEqual(body["text"]["provider"].text, "p1")
        XCTAssertEqual(AiProviders.choose(body["text"], "p1")["model"].text, "gpt-5.1")
    }
}
