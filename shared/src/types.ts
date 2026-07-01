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
