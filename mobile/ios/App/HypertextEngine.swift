import Foundation
import WebKit
import AcerciaeCore

/// The card engine host (mobile/contracts/INTEGRATION.md "iOS sandbox"): a hidden WKWebView that runs the committed
/// bundle (mobile/contracts/hypertext, an app folder resource) for the `on` handlers of interactive messages. It has
/// no bridge: no script message handlers, a data store that keeps nothing, a content rule list that blocks every load
/// but the bundle's own files and the blob: worker it starts from its own source (Hypertext.EngineHost.contentRules),
/// read access to the bundle's folder only, and a navigation delegate that lets only the first load of the page
/// through. Runs go one at a time through callAsyncJavaScript. Whatever the page answers is checked again natively
/// (HypertextStore, with Hypertext.validateOutput) before anything is shown or sent. The view is made for the first run
/// and dropped after 2 minutes without one, in the background, on a reset, when its process ends, and when a run does
/// not answer in time (the next run makes a new one).
@MainActor final class HypertextEngine: NSObject, WKNavigationDelegate {
    /// The packaged page; nil in a build without it, and then controls with `on` stay disabled.
    static var page: URL? { Bundle.main.url(forResource: Hypertext.EngineHost.page, withExtension: "html", subdirectory: Hypertext.EngineHost.folder) }
    static var available: Bool { page != nil }
    /// Compiled once per app session.
    private static var rules: WKContentRuleList?

    private enum Answer: Sendable { case text(String), failed, timedOut }
    private var web: WKWebView?
    /// The page's one allowed navigation has been let through.
    private var navigated = false
    /// The page has loaded and the bundle said it is ready.
    private var loaded = false
    /// The bundle's worker has answered since the page loaded: its own mark is 1 s, not 5 s.
    private var warm = false
    private var loading: Once<Bool>?
    private var calling: Once<Answer>?
    private var queue: Task<Void, Never>?
    private var idle: Task<Void, Never>?
    /// Bumped by `release`: runs queued before it are not started.
    private var epoch = 0
    /// Pages loaded so far (tests read it).
    private(set) var loads = 0

    /// Runs one request (`Hypertext.engineRequest`) and answers the page's result JSON, or a failure the host makes
    /// itself (`engine` when the page cannot start or stops, `timeout` when it does not answer in time).
    func run(_ request: String) async -> String { await enqueue(Hypertext.EngineHost.runScript, request, timeout: nil) }
    /// For tests: a function body run on the engine page the way a run is, within `timeout` seconds. It must return a
    /// string.
    func probe(_ functionBody: String, timeout: Double = 10) async -> String { await enqueue(functionBody, nil, timeout: timeout) }
    /// Drops the view and every run waiting for it (sign-in or out, a channel switch, the app going to the background).
    func release() { epoch += 1; discard() }

    // One run at a time, so that each timeout counts its own run only.
    private func enqueue(_ body: String, _ request: String?, timeout: Double?) async -> String {
        let previous = queue, started = epoch
        let job: Task<String, Never> = Task { [weak self] in
            _ = await previous?.value
            guard let self, self.epoch == started else { return Hypertext.failureText(.engine, "the engine was stopped") }
            return await self.perform(body, request, timeout: timeout)
        }
        queue = Task { _ = await job.value }
        return await job.value
    }
    private func perform(_ body: String, _ request: String?, timeout: Double?) async -> String {
        idle?.cancel(); idle = nil
        defer { scheduleIdle() }
        guard let view = await ready() else { discard(); return Hypertext.failureText(.engine, "the engine could not start") }
        let arguments: [String: Any] = request.map { [Hypertext.EngineHost.runArgument: $0] } ?? [:]
        switch await call(view, body, arguments, timeout: timeout ?? Hypertext.EngineHost.runTimeout(warm: warm)) {
        case .text(let out):
            // After its own timeout, or when its worker stopped, the bundle starts a new worker: the next run is cold again.
            if request != nil { warm = !Hypertext.EngineHost.restartsWorker(out) }
            return out
        case .failed:
            discard()
            return Hypertext.failureText(.engine, "the engine stopped")
        case .timedOut:
            discard()
            return Hypertext.failureText(.timeout, "the script did not finish in time")
        }
    }

    /// The view with its page loaded and the bundle ready, made when there is none; nil when that fails or takes too long.
    private func ready() async -> WKWebView? {
        if let web, loaded { return web }
        discard()
        let started = epoch
        guard let page = Self.page, let rules = await Self.compiledRules(), epoch == started else { return nil }
        let view = makeView(rules)
        web = view; loads += 1
        // One deadline for loading the page and for the bundle to be ready.
        let deadline = Date().addingTimeInterval(Hypertext.EngineHost.loadTimeout)
        let limit = Self.nanoseconds(Hypertext.EngineHost.loadTimeout)
        let finished: Bool = await withCheckedContinuation { done in
            let once = Once(done)
            self.loading = once
            Task { try? await Task.sleep(nanoseconds: limit); once.finish(false) }
            view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
        loading = nil
        guard finished, web === view else { return nil }
        guard case .text(let version) = await call(view, Hypertext.EngineHost.readyScript, [:], timeout: max(1, deadline.timeIntervalSinceNow)),
              !version.isEmpty, web === view else { return nil }
        loaded = true
        return view
    }
    private func makeView(_ rules: WKContentRuleList) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(rules)
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        return view
    }
    private static func compiledRules() async -> WKContentRuleList? {
        if let rules { return rules }
        let list: WKContentRuleList? = await withCheckedContinuation { done in
            WKContentRuleListStore.default().compileContentRuleList(forIdentifier: Hypertext.EngineHost.ruleListIdentifier,
                                                                    encodedContentRuleList: Hypertext.EngineHost.contentRules) { list, _ in
                done.resume(returning: list)
            }
        }
        if let list { rules = list }
        return list
    }

    // A function body on the page. The first of its answer, the timer and a teardown wins; a late answer is dropped.
    private func call(_ view: WKWebView, _ body: String, _ arguments: [String: Any], timeout: Double) async -> Answer {
        let limit = Self.nanoseconds(timeout)
        let answer: Answer = await withCheckedContinuation { done in
            let once = Once(done)
            self.calling = once
            let timer = Task { try? await Task.sleep(nanoseconds: limit); once.finish(.timedOut) }
            view.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
                timer.cancel()
                if case .success(let value) = result, let text = value as? String { once.finish(.text(text)) } else { once.finish(.failed) }
            }
        }
        calling = nil
        return answer
    }

    private func discard() {
        loading?.finish(false); loading = nil
        calling?.finish(.failed); calling = nil
        idle?.cancel(); idle = nil
        if let web { web.navigationDelegate = nil; web.stopLoading() }
        web = nil; navigated = false; loaded = false; warm = false
    }
    private func scheduleIdle() {
        idle?.cancel(); idle = nil
        guard web != nil else { return }
        let limit = Self.nanoseconds(Hypertext.EngineHost.idle)
        idle = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: limit) } catch { return }
            self?.discard()
        }
    }
    private static func nanoseconds(_ seconds: Double) -> UInt64 { UInt64(seconds * 1_000_000_000) }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The engine page itself, once, in the main frame; no reload, link, redirect, frame or form ever loads after it.
        let target = navigationAction.request.url
        let first = webView === web && !navigated && navigationAction.targetFrame?.isMainFrame == true && target?.isFileURL == true
            && target?.standardizedFileURL.path == Self.page?.standardizedFileURL.path
        if first { navigated = true }
        decisionHandler(first ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { if webView === web { loading?.finish(true) } }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if webView === web { loading?.finish(false) } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if webView === web { loading?.finish(false) } }
    // The page's process ended (a crash, or memory pressure): the runs on it fail and the next one makes a new view.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if webView === web { discard() } }
}

/// Resumes its continuation once: whichever of an answer, a timer and a teardown comes first.
private final class Once<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?
    init(_ continuation: CheckedContinuation<T, Never>) { self.continuation = continuation }
    func finish(_ value: T) {
        lock.lock(); let c = continuation; continuation = nil; lock.unlock()
        c?.resume(returning: value)
    }
}
