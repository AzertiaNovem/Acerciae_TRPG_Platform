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

    func testKeysByContentHashAndDropsWhatWasNotUsedForThirtyDays() {
        let h = String(repeating: "a", count: 64)
        XCTAssertEqual(AssetDiskCache.key(hash: h, url: "http://x/"), "sha:" + h)
        XCTAssertEqual(AssetDiskCache.key(hash: "", url: "http://x/"), "http://x/")
        XCTAssertEqual(AssetDiskCache.key(hash: nil, url: "http://x/"), "http://x/")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var now = Date(timeIntervalSince1970: 1_000_000_000)
        let day: TimeInterval = 24 * 60 * 60
        let cache = AssetDiskCache(directory: dir, maxAge: 30 * day, now: { now })
        cache.put("a", Data(count: 4)); cache.put("b", Data(count: 4))
        now = now.addingTimeInterval(20 * day)
        XCTAssertNotNil(cache.get("a"), "used on day 20: a's lifespan starts over")
        now = now.addingTimeInterval(15 * day)
        XCTAssertNotNil(cache.get("a"), "a: 15 days since its last use")
        XCTAssertNil(cache.get("b"), "b: 35 days without a use")
        now = now.addingTimeInterval(31 * day)
        XCTAssertNil(cache.get("a"))
        XCTAssertEqual((try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.count ?? 0, 0)
    }
}
