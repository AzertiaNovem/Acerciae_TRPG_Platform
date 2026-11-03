import XCTest
@testable import AcerciaeCore
final class LocalStudioStoreTests: XCTestCase {
    func testProjectAndAssetsSurviveRestartAndCacheClear() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let store=LocalStudioStore(root:root.appendingPathComponent("projects")); let id=UUID().uuidString
        let project:JSONValue = .object(["id":.string(id),"title":.string("Night"),"events":.array([]),"characters":.array([])])
        try await store.save(project)
        try await store.addAssets(id,.object(["assets/test.jpg":.string("data:image/jpeg;base64,YQ==")]))
        AssetDiskCache(directory:root.appendingPathComponent("cache")).clear()
        let restarted=LocalStudioStore(root:root.appendingPathComponent("projects"))
        let restored=try await restarted.load(id); let assets=try await restarted.assets(id); let list=try await restarted.list()
        XCTAssertEqual(restored,project); XCTAssertEqual(list.count,1); XCTAssertEqual(assets["assets/test.jpg"].text,"data:image/jpeg;base64,YQ==")
        do { try await store.addAssets(id,.object(["../../escape.jpg":.string("data:image/jpeg;base64,YQ==")])); XCTFail() } catch {}
        do { _ = try await store.load("../escape"); XCTFail() } catch {}
        let large = "data:image/jpeg;base64," + Data(repeating:0,count:7 * 1024 * 1024).base64EncodedString()
        let smaller = "data:image/jpeg;base64," + Data(repeating:0,count:13 * 512 * 1024).base64EncodedString()
        do { try await store.addAssets(id,.object(["assets/a.jpg":.string(large),"assets/b.jpg":.string(large),"assets/c.jpg":.string(smaller)])); XCTFail("Oversized image collections must not poison existing projects") } catch {}
        let unchanged = try await store.assets(id); XCTAssertEqual(unchanged.object.count,1)
        try await store.removeUnusedAsset(id,"assets/test.jpg",project:.object(["portrait":.string("assets/test.jpg")]))
        let retained = try await store.assets(id); XCTAssertEqual(retained.object.count,1)
        try await store.removeUnusedAsset(id,"assets/test.jpg",project:project)
        let removed = try await store.assets(id); XCTAssertTrue(removed.object.isEmpty)
        try await store.delete(id); let empty=try await store.list(); XCTAssertTrue(empty.isEmpty)
    }
}
