// Simple greedy AI that drives bot-controlled seats.
// It performs ONE action per call so the scheduler can broadcast between moves,
// giving humans a paced, watchable bot turn. All moves go through applyAction,
// so bots are bound by exactly the same rules as humans.
import {
  BUILD_COSTS,
  RESOURCES,
  COMMODITIES,
  IMPROVEMENT_TRACKS,
  TRACK_COMMODITY,
  MAX_IMPROVEMENT_LEVEL,
  improvementCost,
  KNIGHT_BUILD_COST,
  KNIGHT_ACTIVATE_COST,
  KNIGHT_LIMIT,
  BARBARIAN_TRACK_LENGTH,
  type GameState,
  type ImprovementTrack,
  type KnightPiece,
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
  // Point the setup road toward the most valuable neighbouring crossing, so it
  // already heads toward a future settlement spot.
  const edges = s.board.edges
    .filter((e) => (e.v1 === v || e.v2 === v) && !s.roads.some((r) => r.edgeId === e.id))
    .sort((a, b) => {
      const fa = a.v1 === v ? a.v2 : a.v1;
      const fb = b.v1 === v ? b.v2 : b.v1;
      return vertexValue(s, fb) - vertexValue(s, fa);
    });
  for (const e of edges) {
    if (act(game, color, { type: "place_setup_road", edgeId: e.id })) return true;
  }
  return false;
}

// ---- Road planning ----

function vertexValue(s: GameState, vid: number): number {
  const v = s.board.vertices[vid];
  return v.hexIds.reduce((sum, h) => sum + pip(s.board.hexes[h].number), 0) + (v.port ? 1 : 0);
}

// A vertex where a settlement is legal by the distance rule (ignoring road
// connectivity): nothing built on it or any neighbour.
function settlementLegalFree(s: GameState, vid: number): boolean {
  if (s.buildings.some((b) => b.vertexId === vid)) return false;
  return !s.board.vertices[vid].adjacentVertexIds.some((a) =>
    s.buildings.some((b) => b.vertexId === a)
  );
}

// Vertices touched by the player's roads or buildings — their road network.
function botNetwork(s: GameState, color: PlayerColor): Set<number> {
  const net = new Set<number>();
  for (const rd of s.roads) {
    if (rd.owner !== color) continue;
    const e = s.board.edges[rd.edgeId];
    net.add(e.v1);
    net.add(e.v2);
  }
  for (const b of s.buildings) if (b.owner === color) net.add(b.vertexId);
  return net;
}

function playerHasRoadTo(s: GameState, color: PlayerColor, vid: number): boolean {
  return s.roads.some((rd) => {
    if (rd.owner !== color) return false;
    const e = s.board.edges[rd.edgeId];
    return e.v1 === vid || e.v2 === vid;
  });
}

// Mirrors the engine's road-connectivity rule (for hypothetical placements).
function edgeConnectsBot(s: GameState, color: PlayerColor, edgeId: number): boolean {
  const e = s.board.edges[edgeId];
  for (const vid of [e.v1, e.v2]) {
    const b = s.buildings.find((bb) => bb.vertexId === vid);
    if (b && b.owner === color) return true;
    const blocked = b && b.owner !== color;
    if (!blocked && playerHasRoadTo(s, color, vid)) return true;
  }
  return false;
}

// Pick the next road to build so the network advances toward the best reachable
// high-value free crossing. Runs a 0/1 shortest-path (existing roads are free to
// traverse, empty edges cost one road) from the network and returns the first
// NEW edge on the path to the best target. Returns null if no good target.
function chooseRoadTowardSettlement(s: GameState, color: PlayerColor): number | null {
  const net = botNetwork(s, color);
  if (net.size === 0) return null;

  const edgeBetween = new Map<string, number>();
  for (const e of s.board.edges) {
    const k = e.v1 < e.v2 ? `${e.v1}-${e.v2}` : `${e.v2}-${e.v1}`;
    edgeBetween.set(k, e.id);
  }
  const ownerOfEdge = new Map<number, PlayerColor>();
  for (const rd of s.roads) ownerOfEdge.set(rd.edgeId, rd.owner);
  const oppBuildingAt = (vid: number) =>
    s.buildings.some((b) => b.vertexId === vid && b.owner !== color);

  const MAXDIST = 3;
  const dist = new Map<number, number>();
  const firstEdge = new Map<number, number | undefined>();
  for (const v of net) {
    dist.set(v, 0);
    firstEdge.set(v, undefined);
  }

  const visited = new Set<number>();
  while (true) {
    let u = -1;
    let best = Infinity;
    for (const [v, d] of dist) {
      if (!visited.has(v) && d < best) {
        best = d;
        u = v;
      }
    }
    if (u === -1) break;
    visited.add(u);
    if (best >= MAXDIST) continue;
    if (oppBuildingAt(u) && !net.has(u)) continue; // can't route through a rival town

    for (const w of s.board.vertices[u].adjacentVertexIds) {
      const k = u < w ? `${u}-${w}` : `${w}-${u}`;
      const edgeId = edgeBetween.get(k);
      if (edgeId == null) continue;
      const owner = ownerOfEdge.get(edgeId);
      if (owner && owner !== color) continue; // rival's road blocks the path
      const step = owner === color ? 0 : 1;
      const nd = best + step;
      if (nd > MAXDIST) continue;
      if (nd < (dist.get(w) ?? Infinity)) {
        dist.set(w, nd);
        const fe = firstEdge.get(u);
        firstEdge.set(w, step === 0 ? fe : fe ?? edgeId);
      }
    }
  }

  let bestEdge: number | null = null;
  let bestScore = -Infinity;
  for (const [v, d] of dist) {
    if (d < 1 || d > MAXDIST) continue; // must require at least one new road
    const fe = firstEdge.get(v);
    if (fe == null) continue;
    if (!settlementLegalFree(s, v)) continue;
    const score = vertexValue(s, v) - 0.75 * d; // value, discounted by roads needed
    if (score > bestScore) {
      bestScore = score;
      bestEdge = fe;
    }
  }
  return bestEdge;
}

// Longest contiguous run of the given edge set, respecting rival-town breaks.
function longestForRoads(s: GameState, color: PlayerColor, edgeIds: number[]): number {
  if (edgeIds.length === 0) return 0;
  const adj = new Map<number, { edgeId: number; to: number }[]>();
  const push = (v: number, edgeId: number, to: number) => {
    if (!adj.has(v)) adj.set(v, []);
    adj.get(v)!.push({ edgeId, to });
  };
  for (const id of edgeIds) {
    const e = s.board.edges[id];
    push(e.v1, id, e.v2);
    push(e.v2, id, e.v1);
  }
  const blocked = (vid: number) =>
    s.buildings.some((b) => b.vertexId === vid && b.owner !== color);
  let best = 0;
  const dfs = (v: number, used: Set<number>, len: number) => {
    best = Math.max(best, len);
    for (const { edgeId, to } of adj.get(v) ?? []) {
      if (used.has(edgeId)) continue;
      if (blocked(v)) continue;
      used.add(edgeId);
      dfs(to, used, len + 1);
      used.delete(edgeId);
    }
  };
  for (const v of adj.keys()) dfs(v, new Set(), 0);
  return best;
}

// The connected road that most extends the player's longest road.
function chooseRoadForLongest(
  s: GameState,
  color: PlayerColor
): { edgeId: number; len: number } | null {
  const myIds = s.roads.filter((r) => r.owner === color).map((r) => r.edgeId);
  if (myIds.length === 0) return null;
  const base = longestForRoads(s, color, myIds);
  let best: number | null = null;
  let bestLen = base;
  for (const e of s.board.edges) {
    if (s.roads.some((r) => r.edgeId === e.id)) continue;
    if (!edgeConnectsBot(s, color, e.id)) continue;
    const len = longestForRoads(s, color, [...myIds, e.id]);
    if (len > bestLen) {
      bestLen = len;
      best = e.id;
    }
  }
  return best == null ? null : { edgeId: best, len: bestLen };
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
  // Shed plain resources first, keeping commodities (they buy improvements),
  // but fall back to commodities if resources alone can't cover the debt (C&K).
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
  const comOut: Partial<Record<string, number>> = {};
  if (left > 0 && p.commodities) {
    const cc = COMMODITIES.map((c) => ({ c, n: p.commodities![c] })).sort((a, b) => b.n - a.n);
    for (const { c, n } of cc) {
      if (left <= 0) break;
      const take = Math.min(n, left);
      if (take > 0) {
        comOut[c] = take;
        left -= take;
      }
    }
  }
  return act(game, p.color, {
    type: "discard",
    resources: out,
    commodities: comOut as any,
  });
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
function humanCanAccept(s: GameState, t: TradeOffer): boolean {
  return s.players.some(
    (p) =>
      !p.isBot &&
      p.color !== t.from &&
      (t.to === null || t.to === p.color) &&
      canAfford(p, t.receive) // the human must actually have what's asked for
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

// ---- Cities & Knights: city improvements ----

// The most valuable affordable city improvement to buy now: prefer tracks
// nearest a metropolis (level 4), so commodities turn into victory points and
// don't just pile up to be discarded on a 7.
function chooseImprovement(me: PlayerState): ImprovementTrack | null {
  if (!me.improvements || !me.commodities) return null;
  let best: ImprovementTrack | null = null;
  let bestLevel = -1;
  for (const track of IMPROVEMENT_TRACKS) {
    const level = me.improvements[track];
    if (level >= MAX_IMPROVEMENT_LEVEL) continue;
    const cost = improvementCost(level + 1);
    if (me.commodities[TRACK_COMMODITY[track]] < cost) continue;
    if (level > bestLevel) {
      bestLevel = level;
      best = track;
    }
  }
  return best;
}

// ---- Cities & Knights: knights ----

// Keep bots' knight investment modest so it doesn't starve their economy.
const BOT_KNIGHT_CAP = 3;

function knightAtBot(s: GameState, vertexId: number): KnightPiece | undefined {
  return s.knights?.find((k) => k.vertexId === vertexId);
}

function vertexOccupiedBot(s: GameState, vertexId: number): boolean {
  return s.buildings.some((b) => b.vertexId === vertexId) || !!knightAtBot(s, vertexId);
}

// An empty vertex touching the bot's road network, to deploy a knight.
function knightSpot(s: GameState, color: PlayerColor): number | null {
  for (const v of s.board.vertices) {
    if (vertexOccupiedBot(s, v.id)) continue;
    if (playerHasRoadTo(s, color, v.id)) return v.id;
  }
  return null;
}

// If the robber sits on one of the bot's producing tiles and it has an active
// knight next to it, chase the robber away. Returns true if it acted.
function botChaseRobber(game: InternalGame, color: PlayerColor): boolean {
  const s = game.state;
  if (!s.knights) return false;
  const robberHex = s.board.robberHexId;
  const hurtsMe = s.buildings.some(
    (b) => b.owner === color && s.board.vertices[b.vertexId].hexIds.includes(robberHex)
  );
  if (!hurtsMe) return false;
  const knight = s.knights.find(
    (k) => k.owner === color && k.active && s.board.vertices[k.vertexId].hexIds.includes(robberHex)
  );
  if (!knight) return false;
  if (!act(game, color, { type: "knight_chase_robber", vertexId: knight.vertexId })) return false;
  // Follow through: relocate the robber to hurt an opponent instead.
  return botMoveRobber(game, color) || true;
}

// The barbarians are nearly here: get knights active (or raise one) to defend.
function botBarbarianDefense(game: InternalGame, color: PlayerColor, me: PlayerState): boolean {
  const s = game.state;
  if (s.variant !== "cities_and_knights") return false;
  const step = s.barbarianStep ?? 0;
  if (step < BARBARIAN_TRACK_LENGTH - 2) return false; // only act when imminent
  const mine = (s.knights ?? []).filter((k) => k.owner === color);
  const idle = mine.find((k) => !k.active);
  if (idle && canAfford(me, KNIGHT_ACTIVATE_COST)) {
    if (act(game, color, { type: "activate_knight", vertexId: idle.vertexId })) return true;
  }
  if (mine.length < BOT_KNIGHT_CAP && mine.length < KNIGHT_LIMIT && canAfford(me, KNIGHT_BUILD_COST)) {
    const spot = knightSpot(s, color);
    if (spot != null && act(game, color, { type: "build_knight", vertexId: spot })) return true;
  }
  return false;
}

// Deploy/activate a knight when flush, up to a small cap. Returns true if acted.
function botKnightUpkeep(game: InternalGame, color: PlayerColor, me: PlayerState): boolean {
  const s = game.state;
  if (s.variant !== "cities_and_knights") return false;
  const mine = (s.knights ?? []).filter((k) => k.owner === color);
  // Activate an idle knight so it can defend/chase later.
  const idle = mine.find((k) => !k.active);
  if (idle && canAfford(me, KNIGHT_ACTIVATE_COST)) {
    if (act(game, color, { type: "activate_knight", vertexId: idle.vertexId })) return true;
  }
  // Recruit a knight if under the cap and it won't be needed for a city.
  if (mine.length < BOT_KNIGHT_CAP && mine.length < KNIGHT_LIMIT && canAfford(me, KNIGHT_BUILD_COST)) {
    const spot = knightSpot(s, color);
    if (spot != null && act(game, color, { type: "build_knight", vertexId: spot })) return true;
  }
  return false;
}

// ---- Main phase: build, trade toward a build, else end the turn ----

function botMain(game: InternalGame, color: PlayerColor): boolean {
  const s = game.state;
  const me = byColor(s, color);

  // Drop any trade state left over from a previous turn.
  if (game.botTrade && game.botTrade.color !== color) game.botTrade = null;

  // 0. C&K: chase a robber sitting on our tile with an adjacent active knight.
  if (botChaseRobber(game, color)) return true;

  // 0a. C&K: rally knights when the barbarian ship is about to land.
  if (botBarbarianDefense(game, color, me)) return true;

  // 0b. C&K: spend commodities on city improvements (metropolis = +2 VP).
  const track = chooseImprovement(me);
  if (track && act(game, color, { type: "buy_improvement", track })) return true;

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
  // 4. Build roads with a purpose: head toward the best reachable high-value
  //    crossing for a future settlement; otherwise extend the longest road when
  //    that's realistic. Don't build aimless roads.
  if (canAfford(me, BUILD_COSTS.road)) {
    let edgeId = chooseRoadTowardSettlement(s, color);
    if (edgeId == null) {
      const lr = chooseRoadForLongest(s, color);
      if (lr && lr.len >= 3) edgeId = lr.edgeId; // chase Longest Road when within reach
    }
    if (edgeId != null && act(game, color, { type: "build_road", edgeId })) return true;
  }
  // 4b. C&K: keep a knight or two deployed and active (cheap standing defense).
  if (botKnightUpkeep(game, color, me)) return true;
  // 5. Otherwise bank a development card if flush.
  if (s.devDeckCount > 0 && canAfford(me, BUILD_COSTS.dev_card)) {
    if (act(game, color, { type: "buy_dev_card" })) return true;
  }
  // 6. Nothing useful to do: end the turn.
  game.botTrade = null;
  return act(game, color, { type: "end_turn" });
}
