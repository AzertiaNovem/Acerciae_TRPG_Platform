#pragma once
#include "ObjectStore.h"
#include "../core/Db.h"
#include <atomic>
#include <string>
#include <thread>

namespace acerciae::logstudio {

// Brings stored media in line with the current storage settings. Runs once in the background whenever the backend
// starts (MEDIA_MIGRATION=false turns that off) and on demand with `acerciae-server --migrate-media`:
//   1. avatars still inline in users.avatar_data become objects in the store;
//   2. with a public bucket, media that is not secret (AI-generated art, voice clips, avatars) is copied there under a
//      "pub/" key and the rows are repointed;
//   3. every object that still sits in the local directory but belongs in object storage (OBJECT_STORE / IMAGE_STORE)
//      is uploaded there. Uploaded objects are recorded in object_migrations, so each is sent once.
// Nothing is lost along the way: rows are repointed only after the copy succeeded, local files are kept unless
// MEDIA_MIGRATION_DELETE_LOCAL=true (reads fall back to them either way), and failures are retried on the next run.
class MediaMigrator {
public:
    MediaMigrator(Db& db, RoutingObjectStore& store, bool deleteLocal) : db_(db), store_(store), deleteLocal_(deleteLocal) {}
    ~MediaMigrator() { stop(); }
    struct Report { int avatarsMoved = 0, madePublic = 0, uploaded = 0, alreadyThere = 0, missing = 0, failed = 0, localDeleted = 0; };
    Report runOnce();
    void start();   // runOnce on a background thread
    void stop();
    static std::string describe(const Report& r);
private:
    void moveInlineAvatars(Report& r);
    void makePublic(Report& r);
    void uploadLocal(Report& r);
    bool stopping() const { return stop_.load(); }
    Db& db_; RoutingObjectStore& store_; bool deleteLocal_;
    std::atomic<bool> stop_{false};
    std::thread thread_;
};

} // namespace acerciae::logstudio
