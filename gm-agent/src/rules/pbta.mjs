// PbtA's reviewed pack and playbooks are handled by pbta.mjs; this profile supplies
// the shared narrative vocabulary without borrowing CoC dice or character sheets.
export const PBTA = Object.freeze({
  id: "pbta",
  vocab: Object.freeze({
    game: "Powered by the Apocalypse", campaign: "a Powered by the Apocalypse campaign",
    gm: "MC", gmShort: "MC", pc: "character", pcs: "characters",
    losses: "resources, conditions and items gained or lost",
  }),
  framing: () => "the MC of a Powered by the Apocalypse campaign",
  coplayerGame: () => "a Powered by the Apocalypse game",
  fetchRules: (api, channelId) => api.pbtaRules(channelId),
  roll: /^\.move [a-z][a-z0-9_-]*(?: [+-]?\d{1,2})?$/,
  gmDice: null,
  dice: { requestRoll: ".move <move-id>", coplayerShape: ".move <move-id>", gmHelp: "" },
  combatRule: "",
  castNote: () => "",
});
