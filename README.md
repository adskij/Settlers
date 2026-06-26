# ⚓ Settlers — Browser Multiplayer (Base Game)

A browser-based, mobile-adapted multiplayer settlement-and-trading game for **4 players**.
Each player logs in individually from their own device and plays in real time against the
others. The server is fully authoritative — every move is validated server-side, so the
client cannot cheat.

> This is an original implementation of the *mechanics* of a classic resource-trading board
> game. It ships with no trademarked names or artwork. Replace placeholder terminology and
> visuals before any public deployment.

## Features

- **Individual accounts** — register / log in (JWT auth, bcrypt-hashed passwords).
- **Lobby** — create a game, share it, others join an open seat (up to 4); host starts.
- **Real-time play** over WebSockets with a server-authoritative game state.
- **Persistence** — accounts and in-progress games are stored in SQLite and survive a
  server restart (games reload from disk on demand).
- **Reconnect-friendly** — the client auto-reconnects and resyncs full state.
- **Mobile-first UI** — responsive SVG board, touch-sized controls, safe-area insets,
  no-zoom viewport; reflows to a side panel on large landscape screens.
- **No AI** — strictly human players (2–4; the base game is best with 3–4).

### Base-game rules implemented

- 19-hex board, randomized terrain / number tokens / ports, robber on the desert.
- Initial placement in snake order (settlement + road ×2), second settlement grants resources.
- Dice roll → resource production (settlements ×1, cities ×2).
- Building: roads, settlements (distance rule + road connectivity), city upgrades.
- Development cards: knight, victory point, road building, year of plenty, monopoly.
- Rolling a 7: discard (hand > 7), move robber, steal a random card.
- Trading: bank/port trades (4:1, 3:1, 2:1) and player-to-player offers.
- Longest Road (DFS, opponent buildings break paths) and Largest Army bonuses.
- First to **10 victory points** wins. Hidden VP cards stay secret until the game ends.

## Tech stack

| Layer        | Choice |
|--------------|--------|
| Frontend     | React 18 + TypeScript + Vite, SVG board (no game-engine deps) |
| Backend      | Node + Express + `ws` WebSocket server, TypeScript |
| Persistence  | SQLite via `better-sqlite3` |
| Auth         | JWT (`jsonwebtoken`) + `bcryptjs` |
| Shared code  | `@settlers/shared` workspace — domain types, board geometry, protocol |

The board geometry (hexes → vertices → edges → ports) is generated deterministically from a
stored numeric seed, so a game's board is reproducible and the same module renders the board
on the client and validates moves on the server.

## Project layout

```
shared/   @settlers/shared — types, board generation, dev deck, WS protocol
server/   Express + ws API, SQLite persistence, auth, lobby, rule engine
client/   Vite + React mobile-adapted UI
```

Key server files: `engine.ts` (all rules), `gameManager.ts` (runtime + persistence),
`ws.ts` (socket gateway + per-game broadcast with hidden-info redaction), `routes.ts`
(auth + lobby REST), `auth.ts`, `db.ts`.

## Getting started

Requires **Node 20+**.

```bash
npm install                 # installs all workspaces
cp server/.env.example server/.env   # optional; set JWT_SECRET for anything real

npm run dev                 # builds shared, runs server (:4000) + client (:5173)
```

Open http://localhost:5173. To play a real 4-player game, open it on four devices/browsers
(the Vite dev server proxies `/api` and `/ws` to the backend). For phones on your LAN, run
`npm run dev:client -- --host` and point them at your machine's IP.

### Individual commands

```bash
npm run build:shared        # compile shared types/geometry
npm run dev:server          # backend only (tsx watch)
npm run dev:client          # frontend only (vite)
npm run build               # production build of all three packages
npm start                   # run the built server
```

## Configuration

Server (`server/.env`):

| Var             | Default                        | Notes |
|-----------------|--------------------------------|-------|
| `PORT`          | `4000`                         | HTTP + WS port |
| `JWT_SECRET`    | `dev-insecure-secret-change-me`| **change in production** |
| `DATABASE_PATH` | `./data/settlers.db`           | SQLite file |

Client build-time vars (optional): `VITE_API_URL`, `VITE_WS_URL` (absolute URLs when the
API is hosted separately from the static client); `VITE_API_TARGET` (dev proxy target).

## Production notes

- `npm run build` then serve `client/dist` from any static host and run `npm start` for the API.
- Point the client at the API with `VITE_API_URL` / `VITE_WS_URL` if they're on different origins.
- Set a strong `JWT_SECRET` and serve over HTTPS (the client uses `wss://` automatically on HTTPS).

## Known simplifications / next steps

- No AI / bots (by design).
- Player-to-player trading is a simple open offer + accept (no counter-offers yet).
- Dev cards limited to one play per turn (per the rules); deck reshuffling not needed (single deck).
- Spectators, chat, game history, and rematch are not implemented.
- Board uses a simple shuffle; the official "no adjacent red 6/8" number-placement constraint
  is not enforced.
