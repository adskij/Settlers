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
import { botShouldAct, botStep } from "./bot.js";

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2; // base game supports 3-4; allow 2 for testing
const BOT_NAMES = ["Aria-Bot", "Bolt-Bot", "Cora-Bot", "Dex-Bot"];
const BOT_MOVE_DELAY_MS = 800; // paced so humans can follow the bot's moves

// Active in-memory games (authoritative runtime state).
const active = new Map<string, InternalGame>();

// Notify hook, set by the WebSocket layer, to tell clients a game was deleted.
let onDeleted: (gameId: string) => void = () => {};
export function setOnDeleted(fn: (gameId: string) => void) {
  onDeleted = fn;
}

// Broadcast hook, set by the WebSocket layer, used to push bot moves to clients.
let broadcaster: (gameId: string) => void = () => {};
export function setBroadcaster(fn: (gameId: string) => void) {
  broadcaster = fn;
}

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
    // Per-seat name (used for bots); fall back to the user's username.
    const u = db.prepare("SELECT username FROM users WHERE id = ?").get(r.user_id) as
      | { username: string }
      | undefined;
    return {
      userId: r.user_id,
      name: r.name ?? u?.username ?? "?",
      color: r.color as PlayerColor,
      seat: r.seat,
      isBot: !!r.is_bot,
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
    "INSERT INTO game_players (game_id, user_id, color, seat, is_bot) VALUES (?, ?, ?, ?, 0)"
  ).run(gameId, userId, color, seat);
  return getLobby(gameId)!;
}

// Host adds an AI bot to an open seat. Bots get a throwaway user row (with an
// unusable password) so the existing foreign key / username join keep working.
export function addBot(gameId: string, hostId: string): LobbyGame {
  const lobby = getLobby(gameId);
  if (!lobby) throw new Error("Game not found.");
  if (lobby.hostId !== hostId) throw new Error("Only the host can add bots.");
  if (lobby.phase !== "lobby") throw new Error("Game already started.");
  if (lobby.players.length >= MAX_PLAYERS) throw new Error("Game is full.");

  const used = new Set(lobby.players.map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c))!;
  const seat = lobby.players.length;
  const botUserId = `bot-${randomUUID()}`; // globally unique -> safe as username
  // Friendly per-seat display name, distinct among this game's bots.
  const usedNames = new Set(lobby.players.filter((p) => p.isBot).map((p) => p.name));
  const name = BOT_NAMES.find((n) => !usedNames.has(n)) ?? `Bot-${seat}`;

  db.prepare(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(botUserId, botUserId, "!bot-no-login!", Date.now());
  db.prepare(
    "INSERT INTO game_players (game_id, user_id, color, seat, is_bot, name) VALUES (?, ?, ?, ?, 1, ?)"
  ).run(gameId, botUserId, color, seat, name);
  return getLobby(gameId)!;
}

// Host removes a bot seat (and its throwaway user row).
export function removeBot(gameId: string, hostId: string, botUserId: string): LobbyGame {
  const lobby = getLobby(gameId);
  if (!lobby) throw new Error("Game not found.");
  if (lobby.hostId !== hostId) throw new Error("Only the host can remove bots.");
  if (lobby.phase !== "lobby") throw new Error("Game already started.");
  const target = lobby.players.find((p) => p.userId === botUserId);
  if (!target || !target.isBot) throw new Error("Not a bot seat.");
  db.prepare("DELETE FROM game_players WHERE game_id = ? AND user_id = ?").run(
    gameId,
    botUserId
  );
  db.prepare("DELETE FROM users WHERE id = ?").run(botUserId);
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
  // Tear down the lobby once no humans remain (don't leave a bots-only game).
  if (!remaining || remaining.players.every((p) => p.isBot)) {
    if (remaining) {
      for (const bot of remaining.players.filter((p) => p.isBot)) {
        db.prepare("DELETE FROM users WHERE id = ?").run(bot.userId);
      }
    }
    db.prepare("DELETE FROM games WHERE id = ?").run(gameId);
  }
}

// Host deletes a game entirely (any phase). Removes it from the DB, cleans up
// bot user rows and in-memory runtime, and notifies connected clients.
export function deleteGame(gameId: string, userId: string): void {
  const row = db.prepare("SELECT host_id FROM games WHERE id = ?").get(gameId) as
    | { host_id: string }
    | undefined;
  if (!row) return; // already gone
  if (row.host_id !== userId) throw new Error("Only the host can delete this game.");

  const players = db
    .prepare("SELECT user_id, is_bot FROM game_players WHERE game_id = ?")
    .all(gameId) as { user_id: string; is_bot: number }[];
  db.prepare("DELETE FROM games WHERE id = ?").run(gameId); // cascades game_players
  for (const p of players) {
    if (p.is_bot) db.prepare("DELETE FROM users WHERE id = ?").run(p.user_id);
  }

  active.delete(gameId);
  const timer = botTimers.get(gameId);
  if (timer) {
    clearTimeout(timer);
    botTimers.delete(gameId);
  }
  onDeleted(gameId); // let the WS layer kick anyone still in the room
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
    isBot: p.isBot,
  }));
  const game = createGame(gameId, row.seed, seats);
  active.set(gameId, game);
  persist(gameId);
  scheduleBots(gameId); // in case seat 0 is a bot
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
  if (result.ok) {
    persist(gameId);
    scheduleBots(gameId); // a human action may hand the turn to a bot
  }
  return { game, result };
}

// ---- Bot scheduling ----
// One bot action per tick, broadcasting between moves so play is watchable.
const botTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleBots(gameId: string) {
  if (botTimers.has(gameId)) return; // already pending
  const game = active.get(gameId);
  if (!game || !botShouldAct(game)) return;
  const timer = setTimeout(() => {
    botTimers.delete(gameId);
    botTick(gameId);
  }, BOT_MOVE_DELAY_MS);
  botTimers.set(gameId, timer);
}

function botTick(gameId: string) {
  const game = active.get(gameId);
  if (!game) return;
  if (!botShouldAct(game)) return;

  const acted = botStep(game);
  if (acted) {
    persist(gameId);
    broadcaster(gameId);
  }
  // Keep going while a bot is still on the clock (and we made progress).
  if (acted && botShouldAct(game)) scheduleBots(gameId);
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
