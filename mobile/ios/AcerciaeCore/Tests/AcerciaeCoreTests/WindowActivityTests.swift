import XCTest
@testable import AcerciaeCore
final class WindowActivityTests: XCTestCase {
    private func json(_ text:String) throws -> JSONValue { try APIJSON.decoder().decode(JSONValue.self,from:Data(text.utf8)) }
    func testNoticesOnlyForNewMessagesInJoinedUnviewedWindows() throws {
        let old=try json(#"{"id":"w","last_seq":8}"#)
        let joined=try json(#"{"id":"w","kind":"private","last_seq":9,"unread":1,"members":[{"user_id":"me"}]}"#)
        XCTAssertTrue(WindowActivity.shouldNotify(previous:old,current:joined,user:"me",viewing:"other"))
        XCTAssertFalse(WindowActivity.shouldNotify(previous:.null,current:joined,user:"me",viewing:"other"))
        XCTAssertFalse(WindowActivity.shouldNotify(previous:old,current:joined,user:"me",viewing:"w"))
        XCTAssertFalse(WindowActivity.shouldNotify(previous:old,current:joined,user:"gm-not-a-member",viewing:"other"))
        XCTAssertFalse(WindowActivity.shouldNotify(previous:joined,current:joined,user:"me",viewing:"other"))
        let own=try json(#"{"id":"w","kind":"main","last_seq":10,"unread":0}"#)
        XCTAssertFalse(WindowActivity.shouldNotify(previous:old,current:own,user:"me",viewing:"other"))
        let main=try json(#"{"id":"w","kind":"main","last_seq":10,"unread":1}"#)
        XCTAssertTrue(WindowActivity.shouldNotify(previous:old,current:main,user:"me",viewing:"other"))
    }
    func testPbtaMoveShowsItsFrozenOutcome() throws {
        let m = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"m","content":".move search","author_name":"Scout","kind":"roll","seq":1,"dice":{"type":"pbta_move","rolls":[3,4],"text":"有所取舍 · 选择一项代价"}} "#.utf8))
        XCTAssertEqual(m.displayText, "有所取舍 · 选择一项代价")
        XCTAssertEqual(m.diceTone, .neutral)
    }
    func testDndIntegerRollsAndCriticalFlagAndOocSpeaker() throws {
        let m=try APIJSON.decoder().decode(Message.self,from:Data(#"{"id":"m","content":".rc attack","kind":"ooc","seq":2,"author_name":"Player","character_name":"Character","dice":{"type":"d20","rolls":[3,20],"critical":true,"success":true,"text":"Attack 20: critical"}}"#.utf8))
        XCTAssertEqual(m.diceTone,.critical); XCTAssertEqual(m.displayText,"Attack 20: critical")
        XCTAssertEqual(WindowActivity.speaker(m),"Player")
    }
}
