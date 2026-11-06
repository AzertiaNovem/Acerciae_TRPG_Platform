export const PBTA_RULES = {
  revision: 1,
  pack: {
    name: "Night crew", books: [{ id: "scout", name: "Scout" }],
    stats: [{ id: "sense", name: "Sense" }], bands: [],
    resources: [{ id: "supply", name: "Supply" }], conditions: [],
    moves: [{ id: "explore", name: "Explore", stat: "sense", trigger: "When you explore the station." }],
    gmMoves: [{ text: "PRIVATE-GM-MOVE" }],
  },
};
