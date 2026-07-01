# Cities & Knights — Implementation Plan

> Status: **Approved.** Phase 0 (variant toggle) and Phase 1 (commodities +
> city improvements + metropolis) are **implemented** on this branch. Approved
> decisions: build Phase 1 first, functional bots, **13 VP** win target, full
> progress-card set (lands in Phase 4). This document describes the data model,
> phases, UI, and staged roadmap for the *Cities & Knights* (C&K) expansion as
> an **opt-in choice at game setup**, with the base game left fully intact when
> the toggle is off.
>
> **Delivered so far (Phase 0 + 1 + 2):**
> - *Phase 0/1:* `variant` threaded lobby → REST → engine → `GameState`; lobby
>   ruleset toggle; cities on forest/pasture/mountains produce a commodity
>   (paper/cloth/coin); three improvement tracks with per-level commodity costs;
>   level-4 **metropolis** (+2 VP, first-to-reach, transferable at level 5);
>   commodities counted toward the 7-card discard limit; 13-VP win target; HUD
>   commodity cards, Improve panel, per-track chips, board metropolis marker.
> - *Phase 2 (knights):* `KnightPiece` (rank basic/strong/mighty, active flag);
>   recruit (wool+ore), activate (grain), promote (wool+ore; Mighty needs
>   Politics 3), move/displace along your roads, and chase the robber with an
>   adjacent active knight; knights block settlement placement and count road
>   connectivity for their own placement. Bots recruit/activate a knight or two
>   and chase robbers off their tiles. Client renders knight shields (rank pips,
>   active dot, selection ring) and a Knights panel (recruit/activate/promote/
>   move/chase) with active-strength readouts on player cards.
>
> - *Phase 3 (barbarians + event die):* a coloured event die rolls alongside the
>   two number dice (3/6 faces = barbarian, one each trade/politics/science
>   gate). Barbarian faces advance a 7-step ship; on arrival, total **active**
>   knight strength is compared to the number of cities — defenders award the
>   single strongest player **Defender of Catan** (+1 VP), otherwise the weakest
>   city-owners each lose a city (least-valuable non-metropolis city downgraded).
>   Every knight deactivates after an attack and the ship resets. Bots rally
>   knights as the ship nears arrival. Client shows a barbarian tracker (ship
>   progress + strength-vs-cities balance + last event-die face) and defender
>   tokens on player cards.
>
> Verified: 16/16 all-bot games finish in **both** variants; metropolises appear
> broadly; across 16 C&K games the barbarians attacked 38 times, Defender of
> Catan was awarded 25 times, and cities were pillaged when defense fell short.
> Phase 4 (progress cards + city walls + gate draws) remains to do.

## 1. Goals & guardrails

- **Setup toggle.** The host chooses "Base game" or "Cities & Knights" when
  creating the lobby. A single `variant` flag flows from lobby → `createGame`
  → `GameState` and gates every rule branch.
- **Base game unchanged.** When `variant === "base"`, no C&K field is read and
  no C&K phase is reachable. All new engine branches begin with a
  `if (game.state.variant !== "cities_and_knights") return …` guard (or the
  inverse), so existing simulations and tests keep passing byte-for-byte.
- **Server-authoritative, same as today.** All new state lives in `GameState`,
  is mutated only in `engine.ts`, redacted per-player in `redactFor`, and
  persisted through the existing `state_json` column — no schema migration
  needed for the game state itself (it is already an opaque JSON blob).
- **Incremental, always shippable.** Delivered in 4 phases (§8). Each phase is
  a self-contained PR that leaves both variants playable start-to-finish.

## 2. Rules recap (what C&K actually adds)

For readers who don't know the expansion, the mechanics we must model:

1. **Commodities.** Three new tradeable goods on top of the 5 base resources:
   **coin** (from ore/mountain cities), **paper** (from lumber/forest cities),
   **cloth** (from wool/pasture cities). A **city** produces 1 of its terrain's
   base resource **and** 1 of the matching commodity when its number is rolled
   (a settlement still produces 1 base resource only). Brick and grain hills/
   fields have no commodity; a city there produces 2 of the base resource as in
   the base game.
2. **City improvements.** Commodities buy levels on three tracks:
   **Trade** (cloth), **Politics** (coin), **Science** (paper). Level *n* costs
   *n* commodities of that track's type (1+2+3+4+5). Each track has 5 levels;
   reaching a level unlocks abilities (see §4). The **first** player to reach
   level 4 on a track builds a **metropolis** on one of their cities (+2 VP,
   locked to that player for the rest of the game; worth defending).
3. **The city / event die.** Every roll uses **two** dice: the normal white/red
   number die (2d6 sum as today) **plus** a coloured **event die** with 6 faces:
   3× **barbarian ship**, and one each of **trade** (yellow gate), **politics**
   (blue gate), **science** (green gate). The gate faces let players who have
   the corresponding city-improvement level draw a **progress card**.
4. **Barbarians.** Each barbarian face advances the barbarian ship one step (7
   steps to arrive). On arrival, total **knight strength** of all players is
   compared to the number of **cities** on the board. If knights ≥ cities, the
   defenders win and the single player with the most active knight strength gets
   **Defender of Catan** (+1 VP progress card, or a VP token). If cities win,
   each player with the fewest active knights loses a **city** (downgraded to a
   settlement). Then the ship resets to step 0.
5. **Knights.** New piece type placed on vertices (like settlements but not
   worth VP). Ranks: **basic (1)**, **strong (2)**, **mighty (3)**. You *build*
   a knight (1 wool + 1 ore), *promote* it (1 wool + 1 ore, gated by Politics
   level for mighty), and *activate* it (1 grain) — only **active** knights
   count for barbarian defense and can act. An active knight can: **move** along
   roads, **displace** a weaker enemy knight, or **chase the robber** off a hex.
   Knights deactivate at the start of your turn (must re-pay grain to reactivate)
   and after acting.
6. **Progress cards.** Three decks (trade/politics/science) replacing the base
   dev-card deck in C&K games. Drawn on gate faces when you have the matching
   improvement level. Many are one-shot effects; a few are kept (e.g. victory
   point improvements). Hand limit of progress cards is 4 (config).
7. **City walls.** Buildable on a city (2 brick) — raises that player's discard
   limit from 7 to 9 (and to 11 with two, etc., capped). Protects against the
   "rob 7" and barbarian hand loss where relevant.
8. **Longest road / robber.** Unchanged, except the robber may not sit until the
   barbarians have first attacked once (standard C&K rule) — minor.

This is a large surface. §8 sequences it so the first PR delivers real,
satisfying gameplay (commodities + improvements + metropolis) without the
hardest AI/UX pieces (knights, barbarians).

## 3. Data model (shared/src/types.ts additions)

All additions are **optional** on `GameState`/`PlayerState` (undefined in base
games) so persisted base-game blobs deserialize unchanged.

```ts
// ---- Variant ----
export type GameVariant = "base" | "cities_and_knights";

// ---- Commodities ----
export type Commodity = "coin" | "paper" | "cloth";
export const COMMODITIES: Commodity[] = ["coin", "paper", "cloth"];
export type CommodityCounts = Record<Commodity, number>;

// Which commodity a terrain's CITY yields (undefined = none, e.g. hills/fields)
export const TERRAIN_COMMODITY: Partial<Record<Terrain, Commodity>> = {
  ore: "coin",      // mountains
  lumber: "paper",  // forest
  wool: "cloth",    // pasture
};

// ---- City improvements ----
export type ImprovementTrack = "trade" | "politics" | "science";
export const IMPROVEMENT_TRACKS: ImprovementTrack[] = ["trade", "politics", "science"];
// Commodity spent to advance each track:
export const TRACK_COMMODITY: Record<ImprovementTrack, Commodity> = {
  trade: "cloth", politics: "coin", science: "paper",
};
export type ImprovementLevels = Record<ImprovementTrack, number>; // 0..5

// ---- Knights ----
export type KnightRank = 1 | 2 | 3; // basic / strong / mighty
export interface KnightPiece {
  owner: PlayerColor;
  vertexId: number;
  rank: KnightRank;
  active: boolean;
}

// ---- Event die ----
export type EventDie = "barbarian" | "trade" | "politics" | "science";

// ---- Progress cards ----
export type ProgressCardKind = string; // enumerated per deck in phase 4 (see §7)
```

Extensions to existing interfaces (all optional / additive):

```ts
export interface PlayerState {
  // …existing…
  commodities?: CommodityCounts;              // C&K only
  improvements?: ImprovementLevels;           // C&K only
  progressCards?: ProgressCardKind[];         // C&K only (replaces devCards logic)
  cityWalls?: number;                          // count of walls built
  defenderTokens?: number;                     // Defender-of-Catan VP tokens
}

export interface BuildingPiece {
  // …existing…
  /** C&K: this city is a metropolis for the given track (worth +2 VP, locked). */
  metropolis?: ImprovementTrack;
}

export interface GameState {
  // …existing…
  variant: GameVariant;                        // "base" for all legacy games
  eventDie?: EventDie | null;                  // last event-die face
  barbarianStep?: number;                       // 0..7 position of the ship
  knights?: KnightPiece[];                      // C&K only
  /** First-to-reach-level-4 ownership per track (for metropolis + VP). */
  metropolisOwner?: Record<ImprovementTrack, PlayerColor | null>;
  progressDecks?: Record<ImprovementTrack, number>; // remaining counts (redacted)
  /** New C&K sub-phases layered onto the roll (see §5). */
}
```

New phases added to `GamePhase`:

```ts
| "resolve_barbarian"   // barbarians arrived: pick city to lose, award defender
| "knight_action"       // an activated knight is moving/displacing/chasing
| "place_metropolis"    // choosing which city becomes a metropolis
| "progress_card"       // resolving a drawn progress card that needs input
```

New constants:

```ts
export const KNIGHT_BUILD = { wool: 1, ore: 1 };
export const KNIGHT_ACTIVATE = { grain: 1 };
export const CITY_WALL_COST = { brick: 2 };
export const IMPROVEMENT_COST = (level: number) => level; // n commodities
export const BARBARIAN_TRACK_LENGTH = 7;
export const PROGRESS_HAND_LIMIT = 4;
export const CK_VICTORY_POINTS_TO_WIN = 13; // C&K wins at 13, not 10
export const KNIGHT_LIMITS = { total: 6 };   // per player, standard C&K
```

## 4. City-improvement abilities (what each level unlocks)

| Level | Trade (cloth) | Politics (coin) | Science (paper) |
|---|---|---|---|
| 1 | — | — | — |
| 2 | — | — | draw progress cards on 🟢 | 
| 3 | 2:1 trade w/ any 1 building | promote to Strong Knight | Crane: improvements −1 commodity |
| 4 | **Trade metropolis** (+2 VP) | **Politics metropolis** (+2 VP), promote to Mighty Knight | **Science metropolis** (+2 VP) |
| 5 | free building-in-any-port move | Fortress: activated knights survive… | Aqueduct: take any resource if you produced none |

(Exact ability text is finalized in Phase 4; levels 1–3 gate the progress-card
draw for that colour of gate on the event die.)

## 5. Turn / roll flow changes

Base game roll flow today: `rolling → (7? discard→moving_robber→robbing) → main`.

C&K roll flow (only when `variant === "cities_and_knights"`):

```
rolling:
  roll number die (2d6) + event die
  1. Production: distribute resources AND commodities (cities → +commodity)
  2. Event die:
     - barbarian: advance barbarianStep; if == 7 → resolve_barbarian phase
     - trade/politics/science gate: each player with that track ≥ level 2
       draws a progress card (respect hand limit)
     - the RED number die (Alchemist etc. aside) also drives the "special
       gate" draw eligibility — modelled as part of eventDie resolution
  3. If number == 7: robber/discard as base (city walls raise discard limit)
  4. → main
main: existing build/trade PLUS:
  - buy/promote/activate knight
  - move/act with an active knight (→ knight_action)
  - pay commodities to raise an improvement (→ maybe place_metropolis)
  - build city wall
resolve_barbarian: compare knight strength vs city count; downgrade cities or
  award Defender; reset ship; → main (or continue to whoever's turn)
```

The event die and barbarian resolution happen **inside the roller's turn** and
resolve before `main`, so the existing "one current player acts" invariant
holds; barbarian city-loss choices are collected as a mini sub-phase keyed by
color (like `pendingDiscards`).

## 6. Production changes

`distributeResources` gains a variant branch: for each building on a rolled hex,
- settlement → +1 base resource (unchanged);
- city on hills(brick)/fields(grain) → +2 base resource (unchanged);
- city on forest/pasture/mountains → +1 base resource **and** +1 commodity
  (`TERRAIN_COMMODITY[terrain]`).
Bank/commodity supply is effectively unlimited in C&K (no commodity shortage
rule in the base expansion), simplifying supply tracking.

## 7. Progress cards (Phase 4 detail)

Three 6-card-type decks (trade/politics/science). We will implement the
standard set; a handful need interactive resolution (`progress_card` phase),
most are immediate. Redaction: other players see only counts
(`progressDecks` + per-player hand size), never contents — mirrors today's
`devCards` redaction in `redactFor`. Card list, exact effects, and which need a
sub-phase are enumerated when Phase 4 is built; the toggle and decks are
scaffolded (empty/parametrised) in earlier phases so nothing else depends on
finalizing them.

## 8. Delivery roadmap (phased PRs)

**Phase 0 — Toggle & scaffolding (small, low-risk).**
- Add `GameVariant`, thread `variant` through: lobby create UI → `POST /games`
  body → `createLobby`/`createGame` → `GameState.variant` → `redactFor`.
- Lobby UI: a "Base game / Cities & Knights" segmented control on New Game
  (default Base). Waiting room shows a badge of the chosen variant.
- Engine reads `variant` but every C&K branch is a no-op stub. VP-to-win picks
  `CK_VICTORY_POINTS_TO_WIN` vs `VICTORY_POINTS_TO_WIN` by variant.
- **Outcome:** base game 100% unchanged; C&K games are playable but currently
  identical to base. Fully mergeable.

**Phase 1 — Commodities + city improvements + metropolis.**
- Add commodity production, commodity counts in `PlayerState`, hand/discard math
  including commodities, and the three improvement tracks with costs + level-4
  metropolis (+2 VP, first-come lock). No knights/barbarians yet — event die is
  rolled and shown but only gate draws that don't yet exist are skipped.
- Client: commodity cards in hand, an Improvements panel (3 tracks with buy
  buttons), metropolis marker on the board city.
- Bots: extend the greedy planner to spend commodities on improvements and
  value metropolis. Verify via all-bot sims (games finish, VP reaches 13).

**Phase 2 — Knights.**
- Knight pieces, build/promote/activate, movement/displace/chase-robber,
  knight strength bookkeeping. Client knight layer on the board + a knight
  control panel. Bot logic: build & activate knights, chase robber, basic
  defense. New `knight_action` phase.

**Phase 3 — Barbarians + event die resolution.**
- Barbarian ship tracker, arrival resolution (defense vs city count, Defender of
  Catan, city downgrade choice), the `resolve_barbarian` phase, and the barbarian
  face of the event die actually advancing the ship. Client: barbarian progress
  tracker UI. Bots respond to barbarian threat (activate knights before arrival).

**Phase 4 — Progress cards + city walls + polish.**
- Implement the three progress-card decks (replacing base dev deck in C&K),
  the `progress_card` phase for interactive cards, city walls (discard-limit
  raise), and the gate-draw eligibility from improvement levels. Client: progress
  card hand (reuse the existing clickable dev-card art system), wall toggle.

Each phase is an independent PR, individually verified with the existing
node all-bot simulation harness and Playwright iPhone screenshots, and merged
only after it leaves **both** variants finishable end-to-end.

## 9. Keeping the base game intact

- `variant` defaults to `"base"` everywhere; legacy persisted games (no field)
  are treated as `"base"` on load (`state.variant ??= "base"`).
- All new engine code is reached only under an explicit C&K guard; no base-game
  function signature changes (new params are optional).
- `redactFor` strips C&K hidden info (commodity counts stay visible like
  resources; progress-card contents hidden like dev cards) only when the fields
  exist — a no-op for base games.
- Existing simulations/tests run against `variant: "base"` and must stay green
  as the acceptance gate for every phase.

## 10. Open questions for approval

1. **Scope:** ship all 4 phases, or stop after Phase 1 (commodities +
   improvements + metropolis) and evaluate? Phase 1 alone is a meaningful,
   coherent "half-C&K" that's far cheaper than the knight/barbarian AI.
2. **Bot depth:** how clever should C&K bots be — "functional" (legal, finishes
   games, basic defense) or "competitive"? Functional is the assumed default.
3. **Win target:** confirm C&K uses **13** VP (standard) rather than 10.
4. **Progress-card fidelity:** full standard deck, or a curated subset for v1?
```
