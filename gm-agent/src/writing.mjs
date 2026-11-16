// Editable guidance for two separate requests. Rules and the source/routing protocol stay in the role prompts.
export const WRITING_MAX_LENGTH = 12000;
export const DEFAULT_WRITING = Object.freeze({
  gm: "Let gestures, details that matter here, and each NPC's own voice carry the scene. Trust subtext and leave room for the players' reply. A few paragraphs is typical.",
  coplayer: "Put the choice on the page as an action or dialogue, rather than saying you might act later. Give it a specific detail or a distinct voice. A quiet beat can be as telling as a confrontation; let the stakes and the tone of the scene guide you. One compact turn is usually enough.",
  formatting: "Keep the drafted order and use each message paragraph once; group consecutive paragraphs of the same kind and speaker/recipient with an array of ids if needed. Use one message for a co-player move or phone reply.",
});
