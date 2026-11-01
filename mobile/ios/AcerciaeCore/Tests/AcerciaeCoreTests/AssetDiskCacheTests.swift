import XCTest
@testable import AcerciaeCore

final class AssetDiskCacheTests: XCTestCase {
    func testKeepsFilesAndDropsTheLeastRecentlyUsed() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let cache = AssetDiskCache(directory: dir, capBytes: 10)
        cache.put("a", Data(count: 4)); Thread.sleep(forTimeInterval: 1.1)
        cache.put("b", Data(count: 4)); Thread.sleep(forTimeInterval: 1.1)
        XCTAssertNotNil(cache.get("a")); Thread.sleep(forTimeInterval: 1.1)   // a is used again: b is now the oldest
        cache.put("c", Data(count: 4))
        XCTAssertNotNil(cache.get("a")); XCTAssertNil(cache.get("b")); XCTAssertNotNil(cache.get("c"))
        cache.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    }

    func testOnlyImmutableResponsesAreKeepable() {
        XCTAssertTrue(AssetDiskCache.keepable("private, max-age=31536000, immutable"))
        XCTAssertFalse(AssetDiskCache.keepable("private, max-age=3600"))
        XCTAssertFalse(AssetDiskCache.keepable(nil))
        XCTAssertEqual(AssetDiskCache.hex("x").count, 64)
    }
}
