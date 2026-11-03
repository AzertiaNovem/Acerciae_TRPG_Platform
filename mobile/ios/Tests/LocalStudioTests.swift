import XCTest
import WebKit
import PDFKit
import AcerciaeCore
@testable import Acerciae

@MainActor final class LocalStudioTests: XCTestCase {
    func testPackagedEngineImportsAndExportsWithoutAccount() async throws {
        let engine = LocalStudioEngine()
        let text = "Keeper(1234567) 2026/10/02 21:41:06\n夜色笼罩港口。\nHarvey(7654321) 2026/10/02 21:43:45\n我举起提灯。"
        let result = try await engine.call(.object(["action":.string("import"),"files":.array([.object(["name":.string("night.txt"),"data":.string(Data(text.utf8).base64EncodedString())])])]))
        XCTAssertEqual(result["project"]["events"].array.count,2)
        let doc = try await engine.call(.object(["action":.string("vn"),"project":result["project"],"language":.string("zh-CN")]))
        XCTAssertTrue(doc["html"].text.contains("夜色")); XCTAssertFalse(doc["html"].text.contains("StudioNative"))
        let archive = try await engine.call(.object(["action":.string("archive"),"project":result["project"]]))
        XCTAssertTrue(archive["text"].text.contains("acerciae-openstudio-mobile-1"))
    }
    func testAITransportKeepsCredentialsNativeAndRejectsUnsafeEndpoints() async throws {
        for endpoint in ["http://fixture.invalid/v1","https://user:pass@fixture.invalid/v1","https://fixture.invalid/v1?key=secret","https://fixture.invalid/v1#fragment"] {
            XCTAssertThrowsError(try StudioAIConfig(endpoint:endpoint,model:"fixture",key:"fixture-key").url())
        }
        let config = StudioAIConfig(endpoint:"https://fixture.invalid/v1",model:"fixture",key:"fixture-key")
        XCTAssertFalse(String(data:try JSONEncoder().encode(config.publicValue),encoding:.utf8)!.contains("fixture-key"))
        let settings = URLSessionConfiguration.ephemeral; settings.protocolClasses = [StudioAIProtocol.self]
        let session = URLSession(configuration:settings); defer { session.invalidateAndCancel() }
        let response = try await StudioAITransport().send(.object(["model":.string("fixture")]),config:config,session:session)
        XCTAssertEqual(response["status"].int,429)
        XCTAssertEqual(response["body"]["error"].text,"retry later")
    }
    func testNativeRuntimePersistsQuestionsAndKeepsSkippedDraft() async throws {
        let engine = LocalStudioEngine()
        let text = "Keeper(1234567) 2026/10/02 21:41:06\nNight falls."
        let imported = try await engine.call(.object(["action":.string("import"),"files":.array([.object(["name":.string("night.txt"),"data":.string(Data(text.utf8).base64EncodedString())])])]))
        let config: JSONValue = .object(["provider":.string("openai"),"endpoint":.string("https://fixture.invalid/v1"),"model":.string("fixture")])
        var state = try await engine.call(.object(["action":.string("aiStart"),"mode":.string("compose"),"project":imported["project"],"config":config,"language":.string("en")]))
        let answer = "{\"script\":[{\"ref\":\"L1\",\"background\":\"Harbour\",\"text\":\"Rewritten night\"}],\"questions\":[{\"id\":\"q\",\"question\":\"Confirm?\",\"refs\":[\"L1\"],\"options\":[]}]}"
        let response: JSONValue = .object(["status":.number(200),"body":.object(["choices":.array([.object(["message":.object(["content":.string(answer)])])])])])
        state = try await engine.call(.object(["action":.string("aiAnswer"),"id":state["id"],"response":response]))
        while state["state"].text == "running" { state = try await engine.call(.object(["action":.string("aiPoll"),"id":state["id"]])) }
        XCTAssertEqual(state["state"].text,"done")
        var project = state["project"].object; var draft = state["project"]["vn_draft"].object
        var parts = state["project"]["vn_draft"]["pending"].array; var part = parts[0].object; part["skip"] = .bool(true); parts[0] = .object(part); draft["pending"] = .array(parts); project["vn_draft"] = .object(draft)
        let restarted = LocalStudioEngine()
        state = try await restarted.call(.object(["action":.string("aiStart"),"mode":.string("resume"),"project":.object(project),"config":config,"language":.string("en")]))
        while state["state"].text == "running" { state = try await restarted.call(.object(["action":.string("aiPoll"),"id":state["id"]])) }
        XCTAssertEqual(state["state"].text,"done"); XCTAssertEqual(state["project"]["vn_draft"],.null)
        XCTAssertEqual(state["project"]["vn"]["script"]["scenes"].array.first?["lines"].array.first?["text"].text,"Rewritten night")
        let model = LocalStudioModel(); model.project = .object(project); model.startAI("resume")
        let deadline = Date().addingTimeInterval(15)
        while model.aiTask != nil && Date() < deadline { try await Task.sleep(for:.milliseconds(20)) }
        XCTAssertNil(model.error); XCTAssertFalse(model.aiRunning); XCTAssertNotEqual(model.project["vn"],.null)
        let stored = try await model.store.load(model.project["id"].text)
        XCTAssertEqual(stored["vn_draft"],.null); XCTAssertNotEqual(stored["vn"],.null)
        try await model.store.delete(model.project["id"].text)
    }
    func testNativePDFRendererWritesMultipleReadablePages() async throws {
        let web = WKWebView(frame:CGRect(x:0,y:0,width:420,height:595))
        let loaded = expectation(description:"HTML loaded")
        let delegate = StudioLoadDelegate { loaded.fulfill() }; web.navigationDelegate = delegate
        let content = (0..<8).map { "<div style='page-break-after:always;height:500px'>Chapter \($0)</div>" }.joined()
        web.loadHTMLString("<html><body>\(content)</body></html>",baseURL:nil)
        await fulfillment(of:[loaded],timeout:10)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".pdf")
        defer { try? FileManager.default.removeItem(at:url) }
        try StudioPDF.write(web:web,to:url)
        let pdf = try XCTUnwrap(PDFDocument(url:url)); XCTAssertGreaterThan(pdf.pageCount,1)
        XCTAssertTrue(pdf.string?.contains("Chapter") == true)
    }
}
private final class StudioLoadDelegate: NSObject, WKNavigationDelegate {
    let loaded: () -> Void; init(_ loaded:@escaping()->Void) { self.loaded = loaded }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) { loaded() }
}

private final class StudioAIProtocol: URLProtocol {
    override class func canInit(with request:URLRequest)->Bool { request.url?.host == "fixture.invalid" }
    override class func canonicalRequest(for request:URLRequest)->URLRequest { request }
    override func startLoading() {
        let valid = request.url?.path == "/v1/chat/completions" && request.value(forHTTPHeaderField:"Authorization") == "Bearer fixture-key"
        let response = HTTPURLResponse(url:request.url!,statusCode:valid ? 429 : 400,httpVersion:nil,headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Data("{\"error\":\"retry later\"}".utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
