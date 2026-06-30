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
  type TradeOffer,
  type ClientMessage,
} from "@settlers/shared";
import { applyAction, type InternalGame } from "./engine.js";

// How long a bot keeps an offer open for a *human* to accept after no AI
// takes it. Other bots decide instantly (next tick), so all-bot games never
// actually wait this out.
const BOT_TRADE_WAIT_MS = 30_000;

// Number-token "pip" weight: how likely a hex is to produce (6/8 best).
function pip(n: number | null): number {
  if (n == null) return 0;
  return 6 - Math.abs(7 - n);
}

function canAfford(p: PlayerState, cost: Partial<ResourceCounts>): boolean {
  return RESOURCES.every((r) => p.resources[r] >= (cost[r] ?? 0));
}

// Cards still needed to afford a cost (0 once affordable).
function deficit(res: ResourceCounts, cost: Partial<ResourceCounts>): number {
  return RESOURCES.reduce((s, r) => s + Math.max(0, (cost[r] ?? 0) - res[r]), 0);
}

function applyDelta(
  res: ResourceCounts,
  give: Partial<ResourceCounts>,
  recv: Partial<ResourceCounts>
): ResourceCounts {
  const out = { ...res };
  for (const r of RESOURCES) out[r] = out[r] - (give[r] ?? 0) + (recv[r] ?? 0);
  return out;
}

// The build a bot is working toward (a city if it can upgrade, else a settlement).
function goalCost(game: InternalGame, p: PlayerState): Partial<ResourceCounts> {
  const hasSettlement = game.state.buildings.some(
    (b) => b.owner === p.color && b.kind === "settlement"
  );
  return hasSettlement ? BUILD_COSTS.city : BUILD_COSTS.settlement;
}

function byColor(state: GameState, color: PlayerColor): PlayerState {
  return state.players.find((p) => p.color === color)!;
}

function botPlayer(state: GameState): PlayerState | null {
  return state.players[state.currentPlayerIndex] ?? null;
}

// Would this bot benefit from accepting trade `t`? The accepter gives what the
// offerer wants (t.receive) and gets what the offerer gives (t.give). Accept
// only if affordable and it moves the bot strictly closer to its goal build —
// so a bot is never tricked into giving away a resource it needs.
function wantsTrade(game: InternalGame, p: PlayerState, t: TradeOffer): boolean {
  if (t.from === p.color) return false;
  if (t.to && t.to !== p.color) return false;
  const give = t.receive;
  const recv = t.give;
  if (!canAfford(p, give)) return false;
  const cost = goalCost(game, p);
  const before = deficit(p.resources, cost);
  const after = deficit(applyDelta(p.resources, give, recv), cost);
  return after < before;
}

function findBotAccept(game: InternalGame): { color: PlayerColor; tradeId: string } | null {
  const s = game.state;
  if (s.phase !== "main") return null;
  for (const t of s.pendingTrades) {
    for (const p of s.players) {
      if (p.isBot && wantsTrade(game, p, t)) return { color: p.color, tradeId: t.id };
    }
  }
  return null;
}

// Is a bot currently on the clock (its turn, a discard it owes, or a pending
// trade it wants to accept)?
export function botShouldAct(game: InternalGame): boolean {
  const s = game.state;
  if (s.phase === "finished" || s.phase === "lobby") return false;
  if (s.phase === "discard") {
    return s.players.some((p) => p.isBot && (s.pendingDiscards[p.color] ?? 0) > 0);
  }
  if (findBotAccept(game)) return true;
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
    return debtor ? botDiscard(game, debtor) : false;
  }

  // Any bot may accept a beneficial trade, even during another player's turn.
  const acc = findBotAccept(game);
  if (acc) return act(game, acc.color, { type: "accept_trade", tradeId: acc.tradeId });

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

  const victims = new Set<PlayerColor>();
  for (const b of s.buildings) {
    if (b.owner === color) continue;
    if (s.board.vertices[b.vertexId].hexIds.includes(bestHex)) victims.add(b.owner);
  }
  const withCards = [...victims].filter((c) =>
    RESOURCES.some((r) => byColor(s, c).resources[r] > 0)
  );
  const stealFrom = withCards[0] ?? null;
  return act(game, color, { type: "move_robber", hexId: bestHex, stealFrom });
}

// ---- Discard ----

function botDiscard(game: InternalGame, p: PlayerState): boolean {
  const owed = game.state.pendingDiscards[p.color] ?? 0;
  if (owed <= 0) return false;
  const counts = RESOURCES.map((r) => ({ r, n: p.resources[r] })).sort((a, b) => b.n - a.n);
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

// ---- Trading ----

// Offer one surplus card for one needed card when close to the goal build.
function chooseOffer(
  game: InternalGame,
  me: PlayerState
): { give: Partial<ResourceCounts>; receive: Partial<ResourceCounts> } | null {
  const cost = goalCost(game, me);
  if (deficit(me.resources, cost) > 2) return null; // too far off to bother trading
  const needed = RESOURCES.find((r) => (cost[r] ?? 0) > me.resources[r]);
  if (!needed) return null;
  const surplus = RESOURCES.filter(
    (r) => r !== needed && me.resources[r] > (cost[r] ?? 0) && me.resources[r] >= 1
  ).sort((a, b) => me.resources[b] - me.resources[a])[0];
  if (!surplus) return null;
  return { give: { [surplus]: 1 }, receive: { [needed]: 1 } };
}

// Is there a human who could still accept this offer (so it's worth holding open)?
function humanCanAccept(s: GameState, t: { from: PlayerColor; to: PlayerColor | null }): boolean {
  return s.players.some(
    (p) => !p.isBot && p.color !== t.from && (t.to === null || t.to === p.color)
  );
}

// Returns "acted" if it made a trade move (offer/wait), "continue" otherwise.
function handleBotTrade(
  game: InternalGame,
  color: PlayerColor,
  me: PlayerState
): "acted" | "continue" {
  const s = game.state;
  const bt = game.botTrade;

  if (bt && bt.color === color) {
    if (bt.phase === "done") return "continue";
    const trade = s.pendingTrades.find((t) => t.id === bt.tradeId);
    if (!trade) {
      bt.phase = "done"; // accepted or declined — move on
      return "continue";
    }
    const expired = !bt.expiresAt || Date.now() >= bt.expiresAt;
    // Other bots already had their chance (they evaluate every tick). Keep the
    // offer open only while a human could still take it, up to the time limit.
    if (expired || !humanCanAccept(s, trade)) {
      act(game, color, { type: "cancel_trade", tradeId: bt.tradeId });
      bt.phase = "done";
      return "continue";
    }
    return "acted"; // hold the offer open for the human (counts down to expiry)
  }

  const offer = chooseOffer(game, me);
  if (
    offer &&
    act(game, color, { type: "offer_trade", to: null, give: offer.give, receive: offer.receive })
  ) {
    const mine = [...s.pendingTrades].reverse().find((t) => t.from === color);
    const expiresAt = Date.now() + BOT_TRADE_WAIT_MS;
    if (mine) mine.expiresAt = expiresAt; // drives the client's countdown
    game.botTrade = { color, tradeId: mine ? mine.id : "", expiresAt, phase: "open" };
    return "acted";
  }
  // Mark trading as done for this turn so we don't retry every tick.
  game.botTrade = { color, tradeId: "", expiresAt: 0, phase: "done" };
  return "continue";
}

// ---- Main phase: build, trade toward a build, else end the turn ----

function botMain(game: InternalGame, color: PlayerColor): boolean {
  const s = game.state;
  const me = byColor(s, color);

  // Drop any trade state left over from a previous turn.
  if (game.botTrade && game.botTrade.color !== color) game.botTrade = null;

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
  // 3. Trade toward the goal build (offer once, wait briefly for a taker).
  if (handleBotTrade(game, color, me) === "acted") return true;
  // 4. Extend the road network.
  if (canAfford(me, BUILD_COSTS.road)) {
    for (const e of s.board.edges) {
      if (act(game, color, { type: "build_road", edgeId: e.id })) return true;
    }
  }
  // 5. Otherwise bank a development card if flush.
  if (s.devDeckCount > 0 && canAfford(me, BUILD_COSTS.dev_card)) {
    if (act(game, color, { type: "buy_dev_card" })) return true;
  }
  // 6. Nothing useful to do: end the turn.
  game.botTrade = null;
  return act(game, color, { type: "end_turn" });
}
