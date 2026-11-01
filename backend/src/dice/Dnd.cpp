#include "Dnd.h"
#include "../core/Text.h"
#include <algorithm>
#include <cmath>
#include <map>
#include <regex>

namespace acerciae::dice::dnd {

namespace {
// ---- names ---------------------------------------------------------------------------------------------
// Languages of the name table, in this order in every row: en, zh-CN, zh-TW, ja, ko, es, fr, de, ru, pt, it.
const std::vector<std::string> kLangs = {"en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "ru", "pt", "it"};
struct NameRow { std::string key; std::vector<std::string> names; std::vector<std::string> aliases; };

const std::vector<NameRow>& abilityRows() {
    static const std::vector<NameRow> rows = {
        {"STR", {"Strength", "力量", "力量", "筋力", "근력", "Fuerza", "Force", "Stärke", "Сила", "Força", "Forza"}, {"str"}},
        {"DEX", {"Dexterity", "敏捷", "敏捷", "敏捷力", "민첩", "Destreza", "Dextérité", "Geschicklichkeit", "Ловкость", "Destreza", "Destrezza"}, {"dex", "dext"}},
        {"CON", {"Constitution", "体质", "體質", "耐久力", "건강", "Constitución", "Constitution", "Konstitution", "Телосложение", "Constituição", "Costituzione"}, {"con"}},
        {"INT", {"Intelligence", "智力", "智力", "知力", "지능", "Inteligencia", "Intelligence", "Intelligenz", "Интеллект", "Inteligência", "Intelligenza"}, {"int"}},
        {"WIS", {"Wisdom", "感知", "感知", "判断力", "지혜", "Sabiduría", "Sagesse", "Weisheit", "Мудрость", "Sabedoria", "Saggezza"}, {"wis"}},
        {"CHA", {"Charisma", "魅力", "魅力", "魅力", "매력", "Carisma", "Charisme", "Charisma", "Харизма", "Carisma", "Carisma"}, {"cha"}},
    };
    return rows;
}
// The 18 skills of the SRD 5.2, each with its ability.
const std::vector<std::pair<NameRow, std::string>>& skillRows() {
    static const std::vector<std::pair<NameRow, std::string>> rows = {
        {{"Acrobatics", {"Acrobatics", "特技", "特技", "軽業", "곡예", "Acrobacias", "Acrobaties", "Akrobatik", "Акробатика", "Acrobacia", "Acrobazia"}, {}}, "DEX"},
        {{"Animal Handling", {"Animal Handling", "驯兽", "馴獸", "動物使い", "동물 조련", "Trato con Animales", "Dressage", "Mit Tieren umgehen", "Уход за животными", "Adestrar Animais", "Addestrare Animali"}, {"驯养动物", "驯服动物"}}, "WIS"},
        {{"Arcana", {"Arcana", "奥秘", "奧秘", "魔法学", "비전학", "Arcanos", "Arcanes", "Arkane Kunde", "Магия", "Arcanismo", "Arcano"}, {"奥术"}}, "INT"},
        {{"Athletics", {"Athletics", "运动", "運動", "運動", "운동", "Atletismo", "Athlétisme", "Athletik", "Атлетика", "Atletismo", "Atletica"}, {}}, "STR"},
        {{"Deception", {"Deception", "欺瞒", "欺瞞", "ペテン", "기만", "Engaño", "Tromperie", "Täuschen", "Обман", "Enganação", "Inganno"}, {"欺骗"}}, "CHA"},
        {{"History", {"History", "历史", "歷史", "歴史", "역사", "Historia", "Histoire", "Geschichte", "История", "História", "Storia"}, {}}, "INT"},
        {{"Insight", {"Insight", "洞悉", "洞悉", "看破", "통찰", "Perspicacia", "Perspicacité", "Motiv erkennen", "Проницательность", "Intuição", "Intuizione"}, {"洞察"}}, "WIS"},
        {{"Intimidation", {"Intimidation", "威吓", "威嚇", "威圧", "위협", "Intimidación", "Intimidation", "Einschüchtern", "Запугивание", "Intimidação", "Intimidire"}, {"恐吓"}}, "CHA"},
        {{"Investigation", {"Investigation", "调查", "調查", "捜査", "수사", "Investigación", "Investigation", "Nachforschungen", "Анализ", "Investigação", "Indagare"}, {}}, "INT"},
        {{"Medicine", {"Medicine", "医药", "醫藥", "医術", "의학", "Medicina", "Médecine", "Heilkunde", "Медицина", "Medicina", "Medicina"}, {"医疗", "医术"}}, "WIS"},
        {{"Nature", {"Nature", "自然", "自然", "自然", "자연", "Naturaleza", "Nature", "Naturkunde", "Природа", "Natureza", "Natura"}, {}}, "INT"},
        {{"Perception", {"Perception", "察觉", "察覺", "知覚", "감지", "Percepción", "Perception", "Wahrnehmung", "Внимательность", "Percepção", "Percezione"}, {"感官"}}, "WIS"},
        {{"Performance", {"Performance", "表演", "表演", "芸能", "공연", "Interpretación", "Représentation", "Auftreten", "Выступление", "Atuação", "Intrattenere"}, {}}, "CHA"},
        {{"Persuasion", {"Persuasion", "游说", "遊說", "説得", "설득", "Persuasión", "Persuasion", "Überzeugen", "Убеждение", "Persuasão", "Persuasione"}, {"说服"}}, "CHA"},
        {{"Religion", {"Religion", "宗教", "宗教", "宗教", "종교", "Religión", "Religion", "Religion", "Религия", "Religião", "Religione"}, {}}, "INT"},
        {{"Sleight of Hand", {"Sleight of Hand", "巧手", "巧手", "手先の早業", "손속임", "Juego de Manos", "Escamotage", "Fingerfertigkeit", "Ловкость рук", "Prestidigitação", "Rapidità di Mano"}, {"妙手"}}, "DEX"},
        {{"Stealth", {"Stealth", "隐匿", "隱匿", "隠密", "은신", "Sigilo", "Discrétion", "Heimlichkeit", "Скрытность", "Furtividade", "Furtività"}, {"潜行"}}, "DEX"},
        {{"Survival", {"Survival", "求生", "求生", "生存", "생존", "Supervivencia", "Survie", "Überlebenskunst", "Выживание", "Sobrevivência", "Sopravvivenza"}, {"生存"}}, "WIS"},
    };
    return rows;
}
// Sheet values dice read and write.
const std::vector<NameRow>& valueRows() {
    static const std::vector<NameRow> rows = {
        {"Level", {"Level", "等级", "等級", "レベル", "레벨", "Nivel", "Niveau", "Stufe", "Уровень", "Nível", "Livello"}, {"lv", "lvl"}},
        {"Proficiency Bonus", {"Proficiency Bonus", "熟练加值", "熟練加值", "習熟ボーナス", "숙련 보너스", "Bonificador por competencia", "Bonus de maîtrise", "Übungsbonus", "Бонус мастерства", "Bônus de proficiência", "Bonus di competenza"}, {"pb", "prof", "熟练"}},
        {"HP", {"Hit Points", "生命值", "生命值", "ヒット・ポイント", "히트 포인트", "Puntos de golpe", "Points de vie", "Trefferpunkte", "Хиты", "Pontos de vida", "Punti ferita"}, {"hp", "生命", "血量", "pv", "tp"}},
        {"HP Max", {"Hit Point Maximum", "最大生命值", "最大生命值", "最大ヒット・ポイント", "최대 히트 포인트", "Puntos de golpe máximos", "Points de vie maximum", "Maximale Trefferpunkte", "Максимум хитов", "Pontos de vida máximos", "Punti ferita massimi"}, {"hpmax", "maxhp", "生命上限"}},
        {"Temp HP", {"Temporary Hit Points", "临时生命值", "臨時生命值", "一時的ヒット・ポイント", "임시 히트 포인트", "Puntos de golpe temporales", "Points de vie temporaires", "Temporäre Trefferpunkte", "Временные хиты", "Pontos de vida temporários", "Punti ferita temporanei"}, {"temphp", "thp", "临时生命"}},
        {"AC", {"Armor Class", "护甲等级", "護甲等級", "アーマー・クラス", "방어도", "Clase de armadura", "Classe d'armure", "Rüstungsklasse", "Класс доспеха", "Classe de armadura", "Classe armatura"}, {"ac", "防御等级", "护甲"}},
        {"Speed", {"Speed", "速度", "速度", "移動速度", "이동속도", "Velocidad", "Vitesse", "Bewegungsrate", "Скорость", "Deslocamento", "Velocità"}, {}},
        {"Initiative", {"Initiative", "先攻", "先攻", "イニシアチブ", "우선권", "Iniciativa", "Initiative", "Initiative", "Инициатива", "Iniciativa", "Iniziativa"}, {"init", "先攻加值"}},
        {"Death Successes", {"Death Save Successes", "死亡豁免成功", "死亡豁免成功", "死亡セーヴ成功", "죽음 내성 성공", "Éxitos de salvación contra muerte", "Réussites aux jets contre la mort", "Erfolge bei Todesrettungswürfen", "Успехи спасбросков от смерти", "Sucessos em salvaguarda contra morte", "Successi nei tiri salvezza contro morte"}, {"deathsuccess", "deathsuccesses"}},
        {"Death Failures", {"Death Save Failures", "死亡豁免失败", "死亡豁免失敗", "死亡セーヴ失敗", "죽음 내성 실패", "Fallos de salvación contra muerte", "Échecs aux jets contre la mort", "Fehlschläge bei Todesrettungswürfen", "Провалы спасбросков от смерти", "Falhas em salvaguarda contra morte", "Fallimenti nei tiri salvezza contro morte"}, {"deathfailure", "deathfailures"}},
    };
    return rows;
}
// Words that make an ability name a saving throw: "STR save", "力量豁免", "Rettungswurf Stärke".
const std::vector<std::string>& saveWords() {
    static const std::vector<std::string> w = {"savingthrow", "saves", "save", "sv", "豁免检定", "豁免檢定", "豁免", "セーヴィングスロー", "セーヴ", "내성굴림", "내성",
                                               "tiradadesalvación", "salvación", "jetdesauvegarde", "sauvegarde", "rettungswurf", "спасбросок", "testederesistência", "salvaguarda", "resistência", "tirosalvezza"};
    return w;
}
const std::vector<std::string>& attackWords() {
    static const std::vector<std::string> w = {"attack", "atk", "攻击", "攻擊", "攻撃", "공격", "ataque", "attaque", "angriff", "атака", "attacco"};
    return w;
}

struct Index { std::map<std::string, std::string> byName; std::map<std::string, const std::vector<std::string>*> namesOf; };
const Index& index() {
    static const Index idx = [] {
        Index i;
        auto add = [&](const NameRow& r) {
            i.byName[normKey(r.key)] = r.key;
            for (auto& n : r.names) i.byName[normKey(n)] = r.key;
            for (auto& a : r.aliases) i.byName[normKey(a)] = r.key;
            i.namesOf[r.key] = &r.names;
        };
        for (auto& r : abilityRows()) add(r);
        for (auto& [r, _] : skillRows()) add(r);
        for (auto& r : valueRows()) add(r);
        return i;
    }();
    return idx;
}
std::string langIndexName(const std::vector<std::string>& names, const std::string& lang) {
    for (size_t i = 0; i < kLangs.size() && i < names.size(); ++i) if (kLangs[i] == lang) return names[i];
    if (lang.rfind("zh", 0) == 0 && names.size() > 1) return names[1];
    return "";
}
bool stripWord(std::string& key, const std::string& word) {
    auto w = normKey(word);
    if (w.empty() || key.size() <= w.size()) return false;
    if (key.compare(key.size() - w.size(), w.size(), w) == 0) { key.erase(key.size() - w.size()); return true; }
    if (key.compare(0, w.size(), w) == 0) { key.erase(0, w.size()); return true; }
    return false;
}
std::string itos(long long v) { return std::to_string(v); }
std::string signedNum(int v) { return v >= 0 ? "+" + itos(v) : itos(v); }
int intOf(const Json::Value& v) { return v.isInt() ? v.asInt() : v.isDouble() ? (int)v.asDouble() : v.isString() ? std::atoi(v.asCString()) : 0; }
std::string abilityOfSkill(const std::string& skill) {
    for (auto& [r, ab] : skillRows()) if (r.key == skill) return ab;
    return "";
}
[[noreturn]] void fail(const TextSet& t, const std::string& usage) { throw DiceError(t.render("error.usage", {{"usage", usage}})); }
} // namespace

// ---- names -----------------------------------------------------------------------------------------------
const std::vector<std::string>& abilities() { static const std::vector<std::string> a = {"STR", "DEX", "CON", "INT", "WIS", "CHA"}; return a; }
const std::vector<SkillDef>& skills() {
    static const std::vector<SkillDef> s = [] { std::vector<SkillDef> v; for (auto& [r, ab] : skillRows()) v.push_back({r.key, ab}); return v; }();
    return s;
}

std::string canonical(const std::string& raw) {
    auto key = normKey(raw);
    if (key.empty()) return "";
    auto& by = index().byName;
    if (auto it = by.find(key); it != by.end()) return it->second;
    // Spell slots: "slot1", "slot 1 max", "法术位1", "1环法术位".
    static const std::regex slot(R"(^(?:slot|spellslot|法术位|法術位|呪文スロット|주문슬롯)?([1-9])(?:环|環|级|級)?(?:法术位|法術位|slot)?(max|上限|最大)?$)");
    std::smatch m;
    if (std::regex_match(key, m, slot) && (key.find("slot") != std::string::npos || key.find("法") != std::string::npos || key.find("スロット") != std::string::npos || key.find("주문") != std::string::npos))
        return "Slot " + m[1].str() + (m[2].matched ? " Max" : "");
    // Saving throws: an ability name with a "save" word before or after it.
    for (auto& w : saveWords()) {
        auto k = key;
        if (!stripWord(k, w)) continue;
        if (auto it = by.find(k); it != by.end() && std::find(abilities().begin(), abilities().end(), it->second) != abilities().end()) return it->second + " Save";
    }
    if (key.size() > 4 && key.compare(key.size() - 4, 4, "save") == 0) {   // "STR Save" written as stored
        if (auto it = by.find(key.substr(0, key.size() - 4)); it != by.end()) return it->second + " Save";
    }
    return "";
}

std::string displayName(const std::string& key, const std::string& lang) {
    if (lang.empty() || lang == "en") {
        auto it = index().namesOf.find(key);
        if (it != index().namesOf.end() && std::find(abilities().begin(), abilities().end(), key) == abilities().end()) return (*it->second)[0];
        return key;
    }
    auto loc = [&](const std::string& k) { auto it = index().namesOf.find(k); return it == index().namesOf.end() ? std::string() : langIndexName(*it->second, lang); };
    if (key.size() > 5 && key.compare(key.size() - 5, 5, " Save") == 0) {
        auto ab = loc(key.substr(0, key.size() - 5));
        if (!ab.empty()) return ab + (lang.rfind("zh", 0) == 0 ? "豁免" : " " + std::string(lang == "ja" ? "セーヴ" : lang == "ko" ? "내성" : "Save"));
    }
    auto n = loc(key);
    return n.empty() ? key : n;
}

Json::Value names() {
    Json::Value out(Json::objectValue);
    for (auto& [key, ns] : index().namesOf) for (size_t i = 0; i < kLangs.size() && i < ns->size(); ++i) out[key][kLangs[i]] = (*ns)[i];
    return out;
}

std::string storedKey(const Json::Value& attrs, const std::string& raw) {
    if (!attrs.isObject()) return "";
    auto want = canonical(raw);
    for (auto& k : attrs.getMemberNames()) {
        if (!want.empty() ? (k == want || canonical(k) == want) : normKey(k) == normKey(raw)) return k;
    }
    return "";
}
AttrValue lookup(const Json::Value& attrs, const std::string& raw) {
    AttrValue v; auto k = storedKey(attrs, raw);
    if (k.empty()) return v;
    v.found = true; v.name = k; v.value = intOf(attrs[k]);
    return v;
}

int modifier(int score) { return (int)std::floor((score - 10) / 2.0); }
int proficiencyBonus(int level) { return 2 + (std::max(1, std::min(20, level)) - 1) / 4; }
int proficiencyOf(const Json::Value& attrs) {
    auto pb = lookup(attrs, "Proficiency Bonus");
    if (pb.found) return pb.value;
    auto lv = lookup(attrs, "Level");
    return proficiencyBonus(lv.found ? lv.value : 1);
}

namespace {
// ---- D20 Tests ------------------------------------------------------------------------------------------
struct TestArgs {
    std::string name;            // what is tested, as typed ("" = a bare D20 Test)
    int mode = 0;                // +1 Advantage, -1 Disadvantage (both cancel)
    std::vector<std::string> extra;   // "+2", "-1d4": added to the total
    int target = -1; bool armor = false;   // DC or AC
    std::string reason;
};
TestArgs parseTest(const std::string& argsIn, const TextSet& t, const std::string& usage) {
    TestArgs a; std::string s = " " + text::trim(argsIn) + " ";
    bool adv = false, dis = false;
    auto takeWord = [&](const std::vector<std::string>& words) {
        bool any = false;
        for (auto& w : words) {
            for (size_t pos; (pos = text::lower(s).find(w)) != std::string::npos;) {
                bool ascii = std::all_of(w.begin(), w.end(), [](char c) { return (unsigned char)c < 0x80; });
                bool boundary = !ascii || ((pos == 0 || !std::isalnum((unsigned char)s[pos - 1])) && (pos + w.size() >= s.size() || !std::isalnum((unsigned char)s[pos + w.size()])));
                if (!boundary) break;
                s.erase(pos, w.size()); any = true;
            }
        }
        return any;
    };
    adv = takeWord({"advantage", "adv", "优势", "優勢", "有利", "이점", "ventaja", "avantage", "vorteil", "преимущество", "vantagem", "vantaggio"});
    dis = takeWord({"disadvantage", "dis", "劣势", "劣勢", "不利", "불리점", "desventaja", "désavantage", "nachteil", "помеха", "desvantagem", "svantaggio"});
    a.mode = adv == dis ? 0 : adv ? 1 : -1;
    static const std::regex target(R"((?:^|\s)(dc|ac|vs|dd|cd|sg|ca|rk|сл|кд|难度|難度|難易度)\s*[:=]?\s*(\d{1,3})(?=\s|$))", std::regex::icase);
    std::smatch m;
    if (std::regex_search(s, m, target)) {
        auto kind = text::lower(m[1].str());
        a.armor = kind == "ac" || kind == "ca" || kind == "rk" || kind == "кд";
        a.target = std::stoi(m[2].str());
        s.erase(m.position(0), m.length(0));
    }
    static const std::regex mod(R"(([+-])\s*(\d*[dD]\d+|\d+))");
    while (std::regex_search(s, m, mod)) { a.extra.push_back(m[1].str() + m[2].str()); s.erase(m.position(0), m.length(0)); }
    // A reason in brackets or after "#": ".rc stealth #sneaking past the guard".
    if (auto hash = s.find('#'); hash != std::string::npos) { a.reason = text::trim(s.substr(hash + 1)); s.erase(hash); }
    a.name = text::trim(s);
    if (a.name.size() > 80) fail(t, usage);
    return a;
}
struct D20 { int kept = 0; std::vector<int> rolls; };
D20 rollD20(Rng& rng, int mode) {
    D20 r; r.rolls.push_back(rng.roll(20));
    if (mode != 0) r.rolls.push_back(rng.roll(20));
    r.kept = mode > 0 ? *std::max_element(r.rolls.begin(), r.rolls.end()) : mode < 0 ? *std::min_element(r.rolls.begin(), r.rolls.end()) : r.rolls[0];
    return r;
}
std::string d20Text(const D20& r, int mode, const TextSet& t) {
    if (mode == 0) return "D20=" + itos(r.kept);
    return "D20 " + t.get(mode > 0 ? "dnd.advantage" : "dnd.disadvantage") + " [" + itos(r.rolls[0]) + ", " + itos(r.rolls[1]) + "]=" + itos(r.kept);
}
// What a test adds from the sheet: the parts of the bonus with their labels.
struct Bonus { int total = 0; std::vector<std::pair<std::string, int>> parts; };

enum class Kind { Plain, Ability, Save, Skill, Attack, Custom };
struct Resolved { Kind kind = Kind::Plain; std::string key; std::string ability; Bonus bonus; };

Resolved resolve(const TestArgs& a, const Context& ctx, const TextSet& t) {
    Resolved r;
    if (a.name.empty()) return r;
    const auto& L = ctx.language;
    auto low = normKey(a.name);
    for (auto& w : attackWords()) if (low == normKey(w)) { r.kind = Kind::Attack; return r; }
    auto key = canonical(a.name);
    auto score = [&](const std::string& ab) {
        auto v = lookup(ctx.attrs, ab);
        if (!v.found) throw DiceError(t.render("attr.missing", {{"name", ctx.name}, {"attr", displayName(ab, L)}, {"value", "14"}}));
        return v.value;
    };
    auto ability = std::find(abilities().begin(), abilities().end(), key) != abilities().end();
    if (ability) {
        r.kind = Kind::Ability; r.key = key; r.ability = key;
        int m = modifier(score(key)); r.bonus.parts.push_back({displayName(key, L), m}); r.bonus.total = m;
        return r;
    }
    if (key.size() > 5 && key.compare(key.size() - 5, 5, " Save") == 0) {
        r.kind = Kind::Save; r.key = key; r.ability = key.substr(0, 3);
        int m = modifier(score(r.ability)); r.bonus.parts.push_back({displayName(r.ability, L), m}); r.bonus.total = m;
        auto p = lookup(ctx.attrs, key);
        if (p.found && p.value > 0) { int pb = proficiencyOf(ctx.attrs); r.bonus.parts.push_back({t.get("dnd.proficiency"), pb}); r.bonus.total += pb; }
        return r;
    }
    if (auto ab = abilityOfSkill(key); !ab.empty()) {
        r.kind = Kind::Skill; r.key = key; r.ability = ab;
        int m = modifier(score(ab)); r.bonus.parts.push_back({displayName(ab, L), m}); r.bonus.total = m;
        auto p = lookup(ctx.attrs, key);
        if (p.found && p.value > 0) {
            int pb = proficiencyOf(ctx.attrs) * (p.value >= 2 ? 2 : 1);
            r.bonus.parts.push_back({t.get(p.value >= 2 ? "dnd.expertise" : "dnd.proficiency"), pb}); r.bonus.total += pb;
        }
        return r;
    }
    if (key == "Initiative") {   // a check with the Initiative bonus, without joining the order (that is .ri)
        r.kind = Kind::Ability; r.key = key; r.ability = "DEX";
        int m = modifier(score("DEX")); r.bonus.parts.push_back({displayName("DEX", L), m}); r.bonus.total = m;
        auto ib = lookup(ctx.attrs, "Initiative"); if (ib.found && ib.value) { r.bonus.parts.push_back({displayName("Initiative", L), ib.value}); r.bonus.total += ib.value; }
        return r;
    }
    // Anything else the sheet holds is used as the whole bonus ("Thieves' Tools 5").
    auto v = lookup(ctx.attrs, a.name);
    if (!v.found) throw DiceError(t.render("attr.missing", {{"name", ctx.name}, {"attr", a.name}, {"value", "3"}}));
    r.kind = Kind::Custom; r.key = v.name; r.bonus.parts.push_back({v.name, v.value}); r.bonus.total = v.value;
    return r;
}
std::string whatText(const Resolved& r, const Context& ctx, const TextSet& t) {
    const auto& L = ctx.language;
    switch (r.kind) {
    case Kind::Plain: return t.get("dnd.what.plain");
    case Kind::Ability: return t.render("dnd.what.ability", {{"ability", displayName(r.key, L)}});
    case Kind::Save: return t.render("dnd.what.save", {{"ability", displayName(r.ability, L)}});
    case Kind::Skill: return t.render("dnd.what.skill", {{"skill", displayName(r.key, L)}, {"ability", displayName(r.ability, L)}});
    case Kind::Attack: return t.get("dnd.what.attack");
    case Kind::Custom: return t.render("dnd.what.custom", {{"attr", r.key}});
    }
    return "";
}
std::string bonusText(const Bonus& b, const std::vector<std::pair<std::string, ExprResult>>& extra) {
    std::string s;
    for (auto& [label, v] : b.parts) if (v != 0) s += " " + std::string(v > 0 ? "+" : "-") + " " + itos(std::abs(v)) + " (" + label + ")";
    for (auto& [e, r] : extra) {
        auto body = e.substr(1);
        s += " " + e.substr(0, 1) + " " + (body.find_first_of("dD") == std::string::npos ? body : body + "[" + itos(r.total) + "]");
    }
    return s;
}

Outcome runTest(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    static const std::string u = ".rc <ability | skill | <ability> save | attack> [+N | -N | +1d4] [adv | dis] [dc N | ac N] [#reason]";
    auto a = parseTest(cmd.args, t, u);
    bool attackWord = false; for (auto& w : attackWords()) attackWord = attackWord || normKey(a.name) == normKey(w);
    // A check reads the sheet; a bare D20 Test or an attack with its bonus typed out needs no character.
    if (!a.name.empty() && !attackWord && !ctx.hasCharacter) throw DiceError(t.render("error.no_character", {{"command", cmd.raw}}));
    auto r = resolve(a, ctx, t);
    std::vector<std::pair<std::string, ExprResult>> extra;
    int total = r.bonus.total;
    for (auto& e : a.extra) {
        ExprResult er;
        try { er = evaluate(e.substr(1), rng, 20); } catch (const DiceError&) { throw DiceError(t.render("error.expression", {{"expr", e}})); }
        total += e[0] == '-' ? -er.total : er.total;
        extra.push_back({e, er});
    }
    auto d = rollD20(rng, a.mode);
    total += d.kept;
    std::string targetText, result;
    bool attack = r.kind == Kind::Attack;
    // 2024 rules: a natural 20 or 1 decides only an attack roll (a Critical Hit, or a miss); checks and saves just add.
    if (attack && d.kept == 20) result = t.get("dnd.result.critical");
    else if (attack && d.kept == 1) result = t.get("dnd.result.nat1");
    else if (a.target >= 0) {
        bool ok = total >= a.target;
        result = t.get(attack ? (ok ? "dnd.result.hit" : "dnd.result.miss") : (ok ? "dnd.result.success" : "dnd.result.failure"));
    } else if (d.kept == 20 || d.kept == 1) result = t.get(d.kept == 20 ? "dnd.nat20" : "dnd.nat1");
    if (a.target >= 0) targetText = t.render(a.armor || attack ? "dnd.target.ac" : "dnd.target.dc", {{"dc", itos(a.target)}, {"ac", itos(a.target)}});
    Outcome o;
    o.text = t.render("dnd.check", {{"name", ctx.name}, {"what", whatText(r, ctx, t)}, {"reason", a.reason.empty() ? "" : t.render("reason", {{"reason", a.reason}})},
                                    {"roll", d20Text(d, a.mode, t)}, {"bonus", bonusText(r.bonus, extra)}, {"total", itos(total)}, {"target", targetText}, {"result", result}});
    o.hidden = cmd.hidden;
    o.detail["type"] = "d20"; o.detail["test"] = attack ? "attack" : r.kind == Kind::Save ? "save" : r.kind == Kind::Plain ? "plain" : "check";
    if (!r.key.empty()) o.detail["attr"] = r.key;
    o.detail["roll"] = d.kept; o.detail["total"] = total; o.detail["mode"] = a.mode;
    for (int x : d.rolls) o.detail["rolls"].append(x);
    if (a.target >= 0) { o.detail["target"] = a.target; o.detail["success"] = attack ? (d.kept == 20 || (d.kept != 1 && total >= a.target)) : total >= a.target; }
    if (attack && d.kept == 20) o.detail["critical"] = true;
    if (!a.reason.empty()) o.detail["reason"] = a.reason;
    return o;
}

// ---- .ri ----------------------------------------------------------------------------------------------
Outcome runInitiative(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    static const std::string u = ".ri [+N | -N] [adv | dis] [name]";
    auto a = parseTest(cmd.args, t, u);
    // Who joins the order: the speaking character, or a name ("Goblin 2") the GM rolls for.
    std::string who = a.name.empty() ? ctx.name : a.name;
    Bonus b; int tiebreak = 0;
    bool fromSheet = a.name.empty() && ctx.hasCharacter;
    if (fromSheet) {
        auto dex = lookup(ctx.attrs, "DEX");
        if (dex.found) { int m = modifier(dex.value); b.parts.push_back({displayName("DEX", ctx.language), m}); b.total += m; tiebreak = m; }
        auto ib = lookup(ctx.attrs, "Initiative");
        if (ib.found && ib.value) { b.parts.push_back({displayName("Initiative", ctx.language), ib.value}); b.total += ib.value; }
    }
    std::vector<std::pair<std::string, ExprResult>> extra;
    int total = b.total;
    for (auto& e : a.extra) {
        ExprResult er;
        try { er = evaluate(e.substr(1), rng, 20); } catch (const DiceError&) { throw DiceError(t.render("error.expression", {{"expr", e}})); }
        int v = e[0] == '-' ? -er.total : er.total; total += v;
        if (!fromSheet) tiebreak += v;
        extra.push_back({e, er});
    }
    auto d = rollD20(rng, a.mode);
    total += d.kept;
    Outcome o;
    o.text = t.render("dnd.initiative", {{"name", who}, {"roll", d20Text(d, a.mode, t)}, {"bonus", bonusText(b, extra)}, {"total", itos(total)}});
    o.hidden = cmd.hidden;
    o.detail["type"] = "initiative"; o.detail["roll"] = d.kept; o.detail["total"] = total;
    o.detail["initiative"]["name"] = text::utf8Prefix(who, 80); o.detail["initiative"]["total"] = total; o.detail["initiative"]["tiebreak"] = tiebreak;
    o.detail["initiative"]["own"] = fromSheet;
    return o;
}

// ---- .ds ----------------------------------------------------------------------------------------------
Outcome runDeathSave(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    if (!ctx.hasCharacter) throw DiceError(t.render("error.no_character", {{"command", cmd.raw}}));
    Json::Value attrs = ctx.attrs.isObject() ? ctx.attrs : Json::Value(Json::objectValue);
    auto key = [&](const char* k) { auto s = storedKey(attrs, k); return s.empty() ? std::string(k) : s; };
    auto sk = key("Death Successes"), fk = key("Death Failures");
    int succ = intOf(attrs[sk]), fails = intOf(attrs[fk]);
    Outcome o; o.detail["type"] = "death_save";
    auto args = text::lower(text::trim(cmd.args));
    if (args == "clr" || args == "clear" || args == "reset") {
        attrs[sk] = 0; attrs[fk] = 0;
        o.text = t.render("dnd.death.reset", {{"name", ctx.name}}); o.attrs = attrs; o.attrsChanged = true;
        return o;
    }
    if (!args.empty()) fail(t, ".ds | .ds clr");
    int roll = rng.roll(20);
    o.detail["roll"] = roll;
    std::map<std::string, std::string> vars{{"name", ctx.name}, {"roll", itos(roll)}};
    if (roll == 20) {
        // A natural 20: back to 1 Hit Point, and the counts start over.
        attrs[sk] = 0; attrs[fk] = 0;
        auto hp = key("HP"); attrs[hp] = std::max(1, intOf(attrs[hp]));
        o.text = t.render("dnd.death.nat20", vars);
    } else {
        if (roll == 1) fails += 2; else if (roll < 10) fails += 1; else succ += 1;
        fails = std::min(3, fails); succ = std::min(3, succ);
        vars["successes"] = itos(succ); vars["failures"] = itos(fails);
        o.text = t.render(roll == 1 ? "dnd.death.nat1" : roll < 10 ? "dnd.death.failure" : "dnd.death.success", vars);
        if (fails >= 3) o.text += " " + t.render("dnd.death.dead", vars);
        else if (succ >= 3) { o.text += " " + t.render("dnd.death.stable", vars); succ = 0; fails = 0; }
        attrs[sk] = succ; attrs[fk] = fails;
    }
    o.detail["successes"] = intOf(attrs[sk]); o.detail["failures"] = intOf(attrs[fk]);
    o.hidden = cmd.hidden; o.attrs = attrs; o.attrsChanged = true;
    return o;
}

// ---- .ss ----------------------------------------------------------------------------------------------
Outcome runSlots(const Command& cmd, const Context& ctx, const TextSet& t, Rng&) {
    static const std::string u = ".ss | .ss <level> | .ss <level> +N | .ss reset";
    if (!ctx.hasCharacter) throw DiceError(t.render("error.no_character", {{"command", cmd.raw}}));
    Json::Value attrs = ctx.attrs.isObject() ? ctx.attrs : Json::Value(Json::objectValue);
    auto key = [&](const std::string& k) { auto s = storedKey(attrs, k); return s.empty() ? k : s; };
    auto listText = [&] {
        std::vector<std::string> parts;
        for (int lv = 1; lv <= 9; ++lv) {
            auto mx = lookup(attrs, "Slot " + itos(lv) + " Max");
            if (!mx.found || mx.value <= 0) continue;
            auto cur = lookup(attrs, "Slot " + itos(lv));
            parts.push_back(t.render("dnd.slots.item", {{"level", itos(lv)}, {"left", itos(cur.found ? cur.value : mx.value)}, {"max", itos(mx.value)}}));
        }
        return text::join(parts, ", ");
    };
    Outcome o; o.detail["type"] = "spell_slots";
    auto args = text::lower(text::trim(cmd.args));
    if (args.empty()) {
        auto list = listText();
        o.text = t.render(list.empty() ? "dnd.slots.none" : "dnd.slots.show", {{"name", ctx.name}, {"list", list}});
        return o;
    }
    if (args == "reset" || args == "rest" || args == "longrest" || args == "长休") {
        for (int lv = 1; lv <= 9; ++lv) { auto mx = lookup(attrs, "Slot " + itos(lv) + " Max"); if (mx.found) attrs[key("Slot " + itos(lv))] = mx.value; }
        o.text = t.render("dnd.slots.reset", {{"name", ctx.name}, {"list", listText()}});
        o.attrs = attrs; o.attrsChanged = true;
        return o;
    }
    static const std::regex use(R"(^([1-9])\s*(?:([+-])\s*(\d{1,2}))?$)");
    std::smatch m;
    if (!std::regex_match(args, m, use)) fail(t, u);
    auto lv = m[1].str();
    auto mx = lookup(attrs, "Slot " + lv + " Max");
    if (!mx.found || mx.value <= 0) throw DiceError(t.render("dnd.slots.none", {{"name", ctx.name}, {"list", ""}}));
    auto curKey = key("Slot " + lv);
    auto cur = lookup(attrs, "Slot " + lv);
    int left = cur.found ? cur.value : mx.value;
    std::map<std::string, std::string> vars{{"name", ctx.name}, {"level", lv}, {"max", itos(mx.value)}};
    if (m[2].matched && m[2].str() == "+") {
        int n = std::stoi(m[3].str());
        left = std::min(mx.value, left + n);
        vars["n"] = itos(n); vars["left"] = itos(left);
        o.text = t.render("dnd.slots.regain", vars);
    } else {
        int n = m[3].matched ? std::stoi(m[3].str()) : 1;
        if (left < n) { vars["left"] = itos(left); throw DiceError(t.render("dnd.slots.empty", vars)); }
        left -= n; vars["left"] = itos(left); vars["n"] = itos(n);
        o.text = t.render("dnd.slots.use", vars);
    }
    attrs[curKey] = left;
    o.detail["level"] = std::stoi(lv); o.detail["left"] = left;
    o.attrs = attrs; o.attrsChanged = true;
    return o;
}
} // namespace

Outcome execute(const Command& cmd, const Context& ctx, const TextSet& texts, Rng& rng) {
    if (cmd.name == "ra") return runTest(cmd, ctx, texts, rng);
    if (cmd.name == "ri") return runInitiative(cmd, ctx, texts, rng);
    if (cmd.name == "ds") return runDeathSave(cmd, ctx, texts, rng);
    if (cmd.name == "ss") return runSlots(cmd, ctx, texts, rng);
    throw DiceError("unknown command");
}

std::string preview(const Command& cmd, const Context& ctx, const TextSet& t) {
    try {
        if (cmd.name != "ra" || !ctx.hasCharacter) return "";
        auto a = parseTest(cmd.args, t, "");
        if (a.name.empty()) return "";
        auto r = resolve(a, ctx, t);
        if (r.kind == Kind::Attack) return "";
        return t.render("dnd.hint", {{"name", ctx.name}, {"what", whatText(r, ctx, t)}, {"bonus", signedNum(r.bonus.total)}});
    } catch (const DiceError&) { return ""; }
}

} // namespace acerciae::dice::dnd
