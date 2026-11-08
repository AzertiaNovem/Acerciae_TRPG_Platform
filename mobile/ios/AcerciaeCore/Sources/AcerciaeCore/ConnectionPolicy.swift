import Foundation

public enum ConnectionPolicy {
    public static func invalidatesSession(_ error: Error) -> Bool {
        if case ClientError.http(401) = error { return true }; return false
    }
    public static func retryStatus(_ status: Int) -> Bool { [408, 502, 503, 504, 520, 522, 523, 524].contains(status) }
    public static func retryTransport(_ error: Error) -> Bool {
        guard let e = error as? URLError else { return false }
        return [.timedOut, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet].contains(e.code)
    }
    public static func message(_ error: Error) -> String {
        if let e = error as? ClientError { return e.localizedDescription }
        guard let e = error as? URLError else { return "连接失败，请重试" }
        switch e.code {
        case .notConnectedToInternet: return "网络不可用，恢复联网后会自动重连"
        case .timedOut: return "连接超时，正在等待重试"
        case .networkConnectionLost: return "网络连接中断，正在等待重试"
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed: return "暂时无法连接服务器，请检查网络或代理设置"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid: return "无法建立安全连接，请检查设备时间或网络代理"
        default: return "连接失败，请重试"
        }
    }
}
