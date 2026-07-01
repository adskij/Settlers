// WebSocket message protocol between client and server.
import type {
  GameState,
  PlayerColor,
  Resource,
  Commodity,
  ResourceCounts,
  CommodityCounts,
  ImprovementTrack,
  ProgressCardKind,
  DevCardKind,
} from "./types.js";

// ---- Client -> Server ----

export type ClientMessage =
  | { type: "join_game"; gameId: string }
  | { type: "leave_game" }
  | { type: "start_game" }
  | { type: "place_setup_settlement"; vertexId: number }
  | { type: "place_setup_road"; edgeId: number }
  | { type: "roll_dice" }
  | { type: "build_road"; edgeId: number }
  | { type: "build_settlement"; vertexId: number }
  | { type: "build_city"; vertexId: number }
  | { type: "buy_dev_card" }
  | { type: "play_knight" }
  | { type: "play_road_building" }
  | { type: "play_year_of_plenty"; resources: [Resource, Resource] }
  | { type: "play_monopoly"; resource: Resource }
  | { type: "move_robber"; hexId: number; stealFrom: PlayerColor | null }
  | {
      type: "discard";
      resources: Partial<ResourceCounts>;
      /** C&K: commodities also count toward the hand limit. */
      commodities?: Partial<CommodityCounts>;
    }
  | { type: "buy_improvement"; track: ImprovementTrack }
  | { type: "build_knight"; vertexId: number }
  | { type: "activate_knight"; vertexId: number }
  | { type: "promote_knight"; vertexId: number }
  | { type: "move_knight"; fromVertexId: number; toVertexId: number }
  | { type: "knight_chase_robber"; vertexId: number }
  | {
      type: "play_progress_card";
      card: ProgressCardKind;
      /** Optional targets used by some cards (monopolies, alchemist, engineer). */
      resource?: Resource;
      commodity?: Commodity;
      resources?: [Resource, Resource];
      vertexId?: number;
    }
  | { type: "build_city_wall"; vertexId: number }
  | {
      type: "offer_trade";
      to: PlayerColor | null;
      give: Partial<ResourceCounts>;
      receive: Partial<ResourceCounts>;
    }
  | { type: "accept_trade"; tradeId: string }
  | { type: "cancel_trade"; tradeId: string }
  | { type: "decline_trade"; tradeId: string }
  | {
      type: "bank_trade";
      give: Partial<ResourceCounts>;
      receive: Partial<ResourceCounts>;
    }
  | { type: "end_turn" };

// ---- Server -> Client ----

export type ServerMessage =
  | { type: "state"; state: GameState; you: PlayerColor | null }
  | { type: "error"; message: string }
  | { type: "info"; message: string }
  | { type: "closed"; reason: string };

export interface DevCardPlayPayload {
  card: DevCardKind;
}
