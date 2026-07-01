// Core domain types shared between client and server.

export type Resource = "brick" | "lumber" | "wool" | "grain" | "ore";
export const RESOURCES: Resource[] = ["brick", "lumber", "wool", "grain", "ore"];

// Terrain produces a resource; "desert" produces nothing.
export type Terrain = Resource | "desert";

// ---- Cities & Knights expansion ----

/** Which base ruleset a game runs. "base" games ignore every C&K field. */
export type GameVariant = "base" | "cities_and_knights";

/** Commodities are the "second tier" goods that cities produce in C&K. */
export type Commodity = "coin" | "paper" | "cloth";
export const COMMODITIES: Commodity[] = ["coin", "paper", "cloth"];
export type CommodityCounts = Record<Commodity, number>;

/** A city on this terrain also yields 1 of the matching commodity (C&K). */
export const TERRAIN_COMMODITY: Partial<Record<Terrain, Commodity>> = {
  ore: "coin", // mountains
  lumber: "paper", // forest
  wool: "cloth", // pasture
};

/** The three city-improvement tracks. */
export type ImprovementTrack = "trade" | "politics" | "science";
export const IMPROVEMENT_TRACKS: ImprovementTrack[] = ["trade", "politics", "science"];

/** Commodity spent to advance each track. */
export const TRACK_COMMODITY: Record<ImprovementTrack, Commodity> = {
  trade: "cloth",
  politics: "coin",
  science: "paper",
};

/** Per-player level (0..5) on each improvement track. */
export type ImprovementLevels = Record<ImprovementTrack, number>;

/** The coloured event die rolled alongside the two number dice in C&K. */
export type EventDie = "barbarian" | "trade" | "politics" | "science";

/** Knight rank: basic (1), strong (2), mighty (3). Also its defense strength. */
export type KnightRank = 1 | 2 | 3;

/** A knight sits on a vertex; only *active* knights can act or defend. */
export interface KnightPiece {
  owner: PlayerColor;
  vertexId: number;
  rank: KnightRank;
  active: boolean;
}

export type PlayerColor = "red" | "blue" | "white" | "orange";
export const PLAYER_COLORS: PlayerColor[] = ["red", "blue", "white", "orange"];

export type BuildingKind = "settlement" | "city";

export type DevCardKind =
  | "knight"
  | "victory_point"
  | "road_building"
  | "year_of_plenty"
  | "monopoly";

export type PortKind = Resource | "any"; // "any" = generic 3:1 port

// ---- Board geometry (positions are normalized; client scales them) ----

export interface Point {
  x: number;
  y: number;
}

export interface Hex {
  id: number;
  q: number; // axial coord
  r: number; // axial coord
  center: Point;
  terrain: Terrain;
  /** Dice number (2-12, no 7). Null on the desert. */
  number: number | null;
  vertexIds: number[]; // 6 corner vertices
}

export interface Vertex {
  id: number;
  pos: Point;
  hexIds: number[]; // 1-3 adjacent hexes
  adjacentVertexIds: number[]; // connected via an edge
  /** Port on this vertex, if any. */
  port?: PortKind;
}

export interface Edge {
  id: number;
  v1: number;
  v2: number;
  pos: Point; // midpoint, for rendering
}

export interface Board {
  hexes: Hex[];
  vertices: Vertex[];
  edges: Edge[];
  robberHexId: number;
}

// ---- Game state ----

export interface BuildingPiece {
  kind: BuildingKind;
  owner: PlayerColor;
  vertexId: number;
  /** C&K: this city has been raised to a metropolis for the given track. */
  metropolis?: ImprovementTrack;
  /** C&K: this city has a wall (raises its owner's discard limit). */
  wall?: boolean;
}

export interface RoadPiece {
  owner: PlayerColor;
  edgeId: number;
}

export type ResourceCounts = Record<Resource, number>;

export interface PlayerState {
  userId: string;
  name: string;
  color: PlayerColor;
  connected: boolean;
  /** AI-controlled seat (filled by the server, not a human). */
  isBot: boolean;
  resources: ResourceCounts;
  /** Dev cards in hand. Hidden from other players (server redacts). */
  devCards: DevCardKind[];
  /** Dev cards bought this turn (can't be played until next turn). */
  newDevCards: DevCardKind[];
  playedKnights: number;
  victoryPointCards: number; // hidden VP dev cards
  hasPlayedDevCardThisTurn: boolean;
  /** C&K: coin/paper/cloth on hand. Undefined in base games. */
  commodities?: CommodityCounts;
  /** C&K: level (0..5) reached on each city-improvement track. */
  improvements?: ImprovementLevels;
  /** C&K: Defender of Catan tokens earned repelling barbarians (+1 VP each). */
  defenderTokens?: number;
  /** C&K: progress cards in hand (hidden from other players). */
  progressCards?: ProgressCardKind[];
  /** C&K: number of city walls built (raises the discard limit). */
  cityWalls?: number;
  /** C&K: Merchant-Fleet bonus active this turn (bank trades are 2:1). */
  tradeFleetTurn?: boolean;
  /** C&K: Crane bonus active (next improvement costs 1 fewer commodity). */
  craneTurn?: boolean;
}

export type GamePhase =
  | "lobby"
  | "setup" // initial placement (snake order)
  | "rolling" // current player must roll
  | "main" // current player may trade/build
  | "discard" // a 7 was rolled; players over the limit discard
  | "moving_robber"
  | "robbing" // choose a player to steal from
  | "finished";

export interface TradeOffer {
  id: string;
  from: PlayerColor;
  /** null = open to all players */
  to: PlayerColor | null;
  give: Partial<ResourceCounts>;
  receive: Partial<ResourceCounts>;
  /** Optional epoch-ms expiry (used for AI offers the human can accept). */
  expiresAt?: number;
}

export interface GameState {
  id: string;
  /** Which ruleset this game runs. Absent/`"base"` for legacy games. */
  variant: GameVariant;
  phase: GamePhase;
  board: Board;
  players: PlayerState[];
  /** Index into players[] whose turn it is. */
  currentPlayerIndex: number;
  /** Setup goes forward then backward (snake). */
  setupDirection: 1 | -1;
  /** During setup, whether the current player places a settlement or a road. */
  setupStep: "settlement" | "road" | null;
  /** Settlement placed this setup turn, that the setup road must connect to. */
  pendingSetupVertex: number | null;
  dice: [number, number] | null;
  buildings: BuildingPiece[];
  roads: RoadPiece[];
  /** Remaining dev card deck size (contents hidden). */
  devDeckCount: number;
  pendingTrades: TradeOffer[];
  /** Players who still must discard this turn (color -> count owed). */
  pendingDiscards: Record<string, number>;
  largestArmyOwner: PlayerColor | null;
  longestRoadOwner: PlayerColor | null;
  winner: PlayerColor | null;
  /** Human-readable event log. */
  log: string[];
  /** Free roads remaining from a Road Building card. */
  freeRoadsRemaining: number;
  /** C&K: which player holds each track's metropolis (+2 VP, first-to-4). */
  metropolisOwner?: Record<ImprovementTrack, PlayerColor | null>;
  /** C&K: knight pieces on the board (all players). */
  knights?: KnightPiece[];
  /** C&K: the last event-die face rolled. */
  eventDie?: EventDie | null;
  /** C&K: barbarian ship position (0..BARBARIAN_TRACK_LENGTH). */
  barbarianStep?: number;
  /** C&K: who holds the Merchant (+1 VP), if anyone. */
  merchantOwner?: PlayerColor | null;
  /** C&K: remaining cards in each progress deck (contents hidden). */
  progressDeckCounts?: Record<ImprovementTrack, number>;
  updatedAt: number;
}

export const VICTORY_POINTS_TO_WIN = 10;
/** Cities & Knights raises the target to 13 victory points. */
export const CK_VICTORY_POINTS_TO_WIN = 13;
export const MAX_HAND_BEFORE_DISCARD = 7;

/** C&K city-improvement tracks run from level 0 to 5. */
export const MAX_IMPROVEMENT_LEVEL = 5;
/** Reaching this level on a track claims that track's metropolis (+2 VP). */
export const METROPOLIS_LEVEL = 4;
/** Advancing a track to level n costs n commodities of the track's type. */
export function improvementCost(nextLevel: number): number {
  return nextLevel;
}

// ---- Knights ----
export const KNIGHT_MAX_RANK = 3;
/** Max knights a single player may have on the board at once. */
export const KNIGHT_LIMIT = 6;
/** Politics level required before a knight can be promoted to Mighty (rank 3). */
export const MIGHTY_KNIGHT_POLITICS_LEVEL = 3;
export const KNIGHT_BUILD_COST: Partial<ResourceCounts> = { wool: 1, ore: 1 };
export const KNIGHT_PROMOTE_COST: Partial<ResourceCounts> = { wool: 1, ore: 1 };
export const KNIGHT_ACTIVATE_COST: Partial<ResourceCounts> = { grain: 1 };
export const KNIGHT_RANK_NAME: Record<KnightRank, string> = {
  1: "Basic",
  2: "Strong",
  3: "Mighty",
};

// ---- Barbarians ----
/** Steps the barbarian ship advances before it attacks Catan. */
export const BARBARIAN_TRACK_LENGTH = 7;

// ---- Progress cards ----
// Drawn from the deck matching the event-die gate (trade/politics/science) when
// a player's improvement level meets the red die. One deck per improvement track.
export type ProgressCardKind =
  // Trade (drawn on the yellow trade gate)
  | "master_merchant"
  | "merchant"
  | "merchant_fleet"
  | "resource_monopoly"
  | "trade_monopoly"
  | "commercial_harbor"
  // Politics (blue gate)
  | "warlord"
  | "smith"
  | "bishop"
  | "saboteur"
  | "spy"
  | "wedding"
  // Science (green gate)
  | "alchemist"
  | "crane"
  | "engineer"
  | "irrigation"
  | "mining"
  | "printer";

/** Which improvement track's deck a progress card belongs to. */
export const PROGRESS_DECK: Record<ImprovementTrack, ProgressCardKind[]> = {
  trade: [
    "master_merchant",
    "merchant",
    "merchant_fleet",
    "resource_monopoly",
    "trade_monopoly",
    "commercial_harbor",
  ],
  politics: ["warlord", "smith", "bishop", "saboteur", "spy", "wedding"],
  science: ["alchemist", "crane", "engineer", "irrigation", "mining", "printer"],
};

/** Copies of each card in its deck. */
export const PROGRESS_CARD_COPIES = 2;

/** Max progress cards a player may hold. */
export const PROGRESS_HAND_LIMIT = 4;

export const PROGRESS_CARD_INFO: Record<
  ProgressCardKind,
  { name: string; deck: ImprovementTrack; icon: string; desc: string }
> = {
  master_merchant: { name: "Master Merchant", deck: "trade", icon: "💰", desc: "Steal 2 random cards from the player with the most victory points." },
  merchant: { name: "Merchant", deck: "trade", icon: "🏪", desc: "Take the Merchant — worth 1 victory point until another player plays this card." },
  merchant_fleet: { name: "Merchant Fleet", deck: "trade", icon: "⛵", desc: "For the rest of this turn, all of your bank trades are 2:1." },
  resource_monopoly: { name: "Resource Monopoly", deck: "trade", icon: "📦", desc: "Take up to 2 of a named resource from every opponent." },
  trade_monopoly: { name: "Trade Monopoly", deck: "trade", icon: "🧾", desc: "Take 1 of a named commodity from every opponent." },
  commercial_harbor: { name: "Commercial Harbor", deck: "trade", icon: "⚓", desc: "Take a commodity from each opponent, giving each a resource in return." },
  warlord: { name: "Warlord", deck: "politics", icon: "🎖️", desc: "Activate all of your knights for free." },
  smith: { name: "Smith", deck: "politics", icon: "🔨", desc: "Promote up to two of your knights one rank each, for free." },
  bishop: { name: "Bishop", deck: "politics", icon: "⛪", desc: "Move the robber, then steal a card from every player next to its new hex." },
  saboteur: { name: "Saboteur", deck: "politics", icon: "🧨", desc: "Every player with as many victory points as you discards half their hand." },
  spy: { name: "Spy", deck: "politics", icon: "🕵️", desc: "Take a random progress card from the player holding the most." },
  wedding: { name: "Wedding", deck: "politics", icon: "💍", desc: "Each player with more victory points than you gives you 2 cards." },
  alchemist: { name: "Alchemist", deck: "science", icon: "⚗️", desc: "Take any 2 resources from the bank." },
  crane: { name: "Crane", deck: "science", icon: "🏗️", desc: "Your next city improvement costs 1 fewer commodity." },
  engineer: { name: "Engineer", deck: "science", icon: "🧱", desc: "Build a city wall on one of your cities for free." },
  irrigation: { name: "Irrigation", deck: "science", icon: "🌾", desc: "Gain 2 grain for each field bordering your buildings." },
  mining: { name: "Mining", deck: "science", icon: "⛏️", desc: "Gain 2 ore for each mountain bordering your buildings." },
  printer: { name: "Printer", deck: "science", icon: "🖨️", desc: "Worth 1 victory point, kept hidden in your hand." },
};

export const CITY_WALL_COST: Partial<ResourceCounts> = { brick: 2 };
/** Each city wall raises your discard limit by this many cards. */
export const CITY_WALL_HAND_BONUS = 2;
/** Max city walls a single player may build. */
export const MAX_CITY_WALLS = 3;

export const BUILD_COSTS: Record<string, Partial<ResourceCounts>> = {
  road: { brick: 1, lumber: 1 },
  settlement: { brick: 1, lumber: 1, wool: 1, grain: 1 },
  city: { grain: 2, ore: 3 },
  dev_card: { wool: 1, grain: 1, ore: 1 },
};

export const PIECE_LIMITS = {
  roads: 15,
  settlements: 5,
  cities: 4,
};
