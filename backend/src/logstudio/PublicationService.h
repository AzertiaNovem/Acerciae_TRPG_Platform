#pragma once
#include "../auth/AuthService.h"
#include "../core/Db.h"
#include "ObjectStore.h"
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
  std::string bundle(const ChannelAccess &a, const std::string &presentationId, std::string &fileName);

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
};
} // namespace acerciae::logstudio
