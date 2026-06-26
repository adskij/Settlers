import type { PlayerColor } from "@settlers/shared";

export interface LobbyGame {
  id: string;
  name: string;
  hostId: string;
  phase: string;
  players: { userId: string; name: string; color: PlayerColor; seat: number }[];
}
