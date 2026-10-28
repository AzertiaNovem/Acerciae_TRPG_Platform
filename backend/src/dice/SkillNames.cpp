#include "Dice.h"
#include <map>

// The COC7 skill and characteristic names in each server language. The point-buy sheet shows them, dice commands
// accept them next to the English names, and dice replies use them. Stored keys stay the English canonical names.
namespace acerciae::dice {
namespace {
// Column order of kNames.
const std::vector<std::string> kLanguages = {"zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "ru", "pt", "it"};
struct Row { const char* canonical; std::vector<const char*> names; };
const std::vector<Row> kNames = {
    // characteristics
    {"STR", {"力量", "力量", "筋力", "근력", "Fuerza", "Force", "Stärke", "Сила", "Força", "Forza"}},
    {"CON", {"体质", "體質", "体力", "건강", "Constitución", "Constitution", "Konstitution", "Выносливость", "Constituição", "Costituzione"}},
    {"SIZ", {"体型", "體型", "体格", "체격", "Tamaño", "Taille", "Größe", "Телосложение", "Tamanho", "Taglia"}},
    {"DEX", {"敏捷", "敏捷", "敏捷性", "민첩성", "Destreza", "Dextérité", "Geschicklichkeit", "Ловкость", "Destreza", "Destrezza"}},
    {"APP", {"外貌", "外貌", "外見", "외모", "Apariencia", "Apparence", "Erscheinung", "Внешность", "Aparência", "Aspetto"}},
    {"INT", {"智力", "智力", "知性", "지능", "Inteligencia", "Intelligence", "Intelligenz", "Интеллект", "Inteligência", "Intelligenza"}},
    {"POW", {"意志", "意志", "精神力", "정신력", "Poder", "Pouvoir", "Mana", "Мощь", "Poder", "Potere"}},
    {"EDU", {"教育", "教育", "教育", "교육", "Educación", "Éducation", "Bildung", "Образование", "Educação", "Istruzione"}},
    {"Luck", {"幸运", "幸運", "幸運", "행운", "Suerte", "Chance", "Glück", "Удача", "Sorte", "Fortuna"}},
    {"SAN", {"理智", "理智", "正気度", "이성", "Cordura", "Santé mentale", "Stabilität", "Рассудок", "Sanidade", "Sanità mentale"}},
    {"HP", {"生命值", "生命值", "耐久力", "체력", "Puntos de vida", "Points de vie", "Trefferpunkte", "Пункты здоровья", "Pontos de Vida", "Punti ferita"}},
    {"MP", {"魔法值", "魔法值", "マジック・ポイント", "마력", "Puntos de magia", "Points de magie", "Magiepunkte", "Пункты магии", "Pontos de Magia", "Punti magia"}},
    {"MOV", {"移动力", "移動力", "移動率", "이동력", "Movimiento", "Mouvement", "Bewegungsweite", "Движение", "Movimento", "Movimento"}},
    // skills
    {"Accounting", {"会计", "會計", "経理", "회계", "Contabilidad", "Comptabilité", "Buchführung", "Бухгалтерия", "Contabilidade", "Contabilità"}},
    {"Anthropology", {"人类学", "人類學", "人類学", "인류학", "Antropología", "Anthropologie", "Anthropologie", "Антропология", "Antropologia", "Antropologia"}},
    {"Appraise", {"估价", "估價", "鑑定", "감정", "Tasación", "Estimation", "Schätzen", "Оценка", "Avaliação", "Valutare"}},
    {"Archaeology", {"考古学", "考古學", "考古学", "고고학", "Arqueología", "Archéologie", "Archäologie", "Археология", "Arqueologia", "Archeologia"}},
    {"Art/Craft", {"技艺", "技藝", "芸術/製作", "예술/공예", "Arte/Artesanía", "Art/Artisanat", "Kunst/Handwerk", "Искусство/Ремесло", "Arte/Ofício", "Arte/Mestiere"}},
    {"Charm", {"魅惑", "魅惑", "魅惑", "매혹", "Encanto", "Charme", "Charme", "Обаяние", "Charme", "Fascino"}},
    {"Climb", {"攀爬", "攀爬", "登攀", "등반", "Trepar", "Grimper", "Klettern", "Лазание", "Escalar", "Scalare"}},
    {"Credit Rating", {"信用评级", "信用評級", "信用", "신용", "Crédito", "Crédit", "Finanzkraft", "Средства", "Nível de Crédito", "Credito"}},
    {"Cthulhu Mythos", {"克苏鲁神话", "克蘇魯神話", "クトゥルフ神話", "크툴루 신화", "Mitos de Cthulhu", "Mythe de Cthulhu", "Cthulhu-Mythos", "Мифы Ктулху", "Mitos de Cthulhu", "Miti di Cthulhu"}},
    {"Disguise", {"乔装", "喬裝", "変装", "변장", "Disfrazarse", "Déguisement", "Verkleiden", "Маскировка", "Disfarce", "Travestimento"}},
    {"Dodge", {"闪避", "閃避", "回避", "회피", "Esquivar", "Esquiver", "Ausweichen", "Уклонение", "Esquivar", "Schivare"}},
    {"Drive Auto", {"汽车驾驶", "汽車駕駛", "自動車運転", "자동차 운전", "Conducir automóvil", "Conduite automobile", "Autofahren", "Вождение автомобиля", "Dirigir Automóveis", "Guidare auto"}},
    {"Electrical Repair", {"电气维修", "電氣維修", "電気修理", "전기 수리", "Electricidad", "Électricité", "Elektrische Reparaturen", "Электрика", "Consertos Elétricos", "Riparazioni elettriche"}},
    {"Fast Talk", {"话术", "話術", "言いくるめ", "말재주", "Charlatanería", "Baratin", "Überreden", "Красноречие", "Lábia", "Raggirare"}},
    {"Fighting (Brawl)", {"格斗（斗殴）", "格鬥（鬥毆）", "近接戦闘（格闘）", "근접전(맨손)", "Combatir (Pelea)", "Combat rapproché (Corps à corps)", "Nahkampf (Handgemenge)", "Ближний бой (драка)", "Lutar (Briga)", "Combattere (Rissa)"}},
    {"Firearms (Handgun)", {"射击（手枪）", "射擊（手槍）", "射撃（拳銃）", "사격(권총)", "Armas de fuego (Pistola)", "Armes à feu (Arme de poing)", "Schusswaffen (Faustfeuerwaffe)", "Стрельба (пистолет)", "Armas de Fogo (Pistola)", "Armi da fuoco (Pistola)"}},
    {"Firearms (Rifle/Shotgun)", {"射击（步枪/霰弹枪）", "射擊（步槍/霰彈槍）", "射撃（ライフル/ショットガン）", "사격(소총/산탄총)", "Armas de fuego (Fusil/Escopeta)", "Armes à feu (Fusil/Fusil de chasse)", "Schusswaffen (Gewehr/Schrotflinte)", "Стрельба (винтовка/дробовик)", "Armas de Fogo (Rifle/Espingarda)", "Armi da fuoco (Fucile/Fucile da caccia)"}},
    {"First Aid", {"急救", "急救", "応急手当", "응급처치", "Primeros auxilios", "Premiers soins", "Erste Hilfe", "Первая помощь", "Primeiros Socorros", "Pronto soccorso"}},
    {"History", {"历史", "歷史", "歴史", "역사", "Historia", "Histoire", "Geschichtswissen", "История", "História", "Storia"}},
    {"Intimidate", {"恐吓", "恐嚇", "威圧", "위협", "Intimidar", "Intimidation", "Einschüchtern", "Запугивание", "Intimidação", "Intimidire"}},
    {"Jump", {"跳跃", "跳躍", "跳躍", "도약", "Saltar", "Sauter", "Springen", "Прыжки", "Saltar", "Saltare"}},
    {"Language (Own)", {"母语", "母語", "母国語", "모국어", "Lengua propia", "Langue maternelle", "Muttersprache", "Родной язык", "Língua Nativa", "Lingua madre"}},
    {"Language (Other)", {"外语", "外語", "ほかの言語", "외국어", "Otras lenguas", "Langue étrangère", "Fremdsprache", "Иностранный язык", "Outras Línguas", "Lingua straniera"}},
    {"Law", {"法律", "法律", "法律", "법률", "Derecho", "Droit", "Rechtswesen", "Юриспруденция", "Direito", "Legge"}},
    {"Library Use", {"图书馆使用", "圖書館使用", "図書館", "자료조사", "Buscar libros", "Bibliothèque", "Bibliotheksnutzung", "Работа в библиотеке", "Usar Bibliotecas", "Biblioteca"}},
    {"Listen", {"聆听", "聆聽", "聞き耳", "듣기", "Escuchar", "Écouter", "Horchen", "Слух", "Escutar", "Ascoltare"}},
    {"Locksmith", {"锁匠", "鎖匠", "鍵開け", "열쇠공", "Cerrajería", "Serrurerie", "Schlosserarbeit", "Взлом", "Chaveiro", "Scassinare"}},
    {"Mechanical Repair", {"机械维修", "機械維修", "機械修理", "기계 수리", "Mecánica", "Mécanique", "Mechanische Reparaturen", "Механика", "Consertos Mecânicos", "Riparazioni meccaniche"}},
    {"Medicine", {"医学", "醫學", "医学", "의학", "Medicina", "Médecine", "Medizin", "Медицина", "Medicina", "Medicina"}},
    {"Natural World", {"博物学", "博物學", "博物学", "자연", "Naturaleza", "Monde naturel", "Naturkunde", "Естествознание", "Mundo Natural", "Mondo naturale"}},
    {"Navigate", {"导航", "導航", "ナビゲート", "항법", "Orientarse", "Orientation", "Orientierung", "Навигация", "Navegação", "Orientamento"}},
    {"Occult", {"神秘学", "神秘學", "オカルト", "오컬트", "Ciencias ocultas", "Occultisme", "Okkultismus", "Оккультизм", "Ocultismo", "Occultismo"}},
    {"Operate Heavy Machinery", {"操作重型机械", "操作重型機械", "重機械操作", "중장비 조작", "Maquinaria pesada", "Conduite d'engins", "Schwere Maschinen bedienen", "Тяжёлая техника", "Operar Maquinário Pesado", "Macchinari pesanti"}},
    {"Persuade", {"说服", "說服", "説得", "설득", "Persuasión", "Persuasion", "Überzeugen", "Убеждение", "Persuasão", "Persuasione"}},
    {"Pilot", {"驾驶", "駕駛", "操縦", "조종", "Pilotar", "Pilotage", "Steuern", "Пилотирование", "Pilotar", "Pilotare"}},
    {"Psychology", {"心理学", "心理學", "心理学", "심리학", "Psicología", "Psychologie", "Psychologie", "Психология", "Psicologia", "Psicologia"}},
    {"Psychoanalysis", {"精神分析", "精神分析", "精神分析", "정신분석", "Psicoanálisis", "Psychanalyse", "Psychoanalyse", "Психоанализ", "Psicanálise", "Psicanalisi"}},
    {"Ride", {"骑术", "騎術", "乗馬", "승마", "Montar", "Équitation", "Reiten", "Верховая езда", "Cavalgar", "Cavalcare"}},
    {"Science", {"科学", "科學", "科学", "과학", "Ciencia", "Sciences", "Naturwissenschaft", "Наука", "Ciência", "Scienza"}},
    {"Sleight of Hand", {"妙手", "妙手", "手さばき", "손재주", "Juegos de manos", "Escamotage", "Fingerfertigkeit", "Ловкость рук", "Prestidigitação", "Rapidità di mano"}},
    {"Spot Hidden", {"侦查", "偵查", "目星", "관찰력", "Descubrir", "Trouver objet caché", "Verborgenes erkennen", "Внимательность", "Encontrar", "Individuare"}},
    {"Stealth", {"潜行", "潛行", "隠密", "은밀행동", "Sigilo", "Discrétion", "Heimlichkeit", "Скрытность", "Furtividade", "Furtività"}},
    {"Survival", {"生存", "生存", "サバイバル", "생존술", "Supervivencia", "Survie", "Überleben", "Выживание", "Sobrevivência", "Sopravvivenza"}},
    {"Swim", {"游泳", "游泳", "水泳", "수영", "Nadar", "Nager", "Schwimmen", "Плавание", "Nadar", "Nuotare"}},
    {"Throw", {"投掷", "投擲", "投擲", "투척", "Lanzar", "Lancer", "Werfen", "Метание", "Arremessar", "Lanciare"}},
    {"Track", {"追踪", "追蹤", "追跡", "추적", "Rastrear", "Pister", "Spurensuche", "Выслеживание", "Rastrear", "Seguire tracce"}},
    {"Computer Use", {"计算机使用", "電腦使用", "コンピューター", "컴퓨터 사용", "Informática", "Informatique", "Computernutzung", "Компьютер", "Usar Computadores", "Informatica"}},
    {"Electronics", {"电子学", "電子學", "電子工学", "전자공학", "Electrónica", "Électronique", "Elektronik", "Электроника", "Eletrônica", "Elettronica"}},
    {"Animal Handling", {"动物驯养", "動物馴養", "動物使い", "동물 다루기", "Trato con animales", "Dressage", "Tierdressur", "Дрессировка", "Lidar com Animais", "Addestrare animali"}},
    {"Diving", {"潜水", "潛水", "潜水", "잠수", "Bucear", "Plongée", "Tauchen", "Ныряние", "Mergulho", "Immersione"}},
    {"Demolitions", {"爆破", "爆破", "爆破", "폭파", "Demoliciones", "Explosifs", "Sprengstoffe", "Подрывное дело", "Demolição", "Demolizioni"}},
    {"Hypnosis", {"催眠", "催眠", "催眠術", "최면", "Hipnosis", "Hypnose", "Hypnose", "Гипноз", "Hipnose", "Ipnosi"}},
    {"Lip Reading", {"读唇", "讀唇", "読唇術", "독순술", "Leer los labios", "Lecture sur les lèvres", "Lippenlesen", "Чтение по губам", "Leitura Labial", "Leggere le labbra"}},
    {"Artillery", {"炮术", "砲術", "砲術", "포술", "Artillería", "Artillerie", "Artillerie", "Артиллерия", "Artilharia", "Artiglieria"}},
    {"Lore", {"学识", "學識", "伝承", "전승", "Saber", "Savoir", "Überlieferung", "Знания", "Saber", "Sapere"}},
    // specialisation families without a skill of their own
    {"Fighting", {"格斗", "格鬥", "近接戦闘", "근접전", "Combatir", "Combat rapproché", "Nahkampf", "Ближний бой", "Lutar", "Combattere"}},
    {"Firearms", {"射击", "射擊", "射撃", "사격", "Armas de fuego", "Armes à feu", "Schusswaffen", "Стрельба", "Armas de Fogo", "Armi da fuoco"}},
};
const std::map<std::string, const Row*>& byCanonical() {
    static const std::map<std::string, const Row*> m = [] { std::map<std::string, const Row*> r; for (auto& row : kNames) r[row.canonical] = &row; return r; }();
    return m;
}
int column(const std::string& lang) {
    for (std::size_t i = 0; i < kLanguages.size(); ++i) if (kLanguages[i] == lang) return (int)i;
    return -1;
}
}

const std::vector<std::string>& nameLanguages() { return kLanguages; }
std::vector<std::string> namedCanonicals() { std::vector<std::string> v; for (auto& row : kNames) v.push_back(row.canonical); return v; }
std::string localName(const std::string& canonical, const std::string& lang) {
    int col = column(lang);
    if (col < 0) return "";
    auto it = byCanonical().find(canonical);
    return it == byCanonical().end() ? "" : it->second->names[col];
}
Json::Value localNames(const std::string& canonical) {
    Json::Value v(Json::objectValue);
    auto it = byCanonical().find(canonical);
    if (it != byCanonical().end()) for (std::size_t i = 0; i < kLanguages.size(); ++i) v[kLanguages[i]] = it->second->names[i];
    return v;
}

} // namespace acerciae::dice
