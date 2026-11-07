import XCTest
import SwiftUI
import AcerciaeCore
@testable import Acerciae

@MainActor final class PbtaNativeTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        var root=URL(fileURLWithPath:#filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:root.appendingPathComponent("mobile/contracts/fixtures/pbta-mobile.json")))
    }
    private func model(_ f: JSONValue) throws -> AppModel {
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[PbtaNativeProtocol.self]
        PbtaNativeProtocol.reset(try JSONEncoder().encode(f),try JSONEncoder().encode(JSONValue.object(["status":.string("pending"),"version":.number(2),"revision":.number(4),"base_revision":.number(4),"pack":f["pack"]])))
        let client=BackendClient(address:try BackendAddress("https://native-pbta.test"),session:URLSession(configuration:config))
        let session=try APIJSON.decoder().decode(Session.self,from:Data(#"{"token":"fixture","user":{"id":"reader","username":"reader","display_name":"Reader"}}"#.utf8))
        let model=AppModel(client:client,session:session)
        model.channelId="channel";model.windowId="window"
        model.channel = .object(["id":.string("channel"),"name":.string("Night Watch"),"rule_system":.string("pbta"),"my_role":.string("gm")])
        model.windows=try APIJSON.decoder().decode([Resource].self,from:Data(#"[{"id":"window","name":"Main","kind":"main","members":[]}]"#.utf8))
        return model
    }
    private func host<V:View>(_ view: V) throws -> UIWindow {
        let scene=try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap{$0 as? UIWindowScene}.first)
        let window=UIWindow(windowScene:scene);window.overrideUserInterfaceStyle = .dark
        window.rootViewController=UIHostingController(rootView:NavigationStack{view}.environment(\.scenePhase,.active));window.makeKeyAndVisible()
        return window
    }
    private func capture(_ window:UIWindow,_ name:String) {
        let image=UIGraphicsImageRenderer(bounds:window.bounds).image{_ in window.drawHierarchy(in:window.bounds,afterScreenUpdates:true)}
        let attachment=XCTAttachment(image:image);attachment.name=name;attachment.lifetime = .keepAlways;add(attachment)
    }
    func testPlaybookAndFrozenOutcomeRenderWithoutRequestingOrRolling() async throws {
        let f=try fixture(),model=try model(f)
        let window=try host(PbtaSheetFixture(model:model,rules:f,card:["pbta":f["sheet"]]))
        defer{window.isHidden=true;model.foreground=false}
        try await Task.sleep(for:.milliseconds(180))
        XCTAssertEqual(PbtaNativeProtocol.requests.count,0)
        capture(window,"Native PbtA playbook")
        let message=try APIJSON.decoder().decode(Message.self,from:Data(#"{"id":"roll","content":".move search","author_name":"Reader","kind":"roll","seq":1,"dice":{"type":"pbta_move","name":"Read the scene","trigger":"When you search a dangerous place","rolls":[3,3],"stat_value":2,"modifier":0,"total":8,"band":{"name":"Success at a cost"},"outcome":"Choose a cost.","player_choice":true,"text":"Frozen outcome"}}"#.utf8))
        window.rootViewController=UIHostingController(rootView:DiceResultView(message:message).padding(20))
        try await Task.sleep(for:.milliseconds(100))
        capture(window,"Native PbtA move result")
        XCTAssertEqual(PbtaNativeProtocol.requests.count,0)
    }
    func testDraftReviewLoadsOnlyForChannelGmAndNotForServerAdministrator() async throws {
        let f=try fixture(),model=try model(f)
        let window=try host(PbtaRulesView(model:model))
        defer{window.isHidden=true;model.foreground=false}
        let deadline=Date().addingTimeInterval(3)
        while PbtaNativeProtocol.requests.count<2 && Date()<deadline { try await Task.sleep(for:.milliseconds(10)) }
        try await Task.sleep(for:.milliseconds(100))
        XCTAssertEqual(PbtaNativeProtocol.requests.count,2)
        XCTAssertTrue(PbtaNativeProtocol.requests.allSatisfy{$0.httpMethod=="GET" && $0.url?.query==nil})
        capture(window,"Native PbtA draft review")
        model.channel = .object(["id":.string("channel"),"rule_system":.string("pbta"),"my_role":.string("player")])
        model.serverSettings = .object(["is_maintainer":.bool(true)])
        try await Task.sleep(for:.milliseconds(100))
        XCTAssertFalse(model.gm);XCTAssertEqual(PbtaNativeProtocol.requests.count,2)
    }
}
private struct PbtaSheetFixture: View {
    @ObservedObject var model:AppModel
    let rules:JSONValue
    @State var card:[String:JSONValue]
    var body:some View{Form{PbtaSheetEditor(model:model,card:$card,rules:rules,characterId:"pc",editable:true,dirty:false)}}
}
private final class PbtaNativeProtocol:URLProtocol,@unchecked Sendable {
    private static let lock=NSLock()
    private static var sent:[URLRequest]=[]
    private static var rules=Data(),draft=Data()
    static var requests:[URLRequest]{lock.lock();defer{lock.unlock()};return sent}
    static func reset(_ saved:Data,_ review:Data){lock.lock();sent=[];rules=saved;draft=review;lock.unlock()}
    override class func canInit(with request:URLRequest)->Bool{request.url?.host=="native-pbta.test"}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){
        Self.lock.lock();Self.sent.append(request);let data=request.url?.lastPathComponent=="draft" ? Self.draft : Self.rules;Self.lock.unlock()
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading(){}
}
