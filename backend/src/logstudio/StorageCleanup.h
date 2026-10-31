#pragma once
#include "ObjectStore.h"
#include "../core/Db.h"
#include <atomic>
#include <string>
#include <thread>

namespace acerciae::logstudio {
class MediaService;

// Deletes stored media nothing uses any more, from the database and from every storage backend (local disk, R2/S3,
// the public bucket). Runs in the background at every start and then once a day (STORAGE_CLEANUP=false turns that
// off), and on demand with `acerciae-server --clean-storage` (add --dry-run to only count):
//   1. character images that are not their character's current image: an older avatar, portrait or pose of the same
//      character and subtitle, a library standee another one of the same subtitle replaced, rejected images;
//   2. old versions of an approved asset, unless a visual-novel scene or a live publication pins that version;
//   3. images replaced while a publication showed them, once no live publication does;
//   4. stored objects no database row names (left behind by earlier versions, failed jobs, deleted drafts, the media
//      migrator's copies under their old keys). Local copies of objects uploaded to R2/S3 are the media migrator's
//      business (MEDIA_MIGRATION_DELETE_LOCAL).
// Nothing younger than a day is touched, nor anything a live publication, a scene, a character or a style still uses.
class StorageCleanup {
public:
    StorageCleanup(Db& db, RoutingObjectStore& store, MediaService& media) : db_(db), store_(store), media_(media) {}
    ~StorageCleanup() { stop(); }
    struct Report { int characterImages = 0, oldVersions = 0, superseded = 0, orphans = 0, failed = 0; long long bytes = 0; };
    Report runOnce(bool dryRun = false);
    void start();   // runOnce now and every 24 hours, on a background thread
    void stop();
    static std::string describe(const Report& r, bool dryRun = false);
private:
    void characterImages(Report& r, bool dryRun);
    void oldVersions(Report& r, bool dryRun);
    void orphans(Report& r, bool dryRun);
    void removeObject(const std::string& key);   // the key and its "pub/" twin, everywhere
    bool stopping() const { return stop_.load(); }
    Db& db_; RoutingObjectStore& store_; MediaService& media_;
    std::atomic<bool> stop_{false};
    std::thread thread_;
};

} // namespace acerciae::logstudio
