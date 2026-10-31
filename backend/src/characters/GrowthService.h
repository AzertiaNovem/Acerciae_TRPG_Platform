#pragma once
#include "../core/Db.h"
#include <json/json.h>
#include <string>

namespace acerciae {
class ChatService; class DiceService; class Notifier;

// COC7 investigator development, run automatically when a scenario closes (the Keeper opens the next one, enters a
// prepared one or closes the current one): every skill a player character succeeded with in the scenario (a .ra/.rc
// check at Regular or better) is marked for improvement and checked as the rulebook says — D100 above the skill or
// above 95 improves it by 1D10, Cthulhu Mythos and Credit Rating are never checked, and a skill reaching 90 grants
// 2D6 SAN. The results land in the sheet and the role card, and a system tip in the Main Chat shows them.
class GrowthService {
public:
    GrowthService(Db& db, ChatService& chat, DiceService& dice, Notifier& notifier) : db_(db), chat_(chat), dice_(dice), notifier_(notifier) {}
    // Never throws: a growth problem must not undo the scenario change that triggered it.
    void runForClosedScene(const std::string& channelId, const std::string& sceneId, const std::string& actorUserId);
private:
    Db& db_; ChatService& chat_; DiceService& dice_; Notifier& notifier_;
};

} // namespace acerciae
