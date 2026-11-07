import XCTest
@testable import AcerciaeCore

final class PbtaTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/pbta-mobile.json")))
    }
    func testNativeSheetUsesPackDefinitionsAndRejectsInvalidNumbers() throws {
        let f = try fixture(), pack = f["pack"]
        XCTAssertTrue(Pbta.validSheet(f["sheet"], pack: pack))
        var sheet = f["sheet"].object
        sheet["book"] = .string("missing"); XCTAssertFalse(Pbta.validSheet(.object(sheet),pack:pack))
        sheet = f["sheet"].object
        for bad in [JSONValue.number(10000), .number(1.5), .string("2"), .bool(true)] {
            sheet["stats"] = .object(["wit":bad]); XCTAssertFalse(Pbta.validSheet(.object(sheet),pack:pack))
        }
        sheet["stats"] = .array([]); XCTAssertFalse(Pbta.validSheet(.object(sheet),pack:pack))
        sheet["stats"] = .object(["foreign":.number(1)]); XCTAssertFalse(Pbta.validSheet(.object(sheet),pack:pack))
    }
    func testMovesRespectPlaybookAndLeaveRealDiceToTheServer() throws {
        let f = try fixture(), moves = Pbta.moves(pack:f["pack"],sheet:f["sheet"])
        XCTAssertEqual(moves.map(\.id),["search","prepare"])
        let body = try Pbta.moveBody(character:"pc",move:moves[0],modifier:-3)
        XCTAssertEqual(body["content"].text,".move search -3"); XCTAssertEqual(body["kind"].text,"ic"); XCTAssertEqual(body["visibility"].text,"window"); XCTAssertEqual(body["character_id"].text,"pc")
        XCTAssertEqual(try Pbta.moveBody(character:"pc",move:moves[1],modifier:5)["content"].text,".move prepare")
        XCTAssertThrowsError(try Pbta.moveBody(character:"pc",move:moves[0],modifier:100))
        XCTAssertThrowsError(try Pbta.moveBody(character:"pc",move:.object(["id":.string("search\n")]),modifier:0))
        var message = Message(id:"old",content:".move search",authorName:"Reader",characterName:nil,kind:"roll",seq:1)
        message.dice = .object(["type":.string("pbta_move"),"text":.string("Frozen legacy outcome"),"rolls":.array([.number(3),.number(4)])])
        XCTAssertFalse(message.hasStructuredPbtaResult); XCTAssertEqual(message.displayText,"Frozen legacy outcome")
    }
    func testWholeWindowHistoryPersistsAndIsIsolatedAndInvalidatable() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:dir) }
        let address = try BackendAddress("https://history.test")
        let disk = AssetDiskCache(directory:dir.appendingPathComponent("one"))
        let client = BackendClient(address:address,reads:disk)
        let rows = (1...150).map { Message(id:String($0),content:"Line \($0)",authorName:"Reader",characterName:nil,kind:"ic",seq:Int64($0)) }
        let history = ChatHistory(messages:rows,hasOlder:false)
        await client.keepHistory(history,channel:"c",window:"w").value
        let restored = await BackendClient(address:address,reads:AssetDiskCache(directory:dir.appendingPathComponent("one"))).cachedHistory(channel:"c",window:"w")
        XCTAssertEqual(restored,history)
        let isolated = await BackendClient(address:address,reads:AssetDiskCache(directory:dir.appendingPathComponent("two"))).cachedHistory(channel:"c",window:"w")
        XCTAssertNil(isolated)
        let late = client.keepHistory(history,channel:"c",window:"w"); disk.clear(); await late.value
        let cleared = await client.cachedHistory(channel:"c",window:"w"); XCTAssertNil(cleared)
    }
}
