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
- **Invite links** — share a deep link (`?game=<id>`); opening it logs in and seats you automatically.
- **Optional AI bots** — the host can fill any open seat with a greedy AI bot; bots play
  their turns automatically (2–4 players total; the base game is best with 3–4).

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

## Deploy (Docker, self-host)

The app ships as a **single container**: a multi-stage build compiles all three
workspaces, and the Node server serves the built client from the same origin
(so `/`, `/api`, and `/ws` are all one service — no CORS or split hosting needed).
The SQLite database lives on a named volume, so accounts and in-progress games
survive restarts and image rebuilds.

```bash
cp .env.example .env          # then set a strong JWT_SECRET (openssl rand -hex 32)
docker compose up -d --build  # build + run, detached
# open http://localhost:4000
```

- Data persists in the `settlers-data` volume (mounted at `/data`). It is not
  removed by `docker compose down`; use `docker compose down -v` to wipe it.
- Update after code changes: `docker compose up -d --build`.
- Logs / status: `docker compose logs -f` · `docker compose ps`.
- Without compose:
  ```bash
  docker build -t settlers .
  docker run -d -p 4000:4000 -e JWT_SECRET=$(openssl rand -hex 32) \
    -v settlers-data:/data settlers
  ```

### Putting it on the internet

The container speaks plain HTTP on port 4000. For a public deployment, front it
with a TLS-terminating reverse proxy (Caddy, nginx, or your host's load balancer)
that also upgrades WebSocket connections on `/ws`. The client automatically uses
`wss://` when the page is served over HTTPS, so no client config is needed when
everything is behind one HTTPS origin.

> Verified in this repo: production single-process mode (server serving
> `client/dist` + SQLite at `DATABASE_PATH`) and the compose config. The image
> build itself must be run where Docker Hub is reachable.

## Deploy to Azure (GitHub Actions → App Service)

Continuous deployment is wired up so that **every push to `main` builds the
container, pushes it to GitHub Container Registry (GHCR), and deploys it to
Azure App Service for Containers** — using OIDC, so no long-lived Azure
credentials are stored in GitHub.

| Piece | File |
|-------|------|
| CD pipeline | `.github/workflows/deploy.yml` |
| Infrastructure (App Service plan + Web App) | `infra/main.bicep` |
| One-time Azure/OIDC bootstrap | `infra/azure-setup.sh` |

### One-time setup

Run the bootstrap **locally**, where you're logged in to Azure (it's the only
step that needs your Azure credentials):

```bash
az login
az account set --subscription "<your-subscription>"
./infra/azure-setup.sh --gh     # provisions OIDC + RG, sets GitHub secrets/vars via gh
```

It creates a resource group, an Entra ID app + service principal with a GitHub
OIDC federated credential (scoped to this repo's `production` environment), and
prints/sets the values the workflow needs:

- **Secrets:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `JWT_SECRET`
- **Variables:** `AZURE_RESOURCE_GROUP`, `AZURE_WEBAPP_NAME`, `AZURE_LOCATION`

Then push to `main` (or run the **Deploy to Azure** workflow manually). After the
first deploy, make the GHCR package public (GitHub → Packages → `settlers` →
visibility → Public) so App Service can pull it — or keep it private and pass
`registryUsername`/`registryPassword` to the Bicep.

### What gets provisioned

- A Linux **App Service for Containers** (B1 plan) with **WebSockets enabled**,
  HTTPS-only, `Always On`, and a `/health` health check.
- `WEBSITES_PORT=4000` so App Service routes to the container.
- SQLite stored at `/home/data/settlers.db` on App Service's **persistent
  `/home` storage**, so games and accounts survive restarts and redeploys.

> ⚠️ **Single instance only.** SQLite is not safe for concurrent writers, so do
> not scale this App Service out beyond one instance. To run multiple instances
> or use autoscale, migrate persistence to a managed database (e.g. Azure
> Database for PostgreSQL) — a natural next step if you outgrow a single node.

## Other production options

- **Static + separate API:** `npm run build`, serve `client/dist` from any static
  host, run `npm start` for the API, and point the client at it with `VITE_API_URL`
  / `VITE_WS_URL`. (The Docker single-origin setup above avoids needing these.)
- Always set a strong `JWT_SECRET` and serve over HTTPS.

## Known simplifications / next steps

- AI bots are intentionally simple (greedy: best-spot settlements/cities, opportunistic
  roads, dev-card buys). They offer and accept trades that move them toward their next
  build, but don't yet play knights/dev cards — room to grow.
- Player-to-player trading is a simple open offer + accept (no counter-offers yet).
- Dev cards limited to one play per turn (per the rules); deck reshuffling not needed (single deck).
- Spectators, chat, game history, and rematch are not implemented.
- Board uses a simple shuffle; the official "no adjacent red 6/8" number-placement constraint
  is not enforced.
