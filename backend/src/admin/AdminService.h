#pragma once
#include "../auth/AuthService.h"
#include "../core/Db.h"
#include <json/json.h>
#include <string>

namespace acerciae {
namespace logstudio { class ObjectStore; }

// The deployment's administration (platform administrators only: PLATFORM_ADMINS, or users.is_admin granted here):
// what the deployment holds (accounts, servers, stored media by kind, the database and its largest tables, AI use),
// where it is used (per server, per user), and the two levers against content that breaks the deployment's policies
// or abuses image storage: suspending a server (its members keep their accounts; nothing inside the server answers,
// its published logs go dark, its sockets drop) and suspending an account (every session ends; signing in names the
// reason). Both are reversible and nothing is deleted. Every action is written to admin_actions with its reason.
class AdminService {
public:
    AdminService(Db& db, AuthService& auth, logstudio::ObjectStore& store) : db_(db), auth_(auth), store_(store) {}

    Json::Value overview(const Principal& p);
    // Paged lists: {rows, total, limit, offset}. `sort` names a column of the row (created, storage, members, messages,
    // images, name; users also last_seen, servers); `q` filters by name (servers: name or owner; users: username or
    // display name).
    Json::Value servers(const Principal& p, const std::string& q, const std::string& sort, int limit, int offset);
    Json::Value users(const Principal& p, const std::string& q, const std::string& sort, int limit, int offset);
    Json::Value server(const Principal& p, const std::string& serverId);
    Json::Value user(const Principal& p, const std::string& userId);
    // {suspended: bool, reason?}: suspending needs a reason. Returns the server / user row as the lists show it.
    Json::Value suspendServer(const Principal& p, const std::string& serverId, const Json::Value& body);
    Json::Value suspendUser(const Principal& p, const std::string& userId, const Json::Value& body);
    // {admin: bool, reason?}. Administrators named in PLATFORM_ADMINS cannot be demoted, nor can the caller demote themself.
    Json::Value setAdmin(const Principal& p, const std::string& userId, const Json::Value& body);
    Json::Value actions(const Principal& p, int limit, int offset);

private:
    void record(pqxx::work& w, const Principal& p, const char* action, const char* targetType, const std::string& targetId, const std::string& targetName, const std::string& reason);
    Json::Value serverRow(const std::string& serverId);
    Json::Value userRow(const std::string& userId);
    Db& db_;
    AuthService& auth_;
    logstudio::ObjectStore& store_;
};

} // namespace acerciae
