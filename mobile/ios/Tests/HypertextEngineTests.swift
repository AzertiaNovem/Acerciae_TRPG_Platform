import XCTest
import CryptoKit
import AcerciaeCore
@testable import Acerciae

/// The interactive message engine host (HypertextEngine.swift) with the packaged bundle in a real WKWebView: the steady
/// cases of the shared fixture's "runs", checked natively as the app checks them, and probes that the page reaches no
/// network, cannot navigate away, and can start the blob: worker the bundle runs scripts in.
@MainActor final class HypertextEngineTests: XCTestCase {
    private func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    func testThePackagedBundleIsTheCommittedBuildTheCoreExpects() throws {
        let page = try XCTUnwrap(HypertextEngine.page, "hypertext/hypertext-engine.html is an app resource")
        XCTAssertTrue(HypertextEngine.available)
        let folder = page.deletingLastPathComponent()
        XCTAssertEqual(folder.lastPathComponent, Hypertext.EngineHost.folder)
        let script = try Data(contentsOf: folder.appendingPathComponent("hypertext-engine.js"))
        let hashes = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: folder.appendingPathComponent("hypertext-engine.sha256.json")))
        XCTAssertEqual(hashes["bundle_sha256"].text, hex(script))
        XCTAssertEqual(hashes["bytes"].int, script.count)
        let engine = try HypertextRunCases.fixture()["engine"]
        XCTAssertEqual(hashes["wasm_sha256"], engine["wasm_sha256"])
        XCTAssertLessThanOrEqual(script.count, engine["max_bundle_bytes"].int)
        XCTAssertEqual(engine["version"].text, Hypertext.engineVersion)
        XCTAssertEqual(engine["limits"]["timeout_ms"].int, Int(Hypertext.engineTimeout * 1000))
        XCTAssertEqual(engine["limits"]["cold_timeout_ms"].int, Int(Hypertext.engineColdTimeout * 1000))
        let html = try String(contentsOf: page, encoding: .utf8)
        XCTAssertTrue(html.contains("default-src 'none'") && html.contains("worker-src blob:"), html)
    }

    func testTheFixtureRunsThroughThePageAndTheNativeCheck() async throws {
        let engine = HypertextEngine()
        defer { engine.release() }
        let cases = try HypertextRunCases.cases(try HypertextRunCases.fixture())
        XCTAssertGreaterThan(cases.count, 60)
        var failures: [String] = []
        for c in cases {
            let out = await engine.run(c.request)
            if let problem = HypertextRunCases.mismatch(c, Hypertext.validateOutput(c.doc, prev: c.prev, raw: out)) { failures.append(problem + " — " + out) }
        }
        XCTAssertEqual(failures, [])
        XCTAssertEqual(engine.loads, 1, "one page serves every run")
    }

    func testThePageReachesNoNetworkAndStaysOnItself() async throws {
        let engine = HypertextEngine()
        defer { engine.release() }
        let fetched = await engine.probe("try { await fetch('https://example.com/'); return 'loaded'; } catch (e) { return 'blocked'; }")
        XCTAssertEqual(fetched, "blocked")
        let image = await engine.probe("""
        return await new Promise(function (done) {
          const img = new Image();
          img.onload = function () { done('loaded'); };
          img.onerror = function () { done('blocked'); };
          setTimeout(function () { done('no answer'); }, 8000);
          img.src = 'https://example.com/favicon.ico';
        });
        """)
        XCTAssertEqual(image, "blocked")
        // A navigation the page asks for is cancelled: the engine page stays.
        for target in ["about:blank", "https://example.com/"] {
            _ = await engine.probe("location.href = '\(target)'; return 'asked';")
            try await Task.sleep(nanoseconds: 500_000_000)
            let still = await engine.probe("return location.protocol + ' ' + typeof MobileHypertext;")
            XCTAssertEqual(still, "file: object", target)
        }
        XCTAssertEqual(engine.loads, 1)
    }

    func testTheBundlesBlobWorkerCanStart() async throws {
        // The content rules let blob: through and the page's CSP has worker-src blob:, so scripts run off the page's
        // thread, where the bundle can end one that does not answer.
        let engine = HypertextEngine()
        defer { engine.release() }
        let worker = await engine.probe("""
        return await new Promise(function (done) {
          try {
            const url = URL.createObjectURL(new Blob(['postMessage(typeof WebAssembly)'], { type: 'text/javascript' }));
            const w = new Worker(url);
            w.onmessage = function (e) { done('worker ' + e.data); w.terminate(); };
            w.onerror = function () { done('error'); };
            setTimeout(function () { done('no answer'); }, 8000);
          } catch (e) { done('threw ' + e); }
        });
        """)
        XCTAssertEqual(worker, "worker object")
    }

    func testARunAfterAReleaseGetsANewPage() async throws {
        let engine = HypertextEngine()
        defer { engine.release() }
        let cases = try HypertextRunCases.cases(try HypertextRunCases.fixture())
        let c = try XCTUnwrap(cases.first { $0.name == "say an allowed roll and set state" })
        let first = await engine.run(c.request)
        XCTAssertNil(HypertextRunCases.mismatch(c, Hypertext.validateOutput(c.doc, prev: c.prev, raw: first)), first)
        engine.release()
        let again = await engine.run(c.request)
        XCTAssertNil(HypertextRunCases.mismatch(c, Hypertext.validateOutput(c.doc, prev: c.prev, raw: again)), again)
        XCTAssertEqual(engine.loads, 2)
    }
}
