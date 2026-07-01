// Server-authoritative base-game rule engine.
// Operates on a GameState plus a hidden dev-card deck.
import {
  BUILD_COSTS,
  PIECE_LIMITS,
  MAX_HAND_BEFORE_DISCARD,
  RESOURCES,
  COMMODITIES,
  VICTORY_POINTS_TO_WIN,
  CK_VICTORY_POINTS_TO_WIN,
  MAX_IMPROVEMENT_LEVEL,
  METROPOLIS_LEVEL,
  IMPROVEMENT_TRACKS,
  TRACK_COMMODITY,
  TERRAIN_COMMODITY,
  improvementCost,
  KNIGHT_LIMIT,
  KNIGHT_MAX_RANK,
  MIGHTY_KNIGHT_POLITICS_LEVEL,
  KNIGHT_BUILD_COST,
  KNIGHT_PROMOTE_COST,
  KNIGHT_ACTIVATE_COST,
  KNIGHT_RANK_NAME,
  BARBARIAN_TRACK_LENGTH,
  PROGRESS_DECK,
  PROGRESS_CARD_COPIES,
  PROGRESS_HAND_LIMIT,
  PROGRESS_CARD_INFO,
  CITY_WALL_COST,
  CITY_WALL_HAND_BONUS,
  MAX_CITY_WALLS,
  buildDevDeck,
  generateBoard,
  mulberry32,
  shuffle,
  type Board,
  type Commodity,
  type CommodityCounts,
  type DevCardKind,
  type EventDie,
  type GameState,
  type GameVariant,
  type ImprovementLevels,
  type ImprovementTrack,
  type KnightPiece,
  type KnightRank,
  type PlayerColor,
  type PlayerState,
  type ProgressCardKind,
  type Resource,
  type ResourceCounts,
  type ClientMessage,
} from "@settlers/shared";

export interface InternalGame {
  state: GameState;
  devDeck: DevCardKind[];
  /** C&K: the three hidden progress-card decks (contents server-side only). */
  progressDecks?: Record<ImprovementTrack, ProgressCardKind[]>;
  seed: number;
  /** Total setup placements made (used to drive snake order + termination). */
  setupPlaced: number;
  /** Bot-only: trade state for the current bot's turn (server-side only). */
  botTrade?: {
    color: PlayerColor;
    tradeId: string;
    expiresAt: number;
    phase: "open" | "done";
  } | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

interface SeatInput {
  userId: string;
  name: string;
  color: PlayerColor;
  isBot?: boolean;
}

function emptyResources(): ResourceCounts {
  return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
}

function emptyCommodities(): CommodityCounts {
  return { coin: 0, paper: 0, cloth: 0 };
}

function emptyImprovements(): ImprovementLevels {
  return { trade: 0, politics: 0, science: 0 };
}

function buildProgressDecks(rng: () => number): Record<ImprovementTrack, ProgressCardKind[]> {
  const make = (track: ImprovementTrack) => {
    const cards: ProgressCardKind[] = [];
    for (const k of PROGRESS_DECK[track])
      for (let i = 0; i < PROGRESS_CARD_COPIES; i++) cards.push(k);
    return shuffle(cards, rng);
  };
  return { trade: make("trade"), politics: make("politics"), science: make("science") };
}

export function createGame(
  id: string,
  seed: number,
  seats: SeatInput[],
  variant: GameVariant = "base"
): InternalGame {
  const board: Board = generateBoard(seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const ck = variant === "cities_and_knights";
  // C&K replaces the development deck entirely with the three progress decks.
  const devDeck = ck ? [] : buildDevDeck(rng);
  const progressDecks = ck ? buildProgressDecks(rng) : undefined;

  const players: PlayerState[] = seats.map((s) => ({
    userId: s.userId,
    name: s.name,
    color: s.color,
    connected: !!s.isBot, // bots are always "present"
    isBot: !!s.isBot,
    resources: emptyResources(),
    devCards: [],
    newDevCards: [],
    playedKnights: 0,
    victoryPointCards: 0,
    hasPlayedDevCardThisTurn: false,
    ...(ck
      ? {
          commodities: emptyCommodities(),
          improvements: emptyImprovements(),
          defenderTokens: 0,
          progressCards: [],
          cityWalls: 0,
        }
      : {}),
  }));

  const state: GameState = {
    id,
    variant,
    phase: "setup",
    board,
    players,
    currentPlayerIndex: 0,
    setupDirection: 1,
    setupStep: "settlement",
    pendingSetupVertex: null,
    dice: null,
    buildings: [],
    roads: [],
    devDeckCount: devDeck.length,
    pendingTrades: [],
    pendingDiscards: {},
    largestArmyOwner: null,
    longestRoadOwner: null,
    winner: null,
    log: ["Game started. Place your first settlement."],
    freeRoadsRemaining: 0,
    ...(ck
      ? {
          metropolisOwner: { trade: null, politics: null, science: null },
          knights: [],
          eventDie: null,
          barbarianStep: 0,
          merchantOwner: null,
          progressDeckCounts: {
            trade: progressDecks!.trade.length,
            politics: progressDecks!.politics.length,
            science: progressDecks!.science.length,
          },
        }
      : {}),
    updatedAt: Date.now(),
  };

  return { state, devDeck, progressDecks, seed, setupPlaced: 0, botTrade: null };
}

// ---- Helpers ----

function currentPlayer(state: GameState): PlayerState {
  return state.players[state.currentPlayerIndex];
}

function playerByColor(state: GameState, color: PlayerColor): PlayerState | undefined {
  return state.players.find((p) => p.color === color);
}

function log(state: GameState, msg: string) {
  state.log.push(msg);
  if (state.log.length > 200) state.log.shift();
}

function totalResources(p: PlayerState): number {
  return RESOURCES.reduce((s, r) => s + p.resources[r], 0);
}

function canAfford(p: PlayerState, cost: Partial<ResourceCounts>): boolean {
  return Object.entries(cost).every(
    ([r, n]) => p.resources[r as Resource] >= (n ?? 0)
  );
}

function pay(p: PlayerState, cost: Partial<ResourceCounts>) {
  for (const [r, n] of Object.entries(cost)) {
    p.resources[r as Resource] -= n ?? 0;
  }
}

function grant(p: PlayerState, gain: Partial<ResourceCounts>) {
  for (const [r, n] of Object.entries(gain)) {
    p.resources[r as Resource] += n ?? 0;
  }
}

// ---- Cities & Knights helpers ----

function isCK(state: GameState): boolean {
  return state.variant === "cities_and_knights";
}

function totalCommodities(p: PlayerState): number {
  if (!p.commodities) return 0;
  return COMMODITIES.reduce((s, c) => s + (p.commodities![c] ?? 0), 0);
}

// Total cards that count toward the 7-card discard limit (commodities too in C&K).
function handSize(p: PlayerState): number {
  return totalResources(p) + totalCommodities(p);
}

// Ensure each track's metropolis marker sits on exactly one CITY of its owner.
// A metropolis is always a city — never a settlement — so if the owner has no
// city yet the marker is deferred until they build one (their VP still counts).
function syncMetropolisMarkers(state: GameState) {
  if (!state.metropolisOwner) return;
  for (const track of IMPROVEMENT_TRACKS) {
    const owner = state.metropolisOwner[track];
    // Clear stale markers: wrong owner, no owner, or sitting on a settlement.
    for (const b of state.buildings) {
      if (b.metropolis === track && (!owner || b.owner !== owner || b.kind !== "city"))
        delete b.metropolis;
    }
    if (!owner) continue;
    if (state.buildings.some((b) => b.metropolis === track && b.owner === owner)) continue;
    // Place it on one of the owner's cities that isn't already a metropolis.
    const city = state.buildings.find(
      (b) => b.owner === owner && b.kind === "city" && !b.metropolis
    );
    if (city) city.metropolis = track;
  }
}

// Recompute which player owns each track's metropolis: the player with the
// strictly highest level >= METROPOLIS_LEVEL, keeping the current holder on ties
// (first-to-reach keeps it until someone strictly surpasses them).
function updateMetropolis(state: GameState, track: ImprovementTrack) {
  if (!state.metropolisOwner) return;
  const current = state.metropolisOwner[track];
  const currentLevel = current
    ? playerByColor(state, current)?.improvements?.[track] ?? 0
    : -1;
  let owner = current && currentLevel >= METROPOLIS_LEVEL ? current : null;
  let bestLevel = owner ? currentLevel : -1;
  for (const p of state.players) {
    const lvl = p.improvements?.[track] ?? 0;
    if (lvl >= METROPOLIS_LEVEL && lvl > bestLevel) {
      bestLevel = lvl;
      owner = p.color;
    }
  }
  if (owner !== current) {
    state.metropolisOwner[track] = owner;
    if (owner) log(state, `${nameOf(state, owner)} built the ${track} metropolis (+2 VP).`);
  }
  syncMetropolisMarkers(state);
}

// Settlements give 1 VP, cities 2, plus dev-card VPs and bonuses.
export function victoryPoints(state: GameState, color: PlayerColor): number {
  let vp = 0;
  for (const b of state.buildings) {
    if (b.owner === color) vp += b.kind === "city" ? 2 : 1;
  }
  const p = playerByColor(state, color);
  if (p) vp += p.victoryPointCards;
  if (state.largestArmyOwner === color) vp += 2;
  if (state.longestRoadOwner === color) vp += 2;
  // C&K: each metropolis is worth 2 victory points.
  if (state.metropolisOwner) {
    for (const track of IMPROVEMENT_TRACKS) {
      if (state.metropolisOwner[track] === color) vp += 2;
    }
  }
  // C&K: Defender of Catan tokens are worth 1 VP each.
  if (p?.defenderTokens) vp += p.defenderTokens;
  // C&K: the Merchant is worth 1 VP to whoever holds it.
  if (state.merchantOwner === color) vp += 1;
  return vp;
}

// A player's discard threshold: 7, raised by city walls in C&K.
function discardLimit(p: PlayerState): number {
  return MAX_HAND_BEFORE_DISCARD + CITY_WALL_HAND_BONUS * (p.cityWalls ?? 0);
}

// The victory-point target for this game (13 in C&K, 10 in the base game).
function winTarget(state: GameState): number {
  return isCK(state) ? CK_VICTORY_POINTS_TO_WIN : VICTORY_POINTS_TO_WIN;
}

function vertexFree(state: GameState, vertexId: number): boolean {
  // No building on it and no building on adjacent vertices (distance rule).
  if (state.buildings.some((b) => b.vertexId === vertexId)) return false;
  const v = state.board.vertices[vertexId];
  for (const adj of v.adjacentVertexIds) {
    if (state.buildings.some((b) => b.vertexId === adj)) return false;
  }
  return true;
}

function playerOwnsRoadTo(state: GameState, color: PlayerColor, vertexId: number): boolean {
  return state.roads.some((rd) => {
    if (rd.owner !== color) return false;
    const e = state.board.edges[rd.edgeId];
    return e.v1 === vertexId || e.v2 === vertexId;
  });
}

function edgeConnectsToNetwork(
  state: GameState,
  color: PlayerColor,
  edgeId: number
): boolean {
  const e = state.board.edges[edgeId];
  for (const vid of [e.v1, e.v2]) {
    // Connected if player has a building here...
    const b = state.buildings.find((b) => b.vertexId === vid);
    if (b && b.owner === color) return true;
    // ...or another of their roads touches this vertex (and it isn't blocked
    // by an opponent's building).
    const blocked = b && b.owner !== color;
    if (!blocked && playerOwnsRoadTo(state, color, vid)) return true;
  }
  return false;
}

// ---- Longest road (DFS over each player's road graph) ----

function longestRoadLength(state: GameState, color: PlayerColor): number {
  const myEdges = state.roads
    .filter((r) => r.owner === color)
    .map((r) => state.board.edges[r.edgeId]);
  if (myEdges.length === 0) return 0;

  // Adjacency: vertex -> list of {edgeId, otherVertex}
  const adj = new Map<number, { edgeId: number; to: number }[]>();
  for (const e of myEdges) {
    if (!adj.has(e.v1)) adj.set(e.v1, []);
    if (!adj.has(e.v2)) adj.set(e.v2, []);
    adj.get(e.v1)!.push({ edgeId: e.id, to: e.v2 });
    adj.get(e.v2)!.push({ edgeId: e.id, to: e.v1 });
  }

  // A path can't pass *through* a vertex occupied by an opponent's building.
  const blockedVertex = (vid: number) =>
    state.buildings.some((b) => b.vertexId === vid && b.owner !== color);

  let best = 0;
  const dfs = (v: number, used: Set<number>, len: number) => {
    best = Math.max(best, len);
    for (const { edgeId, to } of adj.get(v) ?? []) {
      if (used.has(edgeId)) continue;
      if (blockedVertex(v)) continue; // can't route through opponent's town
      used.add(edgeId);
      dfs(to, used, len + 1);
      used.delete(edgeId);
    }
  };
  for (const start of adj.keys()) dfs(start, new Set(), 0);
  return best;
}

function updateLongestRoad(state: GameState) {
  let leader = state.longestRoadOwner;
  let leaderLen = leader ? longestRoadLength(state, leader) : 0;
  // Current holder loses it if their road drops below 5.
  if (leader && leaderLen < 5) {
    leader = null;
    leaderLen = 0;
  }
  for (const p of state.players) {
    const len = longestRoadLength(state, p.color);
    if (len >= 5 && len > leaderLen) {
      leader = p.color;
      leaderLen = len;
    }
  }
  if (leader !== state.longestRoadOwner) {
    state.longestRoadOwner = leader;
    if (leader) log(state, `${nameOf(state, leader)} takes the Longest Road.`);
  }
}

function updateLargestArmy(state: GameState) {
  let leader = state.largestArmyOwner;
  let leaderCount = leader ? playerByColor(state, leader)!.playedKnights : 0;
  for (const p of state.players) {
    if (p.playedKnights >= 3 && p.playedKnights > leaderCount) {
      leader = p.color;
      leaderCount = p.playedKnights;
    }
  }
  if (leader !== state.largestArmyOwner) {
    state.largestArmyOwner = leader;
    if (leader) log(state, `${nameOf(state, leader)} takes the Largest Army.`);
  }
}

function nameOf(state: GameState, color: PlayerColor): string {
  return playerByColor(state, color)?.name ?? color;
}

function checkWin(state: GameState) {
  const cur = currentPlayer(state);
  if (victoryPoints(state, cur.color) >= winTarget(state)) {
    state.phase = "finished";
    state.winner = cur.color;
    log(state, `${cur.name} wins the game!`);
  }
}

// ---- Main action dispatch ----

export function applyAction(
  game: InternalGame,
  color: PlayerColor,
  msg: ClientMessage
): ActionResult {
  const { state } = game;
  if (state.phase === "finished") return fail("The game is over.");

  const actor = playerByColor(state, color);
  if (!actor) return fail("You are not in this game.");

  const isCurrent = currentPlayer(state).color === color;

  try {
    switch (msg.type) {
      case "place_setup_settlement":
        return setupSettlement(game, color, msg.vertexId, isCurrent);
      case "place_setup_road":
        return setupRoad(game, color, msg.edgeId, isCurrent);
      case "roll_dice":
        return rollDice(game, color, isCurrent);
      case "build_road":
        return buildRoad(game, color, msg.edgeId, isCurrent);
      case "build_settlement":
        return buildSettlement(game, color, msg.vertexId, isCurrent);
      case "build_city":
        return buildCity(game, color, msg.vertexId, isCurrent);
      case "buy_dev_card":
        return buyDevCard(game, color, isCurrent);
      case "play_knight":
        return playKnight(game, color, isCurrent);
      case "play_road_building":
        return playRoadBuilding(game, color, isCurrent);
      case "play_year_of_plenty":
        return playYearOfPlenty(game, color, msg.resources, isCurrent);
      case "play_monopoly":
        return playMonopoly(game, color, msg.resource, isCurrent);
      case "move_robber":
        return moveRobber(game, color, msg.hexId, msg.stealFrom, isCurrent);
      case "discard":
        return discard(game, color, msg.resources, msg.commodities);
      case "buy_improvement":
        return buyImprovement(game, color, msg.track, isCurrent);
      case "build_knight":
        return buildKnight(game, color, msg.vertexId, isCurrent);
      case "activate_knight":
        return activateKnight(game, color, msg.vertexId, isCurrent);
      case "promote_knight":
        return promoteKnight(game, color, msg.vertexId, isCurrent);
      case "move_knight":
        return moveKnight(game, color, msg.fromVertexId, msg.toVertexId, isCurrent);
      case "knight_chase_robber":
        return knightChaseRobber(game, color, msg.vertexId, isCurrent);
      case "play_progress_card":
        return playProgressCard(game, color, msg, isCurrent);
      case "build_city_wall":
        return buildCityWall(game, color, msg.vertexId, isCurrent);
      case "bank_trade":
        return bankTrade(game, color, msg.give, msg.receive, isCurrent);
      case "offer_trade":
        return offerTrade(game, color, msg.to, msg.give, msg.receive, isCurrent);
      case "accept_trade":
        return acceptTrade(game, color, msg.tradeId);
      case "cancel_trade":
        return cancelTrade(game, color, msg.tradeId);
      case "decline_trade":
        return declineTrade(game, color, msg.tradeId);
      case "end_turn":
        return endTurn(game, color, isCurrent);
      default:
        return fail("Unknown or unsupported action.");
    }
  } finally {
    state.updatedAt = Date.now();
  }
}

function fail(error: string): ActionResult {
  return { ok: false, error };
}
function ok(): ActionResult {
  return { ok: true };
}

// ---- Setup phase ----

function setupSettlement(
  game: InternalGame,
  color: PlayerColor,
  vertexId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  if (state.phase !== "setup") return fail("Not in setup phase.");
  if (!isCurrent) return fail("Not your turn.");
  if (state.setupStep !== "settlement") return fail("Place a road, not a settlement.");
  if (vertexId < 0 || vertexId >= state.board.vertices.length)
    return fail("Invalid vertex.");
  if (!vertexFree(state, vertexId)) return fail("Too close to another settlement.");

  state.buildings.push({ kind: "settlement", owner: color, vertexId });
  state.pendingSetupVertex = vertexId;
  state.setupStep = "road";

  // On the second placement (snake's return leg), collect starting resources.
  if (state.setupDirection === -1) {
    const v = state.board.vertices[vertexId];
    for (const hid of v.hexIds) {
      const hex = state.board.hexes[hid];
      if (hex.terrain !== "desert") {
        currentPlayer(state).resources[hex.terrain as Resource] += 1;
      }
    }
  }
  log(state, `${nameOf(state, color)} placed a settlement.`);
  return ok();
}

function setupRoad(
  game: InternalGame,
  color: PlayerColor,
  edgeId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  if (state.phase !== "setup") return fail("Not in setup phase.");
  if (!isCurrent) return fail("Not your turn.");
  if (state.setupStep !== "road") return fail("Place a settlement first.");
  if (edgeId < 0 || edgeId >= state.board.edges.length) return fail("Invalid edge.");
  if (state.roads.some((r) => r.edgeId === edgeId)) return fail("Edge taken.");
  const e = state.board.edges[edgeId];
  if (e.v1 !== state.pendingSetupVertex && e.v2 !== state.pendingSetupVertex)
    return fail("Road must connect to the settlement you just placed.");

  state.roads.push({ owner: color, edgeId });
  state.pendingSetupVertex = null;
  state.setupStep = "settlement";
  game.setupPlaced += 1;
  log(state, `${nameOf(state, color)} placed a road.`);

  advanceSetup(game);
  return ok();
}

function advanceSetup(game: InternalGame) {
  const { state } = game;
  const n = state.players.length;
  const totalNeeded = n * 2;

  if (game.setupPlaced >= totalNeeded) {
    // Setup complete -> first player's turn, rolling phase.
    state.phase = "rolling";
    state.setupStep = null;
    state.currentPlayerIndex = 0;
    log(state, `Setup complete. ${currentPlayer(state).name} to roll.`);
    return;
  }

  if (state.setupDirection === 1) {
    if (game.setupPlaced === n) {
      // Reached the end of the forward leg; same player goes again backward.
      state.setupDirection = -1;
      log(state, "Second placement round (reverse order).");
    } else {
      state.currentPlayerIndex += 1;
    }
  } else {
    state.currentPlayerIndex -= 1;
  }
}

// ---- Dice & production ----

function rollDice(game: InternalGame, color: PlayerColor, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (state.phase !== "rolling") return fail("You can't roll right now.");
  if (!isCurrent) return fail("Not your turn.");

  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  state.dice = [d1, d2];
  const sum = d1 + d2;
  log(state, `${nameOf(state, color)} rolled ${sum} (${d1}+${d2}).`);

  // C&K: the event die (barbarians / improvement gates) resolves first.
  if (isCK(state)) {
    resolveEventDie(game);
    checkWin(state); // a Defender token may push the roller to the win target
    if (state.winner) return ok();
  }

  if (sum === 7) {
    // Robber: everyone with >7 cards discards half (rounded down).
    state.pendingDiscards = {};
    for (const p of state.players) {
      const total = handSize(p);
      if (total > discardLimit(p)) {
        state.pendingDiscards[p.color] = Math.floor(total / 2);
      }
    }
    if (Object.keys(state.pendingDiscards).length > 0) {
      state.phase = "discard";
      log(state, "A 7! Players over 7 cards must discard.");
    } else {
      state.phase = "moving_robber";
    }
    return ok();
  }

  distributeResources(state, sum);
  state.phase = "main";
  return ok();
}

function distributeResources(state: GameState, sum: number) {
  const ck = isCK(state);
  for (const hex of state.board.hexes) {
    if (hex.number !== sum) continue;
    if (hex.id === state.board.robberHexId) continue;
    if (hex.terrain === "desert") continue;
    const commodity: Commodity | undefined = TERRAIN_COMMODITY[hex.terrain];
    for (const b of state.buildings) {
      const v = state.board.vertices[b.vertexId];
      if (!v.hexIds.includes(hex.id)) continue;
      const p = playerByColor(state, b.owner)!;
      if (b.kind === "settlement") {
        p.resources[hex.terrain as Resource] += 1;
      } else if (ck && commodity) {
        // C&K city on a commodity terrain: 1 base resource + 1 commodity.
        p.resources[hex.terrain as Resource] += 1;
        if (p.commodities) p.commodities[commodity] += 1;
      } else {
        // City on brick/grain (or any city in the base game): 2 base resources.
        p.resources[hex.terrain as Resource] += 2;
      }
    }
  }
}

// ---- Building ----

function buildRoad(game: InternalGame, color: PlayerColor, edgeId: number, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("You can't build right now.");
  if (!isCurrent) return fail("Not your turn.");
  if (edgeId < 0 || edgeId >= state.board.edges.length) return fail("Invalid edge.");
  if (state.roads.some((r) => r.edgeId === edgeId)) return fail("Edge taken.");

  const actor = playerByColor(state, color)!;
  const owned = state.roads.filter((r) => r.owner === color).length;
  if (owned >= PIECE_LIMITS.roads) return fail("No roads left to build.");
  if (!edgeConnectsToNetwork(state, color, edgeId))
    return fail("Road must connect to your network.");

  const free = state.freeRoadsRemaining > 0;
  if (!free) {
    if (!canAfford(actor, BUILD_COSTS.road)) return fail("Not enough resources.");
    pay(actor, BUILD_COSTS.road);
  } else {
    state.freeRoadsRemaining -= 1;
  }

  state.roads.push({ owner: color, edgeId });
  log(state, `${actor.name} built a road.`);
  updateLongestRoad(state);
  checkWin(state);
  return ok();
}

function buildSettlement(game: InternalGame, color: PlayerColor, vertexId: number, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("You can't build right now.");
  if (!isCurrent) return fail("Not your turn.");
  if (vertexId < 0 || vertexId >= state.board.vertices.length) return fail("Invalid vertex.");
  if (!vertexFree(state, vertexId)) return fail("Too close to another building.");
  if (knightAt(state, vertexId)) return fail("A knight occupies that spot.");
  if (!playerOwnsRoadTo(state, color, vertexId))
    return fail("Settlement must connect to one of your roads.");

  const actor = playerByColor(state, color)!;
  const owned = state.buildings.filter((b) => b.owner === color && b.kind === "settlement").length;
  if (owned >= PIECE_LIMITS.settlements) return fail("No settlements left.");
  if (!canAfford(actor, BUILD_COSTS.settlement)) return fail("Not enough resources.");

  pay(actor, BUILD_COSTS.settlement);
  state.buildings.push({ kind: "settlement", owner: color, vertexId });
  log(state, `${actor.name} built a settlement.`);
  updateLongestRoad(state); // a settlement can split an opponent's road
  checkWin(state);
  return ok();
}

function buildCity(game: InternalGame, color: PlayerColor, vertexId: number, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("You can't build right now.");
  if (!isCurrent) return fail("Not your turn.");
  const existing = state.buildings.find((b) => b.vertexId === vertexId);
  if (!existing || existing.owner !== color || existing.kind !== "settlement")
    return fail("You can only upgrade your own settlement.");

  const actor = playerByColor(state, color)!;
  const cities = state.buildings.filter((b) => b.owner === color && b.kind === "city").length;
  if (cities >= PIECE_LIMITS.cities) return fail("No cities left.");
  if (!canAfford(actor, BUILD_COSTS.city)) return fail("Not enough resources.");

  pay(actor, BUILD_COSTS.city);
  existing.kind = "city";
  log(state, `${actor.name} upgraded to a city.`);
  // A new city can host a metropolis the owner earned earlier but couldn't place.
  if (isCK(state)) syncMetropolisMarkers(state);
  checkWin(state);
  return ok();
}

// ---- Cities & Knights: city improvements ----

function buyImprovement(
  game: InternalGame,
  color: PlayerColor,
  track: ImprovementTrack,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  if (!isCK(state)) return fail("City improvements are a Cities & Knights feature.");
  if (state.phase !== "main") return fail("Improve your cities during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  if (!IMPROVEMENT_TRACKS.includes(track)) return fail("Unknown improvement track.");

  const actor = playerByColor(state, color)!;
  if (!actor.improvements || !actor.commodities) return fail("Improvements unavailable.");
  const level = actor.improvements[track];
  if (level >= MAX_IMPROVEMENT_LEVEL) return fail("That track is already maxed out.");

  const commodity: Commodity = TRACK_COMMODITY[track];
  // The Crane progress card shaves 1 commodity off the next improvement.
  const cost = Math.max(0, improvementCost(level + 1) - (actor.craneTurn ? 1 : 0));
  if (actor.commodities[commodity] < cost)
    return fail(`Need ${cost} ${commodity} to reach level ${level + 1}.`);

  actor.commodities[commodity] -= cost;
  if (actor.craneTurn) actor.craneTurn = false;
  actor.improvements[track] = level + 1;
  log(state, `${actor.name} advanced ${track} to level ${level + 1}.`);
  if (level + 1 >= METROPOLIS_LEVEL) updateMetropolis(state, track);
  checkWin(state);
  return ok();
}

// ---- Cities & Knights: knights ----

function knightAt(state: GameState, vertexId: number): KnightPiece | undefined {
  return state.knights?.find((k) => k.vertexId === vertexId);
}

// A vertex is occupied if it holds a building or a knight.
function vertexOccupied(state: GameState, vertexId: number): boolean {
  return (
    state.buildings.some((b) => b.vertexId === vertexId) || !!knightAt(state, vertexId)
  );
}

// Does the player have a road touching this vertex? (knight placement rule)
function ownRoadTouches(state: GameState, color: PlayerColor, vertexId: number): boolean {
  return state.roads.some((rd) => {
    if (rd.owner !== color) return false;
    const e = state.board.edges[rd.edgeId];
    return e.v1 === vertexId || e.v2 === vertexId;
  });
}

// Vertices reachable from `from` along the player's own roads. Intermediate
// vertices must be empty to pass through; a vertex holding a piece is reachable
// but terminal (you can end on a weaker enemy knight to displace it).
function knightReach(
  state: GameState,
  color: PlayerColor,
  from: number
): Set<number> {
  const reach = new Set<number>();
  const edgeBetween = new Map<string, number>();
  for (const e of state.board.edges) {
    const k = e.v1 < e.v2 ? `${e.v1}-${e.v2}` : `${e.v2}-${e.v1}`;
    edgeBetween.set(k, e.id);
  }
  const ownRoad = (a: number, b: number) => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    const id = edgeBetween.get(k);
    return id != null && state.roads.some((r) => r.owner === color && r.edgeId === id);
  };
  const queue = [from];
  const seen = new Set<number>([from]);
  while (queue.length) {
    const u = queue.shift()!;
    for (const w of state.board.vertices[u].adjacentVertexIds) {
      if (!ownRoad(u, w)) continue;
      if (!reach.has(w)) reach.add(w);
      // Can only continue through empty, unseen vertices.
      if (!seen.has(w) && !vertexOccupied(state, w)) {
        seen.add(w);
        queue.push(w);
      }
    }
  }
  reach.delete(from);
  return reach;
}

function requireCK(state: GameState): ActionResult | null {
  if (!isCK(state)) return fail("Knights are a Cities & Knights feature.");
  if (!state.knights) state.knights = [];
  return null;
}

function buildKnight(
  game: InternalGame,
  color: PlayerColor,
  vertexId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  const guard = requireCK(state);
  if (guard) return guard;
  if (state.phase !== "main") return fail("Build knights during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  if (vertexId < 0 || vertexId >= state.board.vertices.length) return fail("Invalid vertex.");
  if (vertexOccupied(state, vertexId)) return fail("That spot is taken.");
  if (!ownRoadTouches(state, color, vertexId))
    return fail("A knight must connect to your road network.");

  const actor = playerByColor(state, color)!;
  const owned = state.knights!.filter((k) => k.owner === color).length;
  if (owned >= KNIGHT_LIMIT) return fail("You have no knights left to deploy.");
  if (!canAfford(actor, KNIGHT_BUILD_COST)) return fail("Not enough resources.");

  pay(actor, KNIGHT_BUILD_COST);
  state.knights!.push({ owner: color, vertexId, rank: 1, active: false });
  log(state, `${actor.name} recruited a knight.`);
  return ok();
}

function activateKnight(
  game: InternalGame,
  color: PlayerColor,
  vertexId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  const guard = requireCK(state);
  if (guard) return guard;
  if (state.phase !== "main") return fail("Activate knights during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const knight = knightAt(state, vertexId);
  if (!knight || knight.owner !== color) return fail("That isn't your knight.");
  if (knight.active) return fail("That knight is already active.");

  const actor = playerByColor(state, color)!;
  if (!canAfford(actor, KNIGHT_ACTIVATE_COST)) return fail("Need 1 grain to activate.");
  pay(actor, KNIGHT_ACTIVATE_COST);
  knight.active = true;
  log(state, `${actor.name} activated a knight.`);
  return ok();
}

function promoteKnight(
  game: InternalGame,
  color: PlayerColor,
  vertexId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  const guard = requireCK(state);
  if (guard) return guard;
  if (state.phase !== "main") return fail("Promote knights during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const knight = knightAt(state, vertexId);
  if (!knight || knight.owner !== color) return fail("That isn't your knight.");
  if (knight.rank >= KNIGHT_MAX_RANK) return fail("That knight is already Mighty.");

  const actor = playerByColor(state, color)!;
  // Promoting to Mighty (rank 3) needs a Fortress (Politics level 3).
  if (knight.rank + 1 >= KNIGHT_MAX_RANK) {
    const politics = actor.improvements?.politics ?? 0;
    if (politics < MIGHTY_KNIGHT_POLITICS_LEVEL)
      return fail("Reach Politics level 3 to train Mighty knights.");
  }
  if (!canAfford(actor, KNIGHT_PROMOTE_COST)) return fail("Not enough resources.");

  pay(actor, KNIGHT_PROMOTE_COST);
  knight.rank = (knight.rank + 1) as KnightRank;
  log(state, `${actor.name} promoted a knight to ${KNIGHT_RANK_NAME[knight.rank]}.`);
  return ok();
}

function moveKnight(
  game: InternalGame,
  color: PlayerColor,
  fromVertexId: number,
  toVertexId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  const guard = requireCK(state);
  if (guard) return guard;
  if (state.phase !== "main") return fail("Move knights during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const knight = knightAt(state, fromVertexId);
  if (!knight || knight.owner !== color) return fail("That isn't your knight.");
  if (!knight.active) return fail("Only an active knight can move.");
  if (toVertexId < 0 || toVertexId >= state.board.vertices.length) return fail("Invalid target.");

  const reach = knightReach(state, color, fromVertexId);
  if (!reach.has(toVertexId)) return fail("That spot isn't reachable by your roads.");

  const target = knightAt(state, toVertexId);
  const building = state.buildings.find((b) => b.vertexId === toVertexId);
  const actor = playerByColor(state, color)!;

  if (building) return fail("A building occupies that spot.");
  if (target) {
    // Displace a weaker enemy knight.
    if (target.owner === color) return fail("Your own knight is there.");
    if (target.rank >= knight.rank) return fail("That knight is too strong to displace.");
    // Push the displaced knight to any adjacent empty vertex, else remove it.
    const spot = state.board.vertices[toVertexId].adjacentVertexIds.find(
      (v) => !vertexOccupied(state, v)
    );
    if (spot != null) {
      target.vertexId = spot;
      target.active = false;
      log(state, `${actor.name}'s knight drove off ${nameOf(state, target.owner)}'s knight.`);
    } else {
      state.knights = state.knights!.filter((k) => k !== target);
      log(state, `${actor.name}'s knight routed ${nameOf(state, target.owner)}'s knight.`);
    }
  } else {
    log(state, `${actor.name} moved a knight.`);
  }

  knight.vertexId = toVertexId;
  knight.active = false; // acting spends the knight's activation
  return ok();
}

// An active knight adjacent to the robber's hex can chase it (like a Knight card).
function knightChaseRobber(
  game: InternalGame,
  color: PlayerColor,
  vertexId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  const guard = requireCK(state);
  if (guard) return guard;
  if (state.phase !== "main") return fail("Chase the robber during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const knight = knightAt(state, vertexId);
  if (!knight || knight.owner !== color) return fail("That isn't your knight.");
  if (!knight.active) return fail("Only an active knight can chase the robber.");
  const adjacent = state.board.vertices[vertexId].hexIds.includes(state.board.robberHexId);
  if (!adjacent) return fail("That knight isn't next to the robber.");

  knight.active = false;
  state.phase = "moving_robber";
  log(state, `${nameOf(state, color)}'s knight chases the robber.`);
  return ok();
}

// ---- Cities & Knights: the barbarians ----

function rollEventDie(): EventDie {
  const r = Math.floor(Math.random() * 6);
  // 3 of 6 faces are the barbarian ship; the rest are improvement gates.
  return r < 3 ? "barbarian" : r === 3 ? "trade" : r === 4 ? "politics" : "science";
}

function activeKnightStrength(state: GameState, color: PlayerColor): number {
  return (state.knights ?? [])
    .filter((k) => k.owner === color && k.active)
    .reduce((s, k) => s + k.rank, 0);
}

function pipValue(state: GameState, vertexId: number): number {
  const v = state.board.vertices[vertexId];
  return v.hexIds.reduce((sum, h) => {
    const n = state.board.hexes[h].number;
    return sum + (n == null ? 0 : 6 - Math.abs(7 - n));
  }, 0);
}

// Reduce a player's least-valuable non-metropolis city back to a settlement.
function pillageCity(state: GameState, color: PlayerColor) {
  const cities = state.buildings.filter(
    (b) => b.owner === color && b.kind === "city" && !b.metropolis
  );
  if (cities.length === 0) {
    log(state, `${nameOf(state, color)}'s cities held (metropolis walls stood firm).`);
    return;
  }
  // Sacrifice an un-walled city first (keep the wall investment), and among
  // equals give up the least-valuable one — the choice a player would make.
  cities.sort((a, b) => {
    const aw = a.wall ? 1 : 0;
    const bw = b.wall ? 1 : 0;
    if (aw !== bw) return aw - bw;
    return pipValue(state, a.vertexId) - pipValue(state, b.vertexId);
  });
  const lost = cities[0];
  lost.kind = "settlement";
  if (lost.wall) {
    lost.wall = false;
    const owner = playerByColor(state, color);
    if (owner && owner.cityWalls) owner.cityWalls -= 1;
  }
  log(state, `Barbarians sacked one of ${nameOf(state, color)}'s cities.`);
}

// The barbarian ship has arrived: compare total active knight strength to the
// number of cities, award Defender of Catan or pillage the weakest, then reset.
function resolveBarbarianAttack(state: GameState) {
  const cityCount = state.buildings.filter((b) => b.kind === "city").length;
  const strengths = state.players.map((p) => ({
    p,
    str: activeKnightStrength(state, p.color),
  }));
  const totalStrength = strengths.reduce((s, x) => s + x.str, 0);
  log(state, `⚔️ Barbarians attack! Knights ${totalStrength} vs ${cityCount} cities.`);

  if (totalStrength >= cityCount) {
    const max = Math.max(0, ...strengths.map((x) => x.str));
    const top = strengths.filter((x) => x.str === max && max > 0);
    if (top.length === 1) {
      top[0].p.defenderTokens = (top[0].p.defenderTokens ?? 0) + 1;
      log(state, `${top[0].p.name} is Defender of Catan (+1 VP).`);
    } else if (top.length > 1) {
      log(state, "Catan is defended — no single hero this time.");
    } else {
      log(state, "The barbarians found no defenders, but did no harm.");
    }
  } else {
    const cityOwners = state.players.filter((p) =>
      state.buildings.some((b) => b.owner === p.color && b.kind === "city")
    );
    const minStr = Math.min(...cityOwners.map((p) => activeKnightStrength(state, p.color)));
    for (const p of cityOwners) {
      if (activeKnightStrength(state, p.color) === minStr) pillageCity(state, p.color);
    }
  }

  // Every knight is spent defending and returns to the inactive state.
  for (const k of state.knights ?? []) k.active = false;
  state.barbarianStep = 0;
}

// Roll the event die: advance/trigger barbarians, or draw progress cards on a
// gate. On a gate, every player whose matching improvement level is at least
// the red die's value draws a card from that deck (up to the hand limit).
function resolveEventDie(game: InternalGame) {
  const { state } = game;
  const face = rollEventDie();
  state.eventDie = face;
  if (face === "barbarian") {
    state.barbarianStep = Math.min(BARBARIAN_TRACK_LENGTH, (state.barbarianStep ?? 0) + 1);
    log(state, `The barbarian ship advances (${state.barbarianStep}/${BARBARIAN_TRACK_LENGTH}).`);
    if (state.barbarianStep >= BARBARIAN_TRACK_LENGTH) resolveBarbarianAttack(state);
    return;
  }
  // Gate face → progress-card draws. The red die (dice[0]) sets the threshold.
  const track = face as ImprovementTrack;
  const redDie = state.dice ? state.dice[0] : 1;
  for (const p of state.players) {
    if ((p.improvements?.[track] ?? 0) >= redDie) drawProgress(game, p, track);
  }
}

// Draw one card from a progress deck into a player's hand (respects the limit).
function drawProgress(game: InternalGame, p: PlayerState, track: ImprovementTrack) {
  const deck = game.progressDecks?.[track];
  if (!deck || deck.length === 0) return;
  if ((p.progressCards?.length ?? 0) >= PROGRESS_HAND_LIMIT) {
    log(game.state, `${p.name} couldn't hold another progress card.`);
    return;
  }
  const card = deck.pop()!;
  (p.progressCards ??= []).push(card);
  if (game.state.progressDeckCounts) game.state.progressDeckCounts[track] = deck.length;
  log(game.state, `${p.name} drew a ${track} progress card.`);
}

// ---- Cities & Knights: city walls & progress cards ----

function buildCityWall(
  game: InternalGame,
  color: PlayerColor,
  vertexId: number,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  const guard = requireCK(state);
  if (guard) return guard;
  if (state.phase !== "main") return fail("Build walls during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const actor = playerByColor(state, color)!;
  const b = state.buildings.find((bb) => bb.vertexId === vertexId);
  if (!b || b.owner !== color || b.kind !== "city") return fail("City walls go on your own city.");
  if (b.wall) return fail("That city already has a wall.");
  if ((actor.cityWalls ?? 0) >= MAX_CITY_WALLS) return fail("You can't build more walls.");
  if (!canAfford(actor, CITY_WALL_COST)) return fail("Need 2 brick.");
  pay(actor, CITY_WALL_COST);
  b.wall = true;
  actor.cityWalls = (actor.cityWalls ?? 0) + 1;
  log(state, `${actor.name} fortified a city with a wall.`);
  return ok();
}

// A player's held cards as a flat pool, for random steal/discard effects.
type CardRef = ["res", Resource] | ["com", Commodity];
function cardPool(p: PlayerState): CardRef[] {
  const pool: CardRef[] = [];
  for (const r of RESOURCES) for (let i = 0; i < p.resources[r]; i++) pool.push(["res", r]);
  if (p.commodities)
    for (const c of COMMODITIES) for (let i = 0; i < p.commodities[c]; i++) pool.push(["com", c]);
  return pool;
}
function moveCard(from: PlayerState, to: PlayerState, e: CardRef) {
  if (e[0] === "res") {
    from.resources[e[1]] -= 1;
    to.resources[e[1]] += 1;
  } else if (from.commodities && to.commodities) {
    from.commodities[e[1]] -= 1;
    to.commodities[e[1]] += 1;
  }
}
function stealN(from: PlayerState, to: PlayerState, n: number) {
  for (let i = 0; i < n; i++) {
    const pool = cardPool(from);
    if (!pool.length) break;
    moveCard(from, to, pool[Math.floor(Math.random() * pool.length)]);
  }
}
function discardN(p: PlayerState, n: number) {
  for (let i = 0; i < n; i++) {
    const pool = cardPool(p);
    if (!pool.length) break;
    const e = pool[Math.floor(Math.random() * pool.length)];
    if (e[0] === "res") p.resources[e[1]] -= 1;
    else if (p.commodities) p.commodities[e[1]] -= 1;
  }
}
function opponents(state: GameState, color: PlayerColor): PlayerState[] {
  return state.players.filter((p) => p.color !== color);
}
function topVPOpponent(state: GameState, color: PlayerColor): PlayerState | null {
  const opps = opponents(state, color);
  if (!opps.length) return null;
  return opps.reduce((a, b) => (victoryPoints(state, b.color) > victoryPoints(state, a.color) ? b : a));
}
// Hexes of a given terrain that border any of the player's buildings.
function borderingHexes(state: GameState, color: PlayerColor, terrain: string): number[] {
  const set = new Set<number>();
  for (const b of state.buildings) {
    if (b.owner !== color) continue;
    for (const h of state.board.vertices[b.vertexId].hexIds) {
      if (state.board.hexes[h].terrain === terrain) set.add(h);
    }
  }
  return [...set];
}

function removeProgress(p: PlayerState, card: ProgressCardKind): boolean {
  const idx = p.progressCards?.indexOf(card) ?? -1;
  if (idx < 0) return false;
  p.progressCards!.splice(idx, 1);
  return true;
}

function playProgressCard(
  game: InternalGame,
  color: PlayerColor,
  msg: Extract<ClientMessage, { type: "play_progress_card" }>,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  const guard = requireCK(state);
  if (guard) return guard;
  if (!isCurrent) return fail("Play progress cards on your turn.");
  if (state.phase !== "main") return fail("Play progress cards during your build phase.");
  const actor = playerByColor(state, color)!;
  if (!(actor.progressCards ?? []).includes(msg.card)) return fail("You don't have that card.");

  const result = applyProgressEffect(game, actor, msg);
  if (!result.ok) return result; // precondition failed — card is not consumed
  removeProgress(actor, msg.card);
  log(state, `${actor.name} played ${PROGRESS_CARD_INFO[msg.card].name}.`);
  checkWin(state);
  return ok();
}

// Effects resolve immediately and server-side. Where the physical game asks the
// player to choose a target, we take an optional message param and otherwise
// pick a sensible target automatically (kept simple but always legal).
function applyProgressEffect(
  game: InternalGame,
  actor: PlayerState,
  msg: Extract<ClientMessage, { type: "play_progress_card" }>
): ActionResult {
  const { state } = game;
  const color = actor.color;
  switch (msg.card) {
    case "master_merchant": {
      const target = topVPOpponent(state, color);
      if (!target || cardPool(target).length === 0)
        return fail("The leading player has no cards to take.");
      stealN(target, actor, 2);
      return ok();
    }
    case "merchant": {
      state.merchantOwner = color;
      return ok();
    }
    case "merchant_fleet": {
      actor.tradeFleetTurn = true;
      return ok();
    }
    case "resource_monopoly": {
      const res =
        msg.resource ??
        RESOURCES.reduce((best, r) =>
          opponents(state, color).reduce((s, p) => s + p.resources[r], 0) >
          opponents(state, color).reduce((s, p) => s + p.resources[best], 0)
            ? r
            : best
        );
      for (const p of opponents(state, color)) {
        const take = Math.min(2, p.resources[res]);
        p.resources[res] -= take;
        actor.resources[res] += take;
      }
      return ok();
    }
    case "trade_monopoly": {
      const com =
        msg.commodity ??
        COMMODITIES.reduce((best, c) =>
          opponents(state, color).reduce((s, p) => s + (p.commodities?.[c] ?? 0), 0) >
          opponents(state, color).reduce((s, p) => s + (p.commodities?.[best] ?? 0), 0)
            ? c
            : best
        );
      for (const p of opponents(state, color)) {
        if (!p.commodities || !actor.commodities) continue;
        const take = Math.min(1, p.commodities[com]);
        p.commodities[com] -= take;
        actor.commodities[com] += take;
      }
      return ok();
    }
    case "commercial_harbor": {
      const anyCom = opponents(state, color).some(
        (p) => p.commodities && COMMODITIES.some((c) => p.commodities![c] > 0)
      );
      const anyRes = RESOURCES.some((r) => actor.resources[r] > 0);
      if (!anyCom) return fail("No opponent has a commodity to trade for.");
      if (!anyRes) return fail("You have no resource to offer in exchange.");
      for (const p of opponents(state, color)) {
        if (!p.commodities || !actor.commodities) continue;
        const com = COMMODITIES.filter((c) => p.commodities![c] > 0).sort(
          (a, b) => p.commodities![b] - p.commodities![a]
        )[0];
        const res = RESOURCES.filter((r) => actor.resources[r] > 0).sort(
          (a, b) => actor.resources[b] - actor.resources[a]
        )[0];
        if (com && res) {
          p.commodities[com] -= 1;
          actor.commodities[com] += 1;
          actor.resources[res] -= 1;
          p.resources[res] += 1;
        }
      }
      return ok();
    }
    case "warlord": {
      for (const k of state.knights ?? []) if (k.owner === color) k.active = true;
      return ok();
    }
    case "smith": {
      const mine = (state.knights ?? []).filter((k) => k.owner === color && k.rank < 3);
      let promoted = 0;
      for (const k of mine) {
        if (promoted >= 2) break;
        if (k.rank + 1 >= 3 && (actor.improvements?.politics ?? 0) < MIGHTY_KNIGHT_POLITICS_LEVEL)
          continue;
        k.rank = (k.rank + 1) as KnightRank;
        promoted++;
      }
      return ok();
    }
    case "bishop": {
      // Auto-move the robber to the hex touching the most opponents, then rob
      // one card from every player adjacent to it.
      let bestHex = -1;
      let bestCount = -1;
      for (const hex of state.board.hexes) {
        if (hex.id === state.board.robberHexId || hex.terrain === "desert") continue;
        const owners = new Set<PlayerColor>();
        for (const b of state.buildings)
          if (b.owner !== color && state.board.vertices[b.vertexId].hexIds.includes(hex.id))
            owners.add(b.owner);
        if (owners.size > bestCount) {
          bestCount = owners.size;
          bestHex = hex.id;
        }
      }
      if (bestHex < 0 || bestCount <= 0) return fail("No opponent to rob with the Bishop.");
      state.board.robberHexId = bestHex;
      const victims = new Set<PlayerColor>();
      for (const b of state.buildings)
        if (b.owner !== color && state.board.vertices[b.vertexId].hexIds.includes(bestHex))
          victims.add(b.owner);
      for (const vc of victims) stealN(playerByColor(state, vc)!, actor, 1);
      return ok();
    }
    case "saboteur": {
      const myVP = victoryPoints(state, color);
      const affected = opponents(state, color).filter((p) => victoryPoints(state, p.color) >= myVP);
      if (affected.length === 0) return fail("No opponent is doing as well as you.");
      for (const p of affected) {
        const total = totalResources(p) + totalCommodities(p);
        discardN(p, Math.floor(total / 2));
      }
      return ok();
    }
    case "spy": {
      const target = opponents(state, color)
        .filter((p) => (p.progressCards?.length ?? 0) > 0)
        .sort((a, b) => (b.progressCards!.length ?? 0) - (a.progressCards!.length ?? 0))[0];
      if (!target || !target.progressCards || !target.progressCards.length)
        return fail("No opponent is holding a progress card.");
      const i = Math.floor(Math.random() * target.progressCards.length);
      const [taken] = target.progressCards.splice(i, 1);
      (actor.progressCards ??= []).push(taken);
      return ok();
    }
    case "wedding": {
      const myVP = victoryPoints(state, color);
      const ahead = opponents(state, color).filter((p) => victoryPoints(state, p.color) > myVP);
      if (ahead.length === 0) return fail("No opponent is ahead of you.");
      for (const p of ahead) stealN(p, actor, 2);
      return ok();
    }
    case "alchemist": {
      const pair = msg.resources ?? (["grain", "ore"] as [Resource, Resource]);
      for (const r of pair) actor.resources[r] += 1;
      return ok();
    }
    case "crane": {
      actor.craneTurn = true;
      return ok();
    }
    case "engineer": {
      if ((actor.cityWalls ?? 0) >= MAX_CITY_WALLS) return fail("You can't build more walls.");
      const city =
        (msg.vertexId != null
          ? state.buildings.find(
              (b) => b.vertexId === msg.vertexId && b.owner === color && b.kind === "city" && !b.wall
            )
          : undefined) ??
        state.buildings.find((b) => b.owner === color && b.kind === "city" && !b.wall);
      if (!city) return fail("You have no un-walled city to fortify.");
      city.wall = true;
      actor.cityWalls = (actor.cityWalls ?? 0) + 1;
      return ok();
    }
    case "irrigation": {
      const fields = borderingHexes(state, color, "grain").length;
      if (fields === 0) return fail("No field (grain hex) borders your buildings.");
      actor.resources.grain += 2 * fields;
      return ok();
    }
    case "mining": {
      const mountains = borderingHexes(state, color, "ore").length;
      if (mountains === 0) return fail("No mountain (ore hex) borders your buildings.");
      actor.resources.ore += 2 * mountains;
      return ok();
    }
    case "printer": {
      actor.victoryPointCards += 1; // kept, hidden VP
      return ok();
    }
    default:
      return ok();
  }
}

// ---- Dev cards ----

function buyDevCard(game: InternalGame, color: PlayerColor, isCurrent: boolean): ActionResult {
  const { state, devDeck } = game;
  if (state.phase !== "main") return fail("You can't buy a card right now.");
  if (!isCurrent) return fail("Not your turn.");
  if (isCK(state)) return fail("Cities & Knights uses progress cards, not development cards.");
  if (devDeck.length === 0) return fail("The deck is empty.");
  const actor = playerByColor(state, color)!;
  if (!canAfford(actor, BUILD_COSTS.dev_card)) return fail("Not enough resources.");

  pay(actor, BUILD_COSTS.dev_card);
  const card = devDeck.pop()!;
  if (card === "victory_point") {
    actor.victoryPointCards += 1;
  } else {
    actor.newDevCards.push(card); // can't play until next turn
  }
  state.devDeckCount = devDeck.length;
  log(state, `${actor.name} bought a development card.`);
  checkWin(state);
  return ok();
}

function consumeDevCard(actor: PlayerState, card: DevCardKind): boolean {
  const idx = actor.devCards.indexOf(card);
  if (idx === -1) return false;
  actor.devCards.splice(idx, 1);
  return true;
}

function playKnight(game: InternalGame, color: PlayerColor, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (!isCurrent) return fail("Not your turn.");
  if (state.phase !== "rolling" && state.phase !== "main")
    return fail("You can't play a knight right now.");
  const actor = playerByColor(state, color)!;
  if (actor.hasPlayedDevCardThisTurn) return fail("Already played a dev card this turn.");
  if (!consumeDevCard(actor, "knight")) return fail("You have no knight card.");

  actor.playedKnights += 1;
  actor.hasPlayedDevCardThisTurn = true;
  updateLargestArmy(state);
  state.phase = "moving_robber";
  log(state, `${actor.name} played a Knight.`);
  checkWin(state);
  return ok();
}

function playRoadBuilding(game: InternalGame, color: PlayerColor, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("Play this during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const actor = playerByColor(state, color)!;
  if (actor.hasPlayedDevCardThisTurn) return fail("Already played a dev card this turn.");
  if (!consumeDevCard(actor, "road_building")) return fail("You have no Road Building card.");

  actor.hasPlayedDevCardThisTurn = true;
  state.freeRoadsRemaining += 2;
  log(state, `${actor.name} played Road Building (2 free roads).`);
  return ok();
}

function playYearOfPlenty(
  game: InternalGame,
  color: PlayerColor,
  resources: [Resource, Resource],
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("Play this during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const actor = playerByColor(state, color)!;
  if (actor.hasPlayedDevCardThisTurn) return fail("Already played a dev card this turn.");
  if (!consumeDevCard(actor, "year_of_plenty")) return fail("You have no Year of Plenty card.");

  actor.hasPlayedDevCardThisTurn = true;
  for (const r of resources) actor.resources[r] += 1;
  log(state, `${actor.name} played Year of Plenty.`);
  return ok();
}

function playMonopoly(game: InternalGame, color: PlayerColor, resource: Resource, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("Play this during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const actor = playerByColor(state, color)!;
  if (actor.hasPlayedDevCardThisTurn) return fail("Already played a dev card this turn.");
  if (!consumeDevCard(actor, "monopoly")) return fail("You have no Monopoly card.");

  actor.hasPlayedDevCardThisTurn = true;
  let taken = 0;
  for (const p of state.players) {
    if (p.color === color) continue;
    taken += p.resources[resource];
    p.resources[resource] = 0;
  }
  actor.resources[resource] += taken;
  log(state, `${actor.name} played Monopoly on ${resource} (+${taken}).`);
  return ok();
}

// ---- Robber ----

function moveRobber(
  game: InternalGame,
  color: PlayerColor,
  hexId: number,
  stealFrom: PlayerColor | null,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  if (state.phase !== "moving_robber") return fail("You can't move the robber now.");
  if (!isCurrent) return fail("Not your turn.");
  if (hexId < 0 || hexId >= state.board.hexes.length) return fail("Invalid hex.");
  if (hexId === state.board.robberHexId) return fail("Robber must move to a new hex.");

  // Determine valid steal targets: players with a building on this hex. Only
  // players who actually hold a resource card can be robbed — validate BEFORE
  // moving the robber so a rejected steal doesn't leave the robber half-moved.
  const victims = new Set<PlayerColor>();
  for (const b of state.buildings) {
    const v = state.board.vertices[b.vertexId];
    if (v.hexIds.includes(hexId) && b.owner !== color) victims.add(b.owner);
  }
  const victimsWithCards = [...victims].filter((c) =>
    RESOURCES.some((r) => playerByColor(state, c)!.resources[r] > 0)
  );

  if (stealFrom && !victims.has(stealFrom)) return fail("You can't steal from that player.");
  // You must name a target only when there's actually someone with cards to rob.
  if (!stealFrom && victimsWithCards.length > 0)
    return fail("You must choose a player to steal from.");

  state.board.robberHexId = hexId;
  log(state, `${nameOf(state, color)} moved the robber.`);

  if (stealFrom) {
    const victim = playerByColor(state, stealFrom)!;
    const pool: Resource[] = [];
    for (const r of RESOURCES) for (let i = 0; i < victim.resources[r]; i++) pool.push(r);
    if (pool.length > 0) {
      const r = pool[Math.floor(Math.random() * pool.length)];
      victim.resources[r] -= 1;
      playerByColor(state, color)!.resources[r] += 1;
      log(state, `${nameOf(state, color)} stole a card from ${victim.name}.`);
    }
  }

  state.phase = "main";
  return ok();
}

function discard(
  game: InternalGame,
  color: PlayerColor,
  resources: Partial<ResourceCounts>,
  commodities?: Partial<CommodityCounts>
): ActionResult {
  const { state } = game;
  if (state.phase !== "discard") return fail("No discards required right now.");
  const owed = state.pendingDiscards[color];
  if (!owed) return fail("You don't need to discard.");
  const actor = playerByColor(state, color)!;

  const resTotal = Object.values(resources).reduce((s, n) => s + (n ?? 0), 0);
  const comTotal = commodities
    ? Object.values(commodities).reduce((s, n) => s + (n ?? 0), 0)
    : 0;
  if (resTotal + comTotal !== owed) return fail(`You must discard exactly ${owed} cards.`);
  if (!canAfford(actor, resources)) return fail("You don't have those cards.");
  if (commodities && actor.commodities) {
    for (const c of COMMODITIES) {
      if ((commodities[c] ?? 0) > actor.commodities[c]) return fail("You don't have those cards.");
    }
  }

  pay(actor, resources);
  if (commodities && actor.commodities) {
    for (const c of COMMODITIES) actor.commodities[c] -= commodities[c] ?? 0;
  }
  delete state.pendingDiscards[color];
  log(state, `${actor.name} discarded ${owed} cards.`);

  if (Object.keys(state.pendingDiscards).length === 0) {
    state.phase = "moving_robber";
    log(state, `${currentPlayer(state).name} must move the robber.`);
  }
  return ok();
}

// ---- Trading ----

const PORT_RATE_DEFAULT = 4;

function bankTrade(
  game: InternalGame,
  color: PlayerColor,
  give: Partial<ResourceCounts>,
  receive: Partial<ResourceCounts>,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("Trade during your build phase.");
  if (!isCurrent) return fail("Not your turn.");
  const actor = playerByColor(state, color)!;

  const ports = playerPorts(state, color);
  // Validate each given resource uses the player's best available rate.
  const receiveCount = Object.values(receive).reduce((s, n) => s + (n ?? 0), 0);
  let giveCount = 0;
  for (const [r, n] of Object.entries(give)) {
    const amount = n ?? 0;
    if (amount === 0) continue;
    // Merchant Fleet: every bank trade this turn is at least 2:1.
    const rate = actor.tradeFleetTurn ? Math.min(2, rateFor(ports, r as Resource)) : rateFor(ports, r as Resource);
    if (amount % rate !== 0) return fail(`Trade ${r} in multiples of ${rate}.`);
    giveCount += amount / rate;
  }
  if (giveCount !== receiveCount || receiveCount === 0)
    return fail("Bank trade ratio is invalid.");
  if (!canAfford(actor, give)) return fail("You don't have those cards.");

  pay(actor, give);
  grant(actor, receive);
  log(state, `${actor.name} traded with the bank.`);
  return ok();
}

function playerPorts(state: GameState, color: PlayerColor): Set<string> {
  const ports = new Set<string>();
  for (const b of state.buildings) {
    if (b.owner !== color) continue;
    const v = state.board.vertices[b.vertexId];
    if (v.port) ports.add(v.port);
  }
  return ports;
}

function rateFor(ports: Set<string>, resource: Resource): number {
  if (ports.has(resource)) return 2;
  if (ports.has("any")) return 3;
  return PORT_RATE_DEFAULT;
}

function offerTrade(
  game: InternalGame,
  color: PlayerColor,
  to: PlayerColor | null,
  give: Partial<ResourceCounts>,
  receive: Partial<ResourceCounts>,
  isCurrent: boolean
): ActionResult {
  const { state } = game;
  if (state.phase !== "main") return fail("Trade during your build phase.");
  if (!isCurrent) return fail("Only the active player can open a trade.");
  const actor = playerByColor(state, color)!;
  if (!canAfford(actor, give)) return fail("You don't have what you're offering.");
  const giveCount = Object.values(give).reduce((s, n) => s + (n ?? 0), 0);
  const recvCount = Object.values(receive).reduce((s, n) => s + (n ?? 0), 0);
  if (giveCount === 0 || recvCount === 0) return fail("Trade must include both sides.");

  const id = `${color}-${state.pendingTrades.length}-${state.updatedAt}`;
  state.pendingTrades.push({ id, from: color, to, give, receive });
  log(state, `${actor.name} offered a trade.`);
  return ok();
}

function acceptTrade(game: InternalGame, color: PlayerColor, tradeId: string): ActionResult {
  const { state } = game;
  const trade = state.pendingTrades.find((t) => t.id === tradeId);
  if (!trade) return fail("Trade no longer available.");
  if (trade.from === color) return fail("You can't accept your own trade.");
  if (trade.to && trade.to !== color) return fail("This trade isn't offered to you.");

  const from = playerByColor(state, trade.from)!;
  const accepter = playerByColor(state, color)!;
  if (!canAfford(from, trade.give)) return fail("Offerer no longer has the cards.");
  if (!canAfford(accepter, trade.receive)) return fail("You don't have the cards.");

  pay(from, trade.give);
  grant(accepter, trade.give);
  pay(accepter, trade.receive);
  grant(from, trade.receive);
  state.pendingTrades = state.pendingTrades.filter((t) => t.id !== tradeId);
  log(state, `${from.name} and ${accepter.name} completed a trade.`);
  return ok();
}

function cancelTrade(game: InternalGame, color: PlayerColor, tradeId: string): ActionResult {
  const { state } = game;
  const trade = state.pendingTrades.find((t) => t.id === tradeId);
  if (!trade) return ok();
  if (trade.from !== color) return fail("Only the offerer can cancel.");
  state.pendingTrades = state.pendingTrades.filter((t) => t.id !== tradeId);
  return ok();
}

// A recipient declines/dismisses an open offer (e.g. an AI bot's), removing it.
function declineTrade(game: InternalGame, color: PlayerColor, tradeId: string): ActionResult {
  const { state } = game;
  const trade = state.pendingTrades.find((t) => t.id === tradeId);
  if (!trade) return ok();
  if (trade.from === color) return fail("Cancel your own offer instead.");
  if (trade.to && trade.to !== color) return fail("This offer isn't to you.");
  state.pendingTrades = state.pendingTrades.filter((t) => t.id !== tradeId);
  log(state, `${nameOf(state, color)} declined a trade.`);
  return ok();
}

// ---- End turn ----

function endTurn(game: InternalGame, color: PlayerColor, isCurrent: boolean): ActionResult {
  const { state } = game;
  if (!isCurrent) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Finish your current action first.");
  if (state.freeRoadsRemaining > 0) state.freeRoadsRemaining = 0;

  const actor = playerByColor(state, color)!;
  // Newly bought dev cards become playable next turn.
  actor.devCards.push(...actor.newDevCards);
  actor.newDevCards = [];
  actor.hasPlayedDevCardThisTurn = false;
  actor.tradeFleetTurn = false; // C&K per-turn progress-card modifiers expire
  actor.craneTurn = false;
  state.pendingTrades = [];
  state.dice = null;

  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  state.phase = "rolling";
  log(state, `${currentPlayer(state).name}'s turn.`);
  return ok();
}

// ---- Redaction: hide other players' hidden info ----

export function redactFor(state: GameState, viewer: PlayerColor | null): GameState {
  const clone: GameState = JSON.parse(JSON.stringify(state));
  for (const p of clone.players) {
    if (p.color !== viewer) {
      // Hide exact dev card contents; expose only counts via placeholders.
      const hiddenCount = p.devCards.length + p.newDevCards.length;
      p.devCards = Array(hiddenCount).fill("knight"); // opaque placeholder
      p.newDevCards = [];
      // Hidden victory-point cards stay secret until the game ends.
      if (clone.phase !== "finished") p.victoryPointCards = 0;
      // C&K: progress-card contents are hidden; expose only the count.
      if (p.progressCards) p.progressCards = Array(p.progressCards.length).fill("printer");
    }
  }
  return clone;
}
