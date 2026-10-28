#include "Db.h"
#include "Json.h"
#include "Log.h"
#include <filesystem>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <chrono>

namespace acerciae {

std::string pgArrayLiteral(const std::vector<std::string>& xs) {
    std::string out = "{";
    for (size_t i = 0; i < xs.size(); ++i) {
        if (i) out += ",";
        out += '"';
        for (char ch : xs[i]) {
            if (ch == '"' || ch == '\\') out += '\\';
            out += ch;
        }
        out += '"';
    }
    out += "}";
    return out;
}

Db::Db(std::string url, std::size_t poolSize) : url_(std::move(url)), poolSize_(poolSize) {}
Db::~Db() = default;

std::shared_ptr<pqxx::connection> Db::acquire() {
    if (depth() > 0) {
        static std::atomic<int> reported{0};
        if (reported++ < 20) ALOG_WARN << "nested database transaction: a thread already inside a transaction took another connection";
        static const bool strict = [] { const char* v = std::getenv("ACERCIAE_STRICT_DB"); return v && std::string(v) == "1"; }();
        if (strict) throw std::logic_error("nested database transaction");
    }
    std::unique_lock<std::mutex> lk(mu_);
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    for (;;) {
        if (!idle_.empty()) {
            auto c = idle_.back();
            idle_.pop_back();
            if (c->is_open()) return c;
            created_--;
            continue;
        }
        if (created_ < poolSize_) {
            created_++;
            lk.unlock();
            try {
                auto c = std::make_shared<pqxx::connection>(url_);
                // A runaway statement or a transaction left open cannot hold a pooled connection forever.
                { pqxx::nontransaction nt(*c); nt.exec("SET TimeZone TO 'UTC'"); nt.exec("SET statement_timeout = '120s'"); nt.exec("SET idle_in_transaction_session_timeout = '10min'"); }
                return c;
            } catch (...) {
                lk.lock();
                created_--;
                throw;
            }
        }
        if (cv_.wait_until(lk, deadline) == std::cv_status::timeout && idle_.empty() && created_ >= poolSize_)
            throw std::runtime_error("database connection pool exhausted (waited 30 s)");
    }
}

void Db::release(std::shared_ptr<pqxx::connection> c) {
    std::lock_guard<std::mutex> lk(mu_);
    if (c && c->is_open()) idle_.push_back(std::move(c));
    else created_--;
    cv_.notify_one();
}

pqxx::params Db::toPqxx(const DbParams& params) {
    pqxx::params p;
    for (const auto& v : params) {
        std::visit([&](auto&& x) {
            using T = std::decay_t<decltype(x)>;
            if constexpr (std::is_same_v<T, std::monostate>) p.append();
            else if constexpr (std::is_same_v<T, std::string>) p.append(x);
            else if constexpr (std::is_same_v<T, bool>) p.append(x);
            else p.append(x);
        }, v);
    }
    return p;
}

pqxx::result Db::exec(pqxx::work& w, const std::string& sql, const DbParams& params) {
    return w.exec_params(sql, toPqxx(params));
}

Json::Value Db::queryJson(pqxx::work& w, const std::string& sql, const DbParams& params) {
    // A data-modifying CTE is the one form that accepts SELECT and INSERT/UPDATE/DELETE ... RETURNING alike.
    std::string wrapped = "WITH t AS (" + sql + ") SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text AS j FROM t";
    auto r = w.exec_params(wrapped, toPqxx(params));
    if (r.empty()) return Json::Value(Json::arrayValue);
    // Name the query when the result cannot be parsed: an empty or malformed payload is otherwise untraceable.
    try { return json::parse(r[0][0].is_null() ? std::string("null") : r[0][0].as<std::string>()); }
    catch (const std::exception& e) { throw std::runtime_error(std::string("queryJson: ") + e.what() + " | sql: " + sql.substr(0, 240)); }
}

Json::Value Db::queryOne(pqxx::work& w, const std::string& sql, const DbParams& params) {
    auto rows = queryJson(w, sql, params);
    if (!rows.isArray() || rows.empty()) return Json::Value();
    return rows[0];
}

pqxx::result Db::exec(const std::string& sql, const DbParams& params) {
    return tx([&](pqxx::work& w) { return exec(w, sql, params); });
}
Json::Value Db::queryJson(const std::string& sql, const DbParams& params) {
    return tx([&](pqxx::work& w) { return queryJson(w, sql, params); });
}
Json::Value Db::queryOne(const std::string& sql, const DbParams& params) {
    return tx([&](pqxx::work& w) { return queryOne(w, sql, params); });
}

void Db::runMigrations(const std::string& dir) {
    namespace fs = std::filesystem;
    std::vector<fs::path> files;
    if (!fs::exists(dir)) throw std::runtime_error("migrations dir not found: " + dir);
    for (auto& e : fs::directory_iterator(dir))
        if (e.is_regular_file() && e.path().extension() == ".sql") files.push_back(e.path());
    std::sort(files.begin(), files.end());

    tx([&](pqxx::work& w) {
        w.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
        w.exec("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
        for (auto& f : files) {
            auto name = f.filename().string();
            auto r = w.exec_params("SELECT 1 FROM schema_migrations WHERE name=$1", name);
            if (!r.empty()) continue;
            std::ifstream in(f);
            std::stringstream ss; ss << in.rdbuf();
            ALOG_INFO << "applying migration " << name;
            w.exec(ss.str());
            w.exec_params("INSERT INTO schema_migrations(name) VALUES($1)", name);
        }
    });
}

} // namespace acerciae
