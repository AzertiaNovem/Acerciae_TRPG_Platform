#pragma once
#include <json/json.h>
#include <pqxx/pqxx>
#include <string>
#include <vector>
#include <variant>
#include <memory>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <optional>
#include <cstdint>

namespace acerciae {

// A query parameter. Null is represented by std::monostate.
using DbParam = std::variant<std::monostate, std::string, int64_t, double, bool>;
using DbParams = std::vector<DbParam>;

inline DbParam dbNull() { return std::monostate{}; }
std::string pgArrayLiteral(const std::vector<std::string>& xs);   // {"a","b"} — used with ::uuid[] / ::text[]

// Small blocking connection pool around libpqxx. Handlers run on Drogon IO threads and the
// schedulers run on their own threads; every access goes through a pooled connection.
class Db {
public:
    Db(std::string url, std::size_t poolSize = 8);
    ~Db();

    // Runs fn inside a transaction. Commits on success, rolls back on exception.
    // Never start a second transaction (db_.exec/queryOne/queryJson/tx) on a thread that is inside one: it takes a
    // second pooled connection while holding the first, and enough such threads exhaust the pool. Nested use is
    // logged; acquiring waits at most 30 s and then fails instead of hanging the process.
    template <typename F>
    auto tx(F&& fn) -> decltype(fn(std::declval<pqxx::work&>())) {
        auto conn = acquire();
        struct Release { Db* db; std::shared_ptr<pqxx::connection> c; ~Release() { --depth(); db->release(c); } } rel{this, conn};
        ++depth();
        pqxx::work w(*conn);
        if constexpr (std::is_void_v<decltype(fn(w))>) {
            fn(w);
            w.commit();
        } else {
            auto r = fn(w);
            w.commit();
            return r;
        }
    }

    // Convenience: run one statement in its own transaction.
    pqxx::result exec(const std::string& sql, const DbParams& params = {});
    // Returns rows as a JSON array (each row an object). Timestamps become ISO strings, arrays become
    // JSON arrays and jsonb columns become objects — this removes most per-column conversion code.
    Json::Value queryJson(const std::string& sql, const DbParams& params = {});
    Json::Value queryOne(const std::string& sql, const DbParams& params = {}); // null if no rows

    // Same helpers inside an existing transaction.
    static pqxx::result exec(pqxx::work& w, const std::string& sql, const DbParams& params = {});
    static Json::Value queryJson(pqxx::work& w, const std::string& sql, const DbParams& params = {});
    static Json::Value queryOne(pqxx::work& w, const std::string& sql, const DbParams& params = {});

    void runMigrations(const std::string& dir);
    const std::string& url() const { return url_; }

    static int& depth() { thread_local int d = 0; return d; }   // transactions this thread holds open
private:
    std::shared_ptr<pqxx::connection> acquire();
    void release(std::shared_ptr<pqxx::connection> c);
    static pqxx::params toPqxx(const DbParams& params);

    std::string url_;
    std::size_t poolSize_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::vector<std::shared_ptr<pqxx::connection>> idle_;
    std::size_t created_ = 0;
};

} // namespace acerciae
