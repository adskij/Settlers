import { randomUUID } from "node:crypto";
import {
  PLAYER_COLORS,
  type ClientMessage,
  type PlayerColor,
} from "@settlers/shared";
import { db, type GamePlayerRow, type GameRow } from "./db.js";
import {
  applyAction,
  createGame,
  type ActionResult,
  type InternalGame,
} from "./engine.js";

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2; // base game supports 3-4; allow 2 for testing

// Active in-memory games (authoritative runtime state).
const active = new Map<string, InternalGame>();

export interface LobbyGame {
  id: string;
  name: string;
  hostId: string;
  phase: string;
  players: { userId: string; name: string; color: PlayerColor; seat: number }[];
}

export function createLobby(hostId: string, name: string): LobbyGame {
  const id = randomUUID();
  const now = Date.now();
  const seed = (Math.random() * 0x7fffffff) | 0;
  db.prepare(
    `INSERT INTO games (id, name, host_id, seed, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'lobby', ?, ?)`
  ).run(id, name.trim() || "New Game", hostId, seed, now, now);
  joinLobby(id, hostId);
  return getLobby(id)!;
}

export function getLobby(id: string): LobbyGame | null {
  const game = db.prepare("SELECT * FROM games WHERE id = ?").get(id) as
    | GameRow
    | undefined;
  if (!game) return null;
  const rows = db
    .prepare("SELECT * FROM game_players WHERE game_id = ? ORDER BY seat")
    .all(id) as GamePlayerRow[];
  const players = rows.map((r) => {
    const u = db.prepare("SELECT username FROM users WHERE id = ?").get(r.user_id) as
      | { username: string }
      | undefined;
    return {
      userId: r.user_id,
      name: u?.username ?? "?",
      color: r.color as PlayerColor,
      seat: r.seat,
    };
  });
  return {
    id: game.id,
    name: game.name,
    hostId: game.host_id,
    phase: game.phase,
    players,
  };
}

export function listOpenLobbies(): LobbyGame[] {
  const games = db
    .prepare("SELECT id FROM games WHERE phase = 'lobby' ORDER BY created_at DESC LIMIT 50")
    .all() as { id: string }[];
  return games.map((g) => getLobby(g.id)).filter((g): g is LobbyGame => !!g);
}

export function listMyGames(userId: string): LobbyGame[] {
  const rows = db
    .prepare(
      `SELECT g.id FROM games g
       JOIN game_players p ON p.game_id = g.id
       WHERE p.user_id = ? ORDER BY g.updated_at DESC LIMIT 50`
    )
    .all(userId) as { id: string }[];
  return rows.map((r) => getLobby(r.id)).filter((g): g is LobbyGame => !!g);
}

export function joinLobby(gameId: string, userId: string): LobbyGame {
  const lobby = getLobby(gameId);
  if (!lobby) throw new Error("Game not found.");
  if (lobby.phase !== "lobby") {
    if (lobby.players.some((p) => p.userId === userId)) return lobby; // rejoin
    throw new Error("Game already started.");
  }
  if (lobby.players.some((p) => p.userId === userId)) return lobby;
  if (lobby.players.length >= MAX_PLAYERS) throw new Error("Game is full.");

  const used = new Set(lobby.players.map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c))!;
  const seat = lobby.players.length;
  db.prepare(
    "INSERT INTO game_players (game_id, user_id, color, seat) VALUES (?, ?, ?, ?)"
  ).run(gameId, userId, color, seat);
  return getLobby(gameId)!;
}

export function leaveLobby(gameId: string, userId: string): void {
  const lobby = getLobby(gameId);
  if (!lobby || lobby.phase !== "lobby") return;
  db.prepare("DELETE FROM game_players WHERE game_id = ? AND user_id = ?").run(
    gameId,
    userId
  );
  const remaining = getLobby(gameId);
  if (!remaining || remaining.players.length === 0) {
    db.prepare("DELETE FROM games WHERE id = ?").run(gameId);
  }
}

export function startGame(gameId: string, userId: string): InternalGame {
  const row = db.prepare("SELECT * FROM games WHERE id = ?").get(gameId) as
    | GameRow
    | undefined;
  if (!row) throw new Error("Game not found.");
  if (row.host_id !== userId) throw new Error("Only the host can start the game.");
  if (row.phase !== "lobby") throw new Error("Game already started.");
  const lobby = getLobby(gameId)!;
  if (lobby.players.length < MIN_PLAYERS) throw new Error("Need at least 2 players.");

  const seats = lobby.players.map((p) => ({
    userId: p.userId,
    name: p.name,
    color: p.color,
  }));
  const game = createGame(gameId, row.seed, seats);
  active.set(gameId, game);
  persist(gameId);
  return game;
}

// Load a started game into memory (e.g. after a server restart).
export function loadGame(gameId: string): InternalGame | null {
  const cached = active.get(gameId);
  if (cached) return cached;

  const row = db.prepare("SELECT * FROM games WHERE id = ?").get(gameId) as
    | GameRow
    | undefined;
  if (!row || !row.state_json) return null;
  const game = JSON.parse(row.state_json) as InternalGame;
  active.set(gameId, game);
  return game;
}

export function colorForUser(game: InternalGame, userId: string): PlayerColor | null {
  return game.state.players.find((p) => p.userId === userId)?.color ?? null;
}

export function handleAction(
  gameId: string,
  userId: string,
  msg: ClientMessage
): { game: InternalGame; result: ActionResult } {
  const game = loadGame(gameId);
  if (!game) throw new Error("Game not active.");
  const color = colorForUser(game, userId);
  if (!color) throw new Error("You are not in this game.");
  const result = applyAction(game, color, msg);
  if (result.ok) persist(gameId);
  return { game, result };
}

export function setConnected(gameId: string, userId: string, connected: boolean) {
  const game = active.get(gameId);
  if (!game) return;
  const p = game.state.players.find((pl) => pl.userId === userId);
  if (p) {
    p.connected = connected;
    persist(gameId);
  }
}

function persist(gameId: string) {
  const game = active.get(gameId);
  if (!game) return;
  db.prepare(
    "UPDATE games SET phase = ?, state_json = ?, updated_at = ? WHERE id = ?"
  ).run(game.state.phase, JSON.stringify(game), Date.now(), gameId);
}
