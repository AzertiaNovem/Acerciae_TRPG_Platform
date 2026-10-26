#include "MediaService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../knowledge/Visibility.h"
#include <set>

namespace acerciae::logstudio {

static DbParam opt(const std::string& s) { return s.empty() ? dbNull() : DbParam(s); }

std::string MediaService::sniffMime(const std::string& b, const std::string& fileName) {
    auto starts = [&](const char* sig, size_t n, size_t off = 0) { return b.size() >= off + n && b.compare(off, n, sig, n) == 0; };
    if (starts("\x89PNG\r\n\x1a\n", 8)) return "image/png";
    if (starts("\xFF\xD8\xFF", 3)) return "image/jpeg";
    if (starts("GIF8", 4)) return "image/gif";
    if (starts("RIFF", 4) && starts("WEBP", 4, 8)) return "image/webp";
    if (starts("RIFF", 4) && starts("WAVE", 4, 8)) return "audio/wav";
    if (starts("ID3", 3) || (b.size() > 2 && (unsigned char)b[0] == 0xFF && ((unsigned char)b[1] & 0xE0) == 0xE0)) return "audio/mpeg";
    if (starts("OggS", 4)) return "audio/ogg";
    if (starts("fLaC", 4)) return "audio/flac";
    if (b.size() > 12 && b.compare(4, 4, "ftyp") == 0) { auto brand = b.substr(8, 4); if (brand.rfind("M4A", 0) == 0 || brand == "mp42" || brand == "isom" || brand == "iso2") return fileName.size() > 4 && text::lower(fileName.substr(fileName.size() - 4)) == ".m4a" ? "audio/mp4" : "video/mp4"; }
    if (starts("%PDF", 4)) return "application/pdf";
    // SVG only when it looks like XML and the name says so (we never serve it inline as a document)
    if (fileName.size() > 4 && text::lower(fileName.substr(fileName.size() - 4)) == ".svg" && b.find("<svg") != std::string::npos) return "image/svg+xml";
    return "application/octet-stream";
}
bool MediaService::allowedMime(const std::string& mime, const std::string& type) {
    static const std::set<std::string> img = {"image/png","image/jpeg","image/webp","image/gif"};
    static const std::set<std::string> aud = {"audio/wav","audio/mpeg","audio/ogg","audio/flac","audio/mp4"};
    if (type == "background" || type == "standee" || type == "portrait" || type == "illustration" || type == "cover") return img.count(mime) > 0;
    if (type == "audio" || type == "bgm" || type == "sfx") return aud.count(mime) > 0;
    if (type == "video") return mime == "video/mp4";
    if (type == "document") return mime == "application/pdf";
    return img.count(mime) || aud.count(mime);
}
void MediaService::probeDimensions(const std::string& b, const std::string& mime, int& w, int& h) {
    w = h = 0;
    auto be32 = [&](size_t o) { return (int)(((unsigned char)b[o] << 24) | ((unsigned char)b[o+1] << 16) | ((unsigned char)b[o+2] << 8) | (unsigned char)b[o+3]); };
    if (mime == "image/png" && b.size() >= 24) { w = be32(16); h = be32(20); }
    else if (mime == "image/gif" && b.size() >= 10) { w = (unsigned char)b[6] | ((unsigned char)b[7] << 8); h = (unsigned char)b[8] | ((unsigned char)b[9] << 8); }
    else if (mime == "image/jpeg") { size_t i = 2; while (i + 9 < b.size()) { if ((unsigned char)b[i] != 0xFF) { i++; continue; } unsigned char m = b[i+1]; if (m == 0xC0 || m == 0xC1 || m == 0xC2) { h = ((unsigned char)b[i+5] << 8) | (unsigned char)b[i+6]; w = ((unsigned char)b[i+7] << 8) | (unsigned char)b[i+8]; break; } size_t len = ((unsigned char)b[i+2] << 8) | (unsigned char)b[i+3]; i += 2 + len; } }
}

static const std::string ASSET_COLS = "id, channel_id, asset_type, source_type, name, mime, bytes, width, height, duration_ms, character_id, expression, outfit, source_reference, generation_provider, generation_model, prompt, reference_asset_ids, style_profile_id, style_profile_version, approval_status, visibility_scope, version, license_metadata, tags, created_by, created_at, updated_at";

Json::Value MediaService::list(const ChannelAccess& a, const std::string& type, const std::string& characterId, const std::string& approval) {
    std::string sql = "SELECT " + ASSET_COLS + " FROM media_assets WHERE channel_id=$1"; DbParams p{a.channelId};
    if (!a.isGm) sql += " AND visibility_scope='channel' AND approval_status='approved'";
    if (!type.empty()) { p.push_back(type); sql += " AND asset_type=$" + std::to_string(p.size()); }
    if (!characterId.empty()) { p.push_back(characterId); sql += " AND character_id=$" + std::to_string(p.size()); }
    if (!approval.empty() && a.isGm) { p.push_back(approval); sql += " AND approval_status=$" + std::to_string(p.size()); }
    sql += " ORDER BY created_at DESC LIMIT 500";
    return db_.queryJson(sql, p);
}
Json::Value MediaService::get(const ChannelAccess& a, const std::string& id) {
    auto r = db_.queryOne("SELECT " + ASSET_COLS + " FROM media_assets WHERE id=$1 AND channel_id=$2" + std::string(a.isGm ? "" : " AND visibility_scope='channel' AND approval_status='approved'"), {id, a.channelId});
    if (r.isNull()) throw notFound("asset not found");
    r["versions"] = db_.queryJson("SELECT version, mime, bytes, note, created_at FROM asset_versions WHERE asset_id=$1 ORDER BY version DESC", {id});
    return r;
}
Json::Value MediaService::upload(const ChannelAccess& a, const std::string& fileName, const std::string& bytes, const std::string& declaredType, const Json::Value& meta) {
    auto type = json::str(meta, "asset_type", "background");
    static const std::set<std::string> types = {"background","standee","portrait","illustration","cover","audio","bgm","sfx","video","document","other"};
    if (!types.count(type)) throw badRequest("invalid asset_type");
    if (bytes.empty()) throw badRequest("empty file");
    size_t limit = (type == "video" ? 200 : type == "bgm" || type == "audio" || type == "sfx" ? 50 : 20) * 1024 * 1024;
    if (bytes.size() > limit) throw badRequest("file too large for " + type);
    auto mime = sniffMime(bytes, fileName);
    (void)declaredType;   // the declared type is never trusted; content sniffing decides
    if (!allowedMime(mime, type)) throw badRequest("file content (" + mime + ") is not allowed for asset type " + type);
    int w = 0, h = 0; probeDimensions(bytes, mime, w, h);
    auto ext = fileName.find('.') != std::string::npos ? fileName.substr(fileName.rfind('.') + 1) : "bin";
    auto key = safeObjectKey(a.channelId, type, ext);
    store_.put(key, bytes, mime);
    auto charId = json::str(meta, "character_id");
    if (!charId.empty()) { auto c = db_.queryOne("SELECT id FROM characters WHERE id=$1 AND channel_id=$2", {charId, a.channelId}); if (c.isNull()) throw badRequest("character not in channel"); }
    Json::Value lic = meta.isMember("license_metadata") && meta["license_metadata"].isObject() ? meta["license_metadata"] : Json::Value(Json::objectValue);
    Json::Value srcRef; srcRef["file_name"] = fileName; srcRef["uploaded_by"] = a.userId;
    auto row = db_.queryOne("INSERT INTO media_assets(channel_id, asset_type, source_type, name, object_key, mime, bytes, width, height, character_id, expression, outfit, source_reference, approval_status, visibility_scope, license_metadata, tags, created_by) "
        "VALUES($1,$2,'upload',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'approved',$13,$14::jsonb,$15::text[],$16) RETURNING " + ASSET_COLS,
        {a.channelId, type, json::str(meta, "name", fileName), key, mime, (int64_t)bytes.size(), w ? DbParam((int64_t)w) : dbNull(), h ? DbParam((int64_t)h) : dbNull(), opt(charId), json::str(meta, "expression"), json::str(meta, "outfit"), json::dump(srcRef), a.isGm && json::toBool(meta, "gm_only") ? "gm" : "channel", json::dump(lic), pgArrayLiteral(json::strArray(meta["tags"])), a.userId});
    db_.exec("INSERT INTO asset_versions(asset_id, version, object_key, mime, bytes, note) VALUES($1,1,$2,$3,$4,'initial upload')", {row["id"].asString(), key, mime, (int64_t)bytes.size()});
    return row;
}
Json::Value MediaService::storeInternal(const std::string& channelId, const std::string& assetType, const std::string& sourceType, const std::string& bytes, const std::string& mime, const Json::Value& meta) {
    auto ext = mime == "image/png" ? "png" : mime == "image/jpeg" ? "jpg" : mime == "image/svg+xml" ? "svg" : mime == "audio/wav" ? "wav" : mime == "audio/mpeg" ? "mp3" : "bin";
    auto key = safeObjectKey(channelId, assetType, ext);
    store_.put(key, bytes, mime);
    int w = 0, h = 0; probeDimensions(bytes, mime, w, h);
    auto row = db_.queryOne("INSERT INTO media_assets(channel_id, asset_type, source_type, name, object_key, mime, bytes, width, height, character_id, expression, source_reference, generation_provider, generation_model, prompt, reference_asset_ids, style_profile_id, style_profile_version, approval_status, visibility_scope, license_metadata, created_by) "
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::uuid[],$17,$18,$19,'channel',$20::jsonb,$21) RETURNING " + ASSET_COLS,
        {channelId, assetType, sourceType, json::str(meta, "name", assetType), key, mime, (int64_t)bytes.size(), w ? DbParam((int64_t)w) : dbNull(), h ? DbParam((int64_t)h) : dbNull(), opt(json::str(meta, "character_id")), json::str(meta, "expression"),
         json::dump(meta.isMember("source_reference") ? meta["source_reference"] : Json::Value(Json::objectValue)), opt(json::str(meta, "generation_provider")), opt(json::str(meta, "generation_model")), opt(json::str(meta, "prompt")), pgArrayLiteral(json::strArray(meta["reference_asset_ids"])),
         opt(json::str(meta, "style_profile_id")), meta["style_profile_version"].isNumeric() ? DbParam((int64_t)meta["style_profile_version"].asInt()) : dbNull(), json::str(meta, "approval_status", "candidate"), json::dump(meta.isMember("license_metadata") ? meta["license_metadata"] : Json::Value(Json::objectValue)), opt(json::str(meta, "created_by"))});
    db_.exec("INSERT INTO asset_versions(asset_id, version, object_key, mime, bytes, note) VALUES($1,1,$2,$3,$4,$5)", {row["id"].asString(), key, mime, (int64_t)bytes.size(), sourceType});
    return row;
}
Json::Value MediaService::update(const ChannelAccess& a, const std::string& id, const Json::Value& body) {
    auto cur = db_.queryOne("SELECT * FROM media_assets WHERE id=$1 AND channel_id=$2", {id, a.channelId});
    if (cur.isNull()) throw notFound("asset not found");
    if (!a.isGm && cur["created_by"].asString() != a.userId) throw forbidden("not your asset");
    auto approval = json::str(body, "approval_status", cur["approval_status"].asString());
    if (approval != cur["approval_status"].asString() && !a.isGm) throw forbidden("only the GM approves assets");
    if (approval != "candidate" && approval != "approved" && approval != "rejected") throw badRequest("invalid approval_status");
    return db_.queryOne("UPDATE media_assets SET name=$3, tags=$4::text[], expression=$5, outfit=$6, character_id=$7, approval_status=$8, visibility_scope=$9, license_metadata=$10::jsonb, updated_at=now() WHERE id=$1 AND channel_id=$2 RETURNING " + ASSET_COLS,
        {id, a.channelId, json::str(body, "name", cur["name"].asString()), pgArrayLiteral(body.isMember("tags") ? json::strArray(body["tags"]) : json::strArray(cur["tags"])), json::str(body, "expression", cur["expression"].asString()), json::str(body, "outfit", cur["outfit"].asString()),
         opt(json::str(body, "character_id", cur["character_id"].isNull() ? "" : cur["character_id"].asString())), approval, a.isGm ? json::str(body, "visibility_scope", cur["visibility_scope"].asString()) : cur["visibility_scope"].asString(), json::dump(body.isMember("license_metadata") ? body["license_metadata"] : cur["license_metadata"])});
}
Json::Value MediaService::newVersion(const ChannelAccess& a, const std::string& id, const std::string& fileName, const std::string& bytes, const std::string&, const std::string& note) {
    auto cur = db_.queryOne("SELECT * FROM media_assets WHERE id=$1 AND channel_id=$2", {id, a.channelId});
    if (cur.isNull()) throw notFound("asset not found");
    if (!a.isGm && cur["created_by"].asString() != a.userId) throw forbidden("not your asset");
    auto mime = sniffMime(bytes, fileName);
    if (!allowedMime(mime, cur["asset_type"].asString())) throw badRequest("file content not allowed for this asset type");
    auto key = safeObjectKey(a.channelId, cur["asset_type"].asString(), fileName.find('.') != std::string::npos ? fileName.substr(fileName.rfind('.') + 1) : "bin");
    store_.put(key, bytes, mime);
    int w = 0, h = 0; probeDimensions(bytes, mime, w, h);
    return db_.tx([&](pqxx::work& w2) {
        auto v = Db::queryOne(w2, "UPDATE media_assets SET version=version+1, object_key=$2, mime=$3, bytes=$4, width=$5, height=$6, updated_at=now() WHERE id=$1 RETURNING " + ASSET_COLS, {id, key, mime, (int64_t)bytes.size(), w ? DbParam((int64_t)w) : dbNull(), h ? DbParam((int64_t)h) : dbNull()});
        Db::exec(w2, "INSERT INTO asset_versions(asset_id, version, object_key, mime, bytes, note) VALUES($1,$2,$3,$4,$5,$6)", {id, (int64_t)v["version"].asInt(), key, mime, (int64_t)bytes.size(), note});
        return v;
    });
}
Json::Value MediaService::remove(const ChannelAccess& a, const std::string& id) {
    auto cur = db_.queryOne("SELECT * FROM media_assets WHERE id=$1 AND channel_id=$2", {id, a.channelId});
    if (cur.isNull()) throw notFound("asset not found");
    if (!a.isGm && cur["created_by"].asString() != a.userId) throw forbidden("not your asset");
    auto used = db_.queryOne("SELECT 1 AS x FROM published_logs WHERE channel_id=$1 AND NOT revoked AND frozen_asset_versions ? $2 LIMIT 1", {a.channelId, id});
    if (!used.isNull()) throw conflict("asset is referenced by a published log; revoke the publication first");
    for (auto& v : db_.queryJson("SELECT object_key FROM asset_versions WHERE asset_id=$1", {id})) store_.remove(v["object_key"].asString());
    db_.exec("DELETE FROM media_assets WHERE id=$1", {id});
    Json::Value out; out["deleted"] = true; return out;
}
bool MediaService::fetch(const ChannelAccess& a, const std::string& id, int version, std::string& bytes, std::string& mime, std::string& fileName) {
    auto cur = db_.queryOne("SELECT * FROM media_assets WHERE id=$1 AND channel_id=$2", {id, a.channelId});
    if (cur.isNull()) return false;
    if (!a.isGm && cur["visibility_scope"].asString() == "gm") return false;
    std::string key = cur["object_key"].asString(); mime = cur["mime"].asString();
    if (version > 0 && version != cur["version"].asInt()) { auto v = db_.queryOne("SELECT object_key, mime FROM asset_versions WHERE asset_id=$1 AND version=$2", {id, (int64_t)version}); if (v.isNull()) return false; key = v["object_key"].asString(); mime = v["mime"].asString(); }
    auto data = store_.get(key); if (!data) return false;
    bytes = std::move(*data); fileName = cur["name"].asString(); return true;
}

} // namespace
