import type { LobbyGame } from "./types.js";

const BASE = import.meta.env.VITE_API_URL ?? "";

let token: string | null = localStorage.getItem("settlers_token");

export function getToken(): string | null {
  return token;
}

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem("settlers_token", t);
  else localStorage.removeItem("settlers_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Request failed.");
  return data as T;
}

export interface AuthResponse {
  token: string;
  user: { id: string; username: string };
}

export const api = {
  register: (username: string, password: string) =>
    request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<{ user: { id: string; username: string } }>("/me"),
  listGames: () => request<{ open: LobbyGame[]; mine: LobbyGame[] }>("/games"),
  createGame: (name: string) =>
    request<{ game: LobbyGame }>("/games", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getGame: (id: string) => request<{ game: LobbyGame }>(`/games/${id}`),
  joinGame: (id: string) =>
    request<{ game: LobbyGame }>(`/games/${id}/join`, { method: "POST" }),
  leaveGame: (id: string) =>
    request<{ ok: boolean }>(`/games/${id}/leave`, { method: "POST" }),
  addBot: (id: string) =>
    request<{ game: LobbyGame }>(`/games/${id}/bots`, { method: "POST" }),
  removeBot: (id: string, botUserId: string) =>
    request<{ game: LobbyGame }>(`/games/${id}/bots/remove`, {
      method: "POST",
      body: JSON.stringify({ botUserId }),
    }),
};
