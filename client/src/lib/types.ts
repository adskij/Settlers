import type { PlayerColor } from "@settlers/shared";

export interface LobbyPlayer {
  userId: string;
  name: string;
  color: PlayerColor;
  seat: number;
  isBot: boolean;
}

export interface LobbyGame {
  id: string;
  name: string;
  hostId: string;
  phase: string;
  players: LobbyPlayer[];
}
