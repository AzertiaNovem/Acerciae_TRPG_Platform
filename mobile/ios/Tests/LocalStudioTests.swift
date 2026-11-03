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
