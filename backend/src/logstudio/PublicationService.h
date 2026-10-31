#pragma once
#include "../auth/AuthService.h"
#include "../core/Db.h"
#include "ObjectStore.h"
#include <functional>
namespace acerciae {
class Notifier;
class DocumentService;
} // namespace acerciae
namespace acerciae::logstudio {
class LogStudioService;
class PresentationService;
class MediaService;
class PublicationService {
public:
  PublicationService(Db &db, ObjectStore &store, Notifier &n,
                     LogStudioService &logs, PresentationService &pres,
                     MediaService &media, DocumentService &docs)
      : db_(db), store_(store), notifier_(n), logs_(logs), pres_(pres),
        media_(media), documents_(docs) {}
  static Json::Value validateConfig(const Json::Value &config);
  Json::Value templates(const ChannelAccess &a);
  Json::Value saveTemplate(const ChannelAccess &a, const Json::Value &body);
  Json::Value createPdf(const ChannelAccess &a, const std::string &snapshot,
                        const Json::Value &body);
  Json::Value pdfJobs(const ChannelAccess &a);
  Json::Value pdfJob(const ChannelAccess &a, const std::string &id);
  std::string pdfBytes(const ChannelAccess &a, const std::string &id);
  Json::Value claimPdf();
  Json::Value finishPdf(const std::string &id, const std::string &lease,
                        const std::string &bytes, const std::string &error);
  Json::Value publish(const ChannelAccess &a, const Json::Value &body);
  Json::Value publications(const ChannelAccess &a);
  Json::Value publication(const ChannelAccess &a, const std::string &id);
  Json::Value shared(const std::string &token);
  Json::Value revoke(const ChannelAccess &a, const std::string &id);
  std::string publicationFile(const ChannelAccess &a,
                              const std::string &publication,
                              const std::string &asset, std::string &mime);
  std::string sharedFile(const std::string &token, const std::string &asset,
                         std::string &mime);
  // A zip with a standalone HTML player, the backgrounds and standees it shows and the voice lines it plays.
  // `progress(done, total)` follows the lines as their images and voices are gathered.
  std::string bundle(const ChannelAccess &a, const std::string &presentationId, std::string &fileName,
                     const std::function<void(int, int)> &progress = nullptr);

  // Background bundles: built off the request on the background pool, stored for VN_BUNDLE_TTL_HOURS (default 24)
  // and deleted when they expire. Every bundle goes to the public R2 bucket when one is configured, under an
  // unguessable key, so the download comes straight from Cloudflare; without one it stays in private storage and is
  // streamed through the permission-checked route. Each bundle is the requester's own view.
  void setExecutor(std::function<bool(std::function<void()>)> f) { executor_ = std::move(f); }
  void setAccessResolver(std::function<ChannelAccess(const std::string &userId, const std::string &channelId)> f) { accessFor_ = std::move(f); }
  // body {force?}: reuses the requester's ready, unexpired bundle unless the presentation changed since, or force.
  Json::Value requestBundle(const ChannelAccess &a, const std::string &presentationId, const Json::Value &body);
  Json::Value bundleJobs(const ChannelAccess &a, const std::string &presentationId);   // the requester's, newest first
  // A ready bundle of the requester: its public URL, or (private storage, or a header-authenticated client) its bytes.
  bool bundleDownload(const ChannelAccess &a, const std::string &jobId, bool preferUrl, std::string &url, std::string &bytes, std::string &fileName);
  // Maintenance: deletes expired bundles from every storage backend, fails jobs a restart interrupted, forgets old
  // rows. Returns how many bundles were deleted.
  int expireBundles();
  // Deletes a visual novel (its scenes, lines, staging and prepared downloads). What it generated stays in the
  // channel for reuse: backgrounds and character images in the asset library, voice lines in the speech cache.
  Json::Value deletePresentation(const ChannelAccess &a, const std::string &presentationId);
  static int bundleTtlHours();

private:
  std::string frozenFile(const Json::Value &row, const std::string &id,
                         std::string &mime);
  void snapshotAccess(const ChannelAccess &a, const std::string &id);
  Json::Value image(const ChannelAccess &a, const std::string &id,
                    bool publicOnly);
  Json::Value publicRow(Json::Value row);
  Db &db_;
  ObjectStore &store_;
  Notifier &notifier_;
  LogStudioService &logs_;
  PresentationService &pres_;
  MediaService &media_;
  DocumentService &documents_;
  std::function<bool(std::function<void()>)> executor_;
  std::function<ChannelAccess(const std::string &, const std::string &)> accessFor_;
  void runBundle(const std::string &jobId);
  Json::Value bundleRow(Json::Value row);
};
} // namespace acerciae::logstudio
