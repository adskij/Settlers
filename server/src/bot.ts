// Simple greedy AI that drives bot-controlled seats.
// It performs ONE action per call so the scheduler can broadcast between moves,
// giving humans a paced, watchable bot turn. All moves go through applyAction,
// so bots are bound by exactly the same rules as humans.
import {
  BUILD_COSTS,
  RESOURCES,
  type GameState,
  type PlayerColor,
  type PlayerState,
  type Resource,
  type ResourceCounts,
  type ClientMessage,
} from "@settlers/shared";
import { applyAction, type InternalGame } from "./engine.js";

// Number-token "pip" weight: how likely a hex is to produce (6/8 best).
function pip(n: number | null): number {
  if (n == null) return 0;
  return 6 - Math.abs(7 - n);
}

function canAfford(p: PlayerState, cost: Partial<ResourceCounts>): boolean {
  return Object.entries(cost).every(
    ([r, n]) => p.resources[r as Resource] >= (n ?? 0)
  );
}

function botPlayer(state: GameState): PlayerState | null {
  return state.players[state.currentPlayerIndex] ?? null;
}

// Is a bot currently on the clock (its turn, or it owes a discard)?
export function botShouldAct(game: InternalGame): boolean {
  const s = game.state;
  if (s.phase === "finished" || s.phase === "lobby") return false;
  if (s.phase === "discard") {
    return s.players.some((p) => p.isBot && (s.pendingDiscards[p.color] ?? 0) > 0);
  }
  const cur = botPlayer(s);
  return !!cur && cur.isBot;
}

// Perform one bot action. Returns true if an action was applied.
export function botStep(game: InternalGame): boolean {
  const s = game.state;

  // Discards can be owed by any bot, even on a human's 7.
  if (s.phase === "discard") {
    const debtor = s.players.find(
      (p) => p.isBot && (s.pendingDiscards[p.color] ?? 0) > 0
    );
    if (debtor) return botDiscard(game, debtor);
    return false;
  }

  const cur = botPlayer(s);
  if (!cur || !cur.isBot) return false;
  const color = cur.color;

  switch (s.phase) {
    case "setup":
      return s.setupStep === "settlement"
        ? botSetupSettlement(game, color)
        : botSetupRoad(game, color);
    case "rolling":
      return act(game, color, { type: "roll_dice" });
    case "moving_robber":
      return botMoveRobber(game, color);
    case "main":
      return botMain(game, color);
    default:
      return false;
  }
}

function act(game: InternalGame, color: PlayerColor, msg: ClientMessage): boolean {
  return applyAction(game, color, msg).ok;
}

// ---- Setup ----

function rankedVertices(state: GameState): number[] {
  return state.board.vertices
    .map((v) => ({
      id: v.id,
      score:
        v.hexIds.reduce((sum, h) => sum + pip(state.board.hexes[h].number), 0) +
        (v.port ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((v) => v.id);
}

// Does this vertex still have an unused incident edge for the setup road?
// (The setup road must connect to the settlement just placed, so a vertex
// whose edges are all taken would strand the bot.)
function hasFreeIncidentEdge(state: GameState, vertexId: number): boolean {
  return state.board.edges.some(
    (e) =>
      (e.v1 === vertexId || e.v2 === vertexId) &&
      !state.roads.some((r) => r.edgeId === e.id)
  );
}

function botSetupSettlement(game: InternalGame, color: PlayerColor): boolean {
  const s = game.state;
  // Prefer high-pip vertices that also leave a free edge for the setup road,
  // so the bot never strands itself with nowhere to place the road.
  for (const vertexId of rankedVertices(s)) {
    if (!hasFreeIncidentEdge(s, vertexId)) continue;
    if (act(game, color, { type: "place_setup_settlement", vertexId })) return true;
  }
  // Fallback: any legal vertex (extremely unlikely to be needed).
  for (const vertexId of rankedVertices(s)) {
    if (act(game, color, { type: "place_setup_settlement", vertexId })) return true;
  }
  return false;
}

function botSetupRoad(game: InternalGame, color: PlayerColor): boolean {
  const s = game.state;
  const v = s.pendingSetupVertex;
  if (v == null) return false;
  const edges = s.board.edges.filter((e) => e.v1 === v || e.v2 === v);
  for (const e of edges) {
    if (act(game, color, { type: "place_setup_road", edgeId: e.id })) return true;
  }
  return false;
}

// ---- Robber ----

function botMoveRobber(game: InternalGame, color: PlayerColor): boolean {
  const s = game.state;
  // Pick the hex (not desert/current) bordering the most opponent buildings.
  let bestHex = -1;
  let bestCount = -1;
  for (const hex of s.board.hexes) {
    if (hex.id === s.board.robberHexId || hex.terrain === "desert") continue;
    const owners = new Set<PlayerColor>();
    for (const b of s.buildings) {
      if (b.owner === color) continue;
      if (s.board.vertices[b.vertexId].hexIds.includes(hex.id)) owners.add(b.owner);
    }
    if (owners.size > bestCount) {
      bestCount = owners.size;
      bestHex = hex.id;
    }
  }
  if (bestHex < 0) bestHex = s.board.hexes.findIndex((h) => h.id !== s.board.robberHexId);

  // Choose a victim with cards on that hex, if any.
  const victims = new Set<PlayerColor>();
  for (const b of s.buildings) {
    if (b.owner === color) continue;
    if (s.board.vertices[b.vertexId].hexIds.includes(bestHex)) victims.add(b.owner);
  }
  const withCards = [...victims].filter((c) => {
    const p = s.players.find((pl) => pl.color === c)!;
    return RESOURCES.some((r) => p.resources[r] > 0);
  });
  const stealFrom = withCards[0] ?? null;
  return act(game, color, { type: "move_robber", hexId: bestHex, stealFrom });
}

// ---- Discard ----

function botDiscard(game: InternalGame, p: PlayerState): boolean {
  const owed = game.state.pendingDiscards[p.color] ?? 0;
  if (owed <= 0) return false;
  // Drop from the most abundant resources first.
  const counts = RESOURCES.map((r) => ({ r, n: p.resources[r] })).sort(
    (a, b) => b.n - a.n
  );
  const out: Partial<ResourceCounts> = {};
  let left = owed;
  for (const { r, n } of counts) {
    if (left <= 0) break;
    const take = Math.min(n, left);
    if (take > 0) {
      out[r] = take;
      left -= take;
    }
  }
  return act(game, p.color, { type: "discard", resources: out });
}

// ---- Main phase: build greedily, else end the turn ----

function botMain(game: InternalGame, color: PlayerColor): boolean {
  const s = game.state;
  const me = s.players.find((p) => p.color === color)!;

  // 1. Upgrade a settlement to a city.
  if (canAfford(me, BUILD_COSTS.city)) {
    for (const b of s.buildings) {
      if (b.owner === color && b.kind === "settlement") {
        if (act(game, color, { type: "build_city", vertexId: b.vertexId })) return true;
      }
    }
  }
  // 2. Build a settlement at the best legal spot.
  if (canAfford(me, BUILD_COSTS.settlement)) {
    for (const vertexId of rankedVertices(s)) {
      if (act(game, color, { type: "build_settlement", vertexId })) return true;
    }
  }
  // 3. Extend the road network (sometimes), to open new spots.
  if (canAfford(me, BUILD_COSTS.road)) {
    for (const e of s.board.edges) {
      if (act(game, color, { type: "build_road", edgeId: e.id })) return true;
    }
  }
  // 4. Otherwise bank a development card if flush.
  if (s.devDeckCount > 0 && canAfford(me, BUILD_COSTS.dev_card)) {
    if (act(game, color, { type: "buy_dev_card" })) return true;
  }
  // 5. Nothing useful to do: end the turn.
  return act(game, color, { type: "end_turn" });
}
