import Foundation
import Security
import AcerciaeCore

struct SavedLogin: Codable {
    let endpoint: String
    let session: Session
}

struct SavedAccounts: Codable {
    var accounts: [SavedLogin] = []
    var active: String?

    init() {}
    static func decode(_ data: Data) throws -> Self {
        if let roster = try? JSONDecoder().decode(Self.self, from: data) { return roster }
        var roster = Self()
        roster.remember(try JSONDecoder().decode(SavedLogin.self, from: data))
        return roster
    }
    mutating func remember(_ login: SavedLogin) {
        accounts.removeAll { $0.session.user.id == login.session.user.id }
        accounts.append(login)
        active = login.session.user.id
    }
}

struct SessionStore {
    let service: String
    init(service: String = "app.acerciae.mobile.session") { self.service = service }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "active"]
    }
    func roster() throws -> SavedAccounts {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return SavedAccounts() }
        guard status == errSecSuccess, let data = item as? Data else { throw StoreError.unavailable }
        var result = try SavedAccounts.decode(data)
        result.accounts.removeAll { !ServiceConfiguration.acceptsSavedEndpoint($0.endpoint) }
        return result
    }
    func save(_ login: SavedLogin) throws {
        var saved = try roster()
        saved.remember(login)
        try write(saved)
    }
    func select(_ id: String?) throws {
        var saved = try roster()
        guard id == nil || saved.accounts.contains(where: { $0.session.user.id == id }) else { throw StoreError.unavailable }
        saved.active = id
        try write(saved)
    }
    func remove(_ id: String) throws {
        var saved = try roster()
        saved.accounts.removeAll { $0.session.user.id == id }
        if saved.active == id { saved.active = nil }
        try write(saved)
    }
    private func write(_ saved: SavedAccounts) throws {
        if saved.accounts.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError.unavailable }
            return
        }
        let data = try JSONEncoder().encode(saved)
        let values: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw StoreError.unavailable }
        } else if status != errSecSuccess { throw StoreError.unavailable }
    }
    enum StoreError: Error { case unavailable }
}
