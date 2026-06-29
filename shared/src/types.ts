// Core domain types shared between client and server.

export type Resource = "brick" | "lumber" | "wool" | "grain" | "ore";
export const RESOURCES: Resource[] = ["brick", "lumber", "wool", "grain", "ore"];

// Terrain produces a resource; "desert" produces nothing.
export type Terrain = Resource | "desert";

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
}

export interface GameState {
  id: string;
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
  updatedAt: number;
}

export const VICTORY_POINTS_TO_WIN = 10;
export const MAX_HAND_BEFORE_DISCARD = 7;

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
