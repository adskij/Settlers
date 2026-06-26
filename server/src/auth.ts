import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { db, type UserRow } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-insecure-secret-change-me";
const TOKEN_TTL = "30d";

export interface AuthTokenPayload {
  userId: string;
  username: string;
}

export function registerUser(username: string, password: string): UserRow {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 20) {
    throw new HttpError(400, "Username must be 3-20 characters.");
  }
  if (password.length < 6) {
    throw new HttpError(400, "Password must be at least 6 characters.");
  }
  const existing = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(trimmed);
  if (existing) throw new HttpError(409, "Username already taken.");

  const user: UserRow = {
    id: randomUUID(),
    username: trimmed,
    password_hash: bcrypt.hashSync(password, 10),
    created_at: Date.now(),
  };
  db.prepare(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(user.id, user.username, user.password_hash, user.created_at);
  return user;
}

export function loginUser(username: string, password: string): UserRow {
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username.trim()) as UserRow | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    throw new HttpError(401, "Invalid username or password.");
  }
  return user;
}

export function signToken(user: UserRow): string {
  const payload: AuthTokenPayload = {
    userId: user.id,
    username: user.username,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
