import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DATABASE_PATH ?? "./data/settlers.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_id TEXT NOT NULL,
    seed INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'lobby',
    variant TEXT NOT NULL DEFAULT 'base',
    state_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (host_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS game_players (
    game_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    color TEXT NOT NULL,
    seat INTEGER NOT NULL,
    is_bot INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    PRIMARY KEY (game_id, user_id),
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migrations for databases created before bots existed.
const gamePlayerCols = db
  .prepare("PRAGMA table_info(game_players)")
  .all() as { name: string }[];
if (!gamePlayerCols.some((c) => c.name === "is_bot")) {
  db.exec("ALTER TABLE game_players ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
}
if (!gamePlayerCols.some((c) => c.name === "name")) {
  db.exec("ALTER TABLE game_players ADD COLUMN name TEXT");
}

// Migration for databases created before the Cities & Knights variant.
const gameCols = db.prepare("PRAGMA table_info(games)").all() as { name: string }[];
if (!gameCols.some((c) => c.name === "variant")) {
  db.exec("ALTER TABLE games ADD COLUMN variant TEXT NOT NULL DEFAULT 'base'");
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface GameRow {
  id: string;
  name: string;
  host_id: string;
  seed: number;
  phase: string;
  variant: string;
  state_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface GamePlayerRow {
  game_id: string;
  user_id: string;
  color: string;
  seat: number;
  is_bot: number;
  name: string | null;
}
