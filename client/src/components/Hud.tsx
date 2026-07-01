import { useEffect, useRef, useState } from "react";
import {
  BUILD_COSTS,
  RESOURCES,
  COMMODITIES,
  IMPROVEMENT_TRACKS,
  TRACK_COMMODITY,
  MAX_IMPROVEMENT_LEVEL,
  METROPOLIS_LEVEL,
  improvementCost,
  VICTORY_POINTS_TO_WIN,
  CK_VICTORY_POINTS_TO_WIN,
  KNIGHT_LIMIT,
  KNIGHT_MAX_RANK,
  KNIGHT_RANK_NAME,
  MIGHTY_KNIGHT_POLITICS_LEVEL,
  KNIGHT_BUILD_COST,
  KNIGHT_ACTIVATE_COST,
  KNIGHT_PROMOTE_COST,
  BARBARIAN_TRACK_LENGTH,
  PROGRESS_CARD_INFO,
  PROGRESS_HAND_LIMIT,
  MAX_CITY_WALLS,
  type ClientMessage,
  type Commodity,
  type DevCardKind,
  type EventDie,
  type GameState,
  type ImprovementTrack,
  type KnightPiece,
  type PlayerColor,
  type PlayerState,
  type ProgressCardKind,
  type Resource,
  type ResourceCounts,
} from "@settlers/shared";
import type { BuildMode } from "./GameScreen.js";

const RES_ICON: Record<Resource, string> = {
  brick: "🧱",
  lumber: "🌲",
  wool: "🐑",
  grain: "🌾",
  ore: "⛰️",
};

const COMMODITY_ICON: Record<Commodity, string> = {
  coin: "🪙",
  paper: "📜",
  cloth: "🧵",
};

const TRACK_META: Record<ImprovementTrack, { icon: string; label: string; metro: string }> = {
  trade: { icon: "🧵", label: "Trade", metro: "Market → Trading House → Merchant Guild" },
  politics: { icon: "🪙", label: "Politics", metro: "Town Hall → Fortress → Capitol" },
  science: { icon: "📜", label: "Science", metro: "Library → University → Great Wonder" },
};

const EVENT_DIE_META: Record<EventDie, { icon: string; label: string; cls: string }> = {
  barbarian: { icon: "🚢", label: "Barbarians", cls: "ev-barbarian" },
  trade: { icon: "🟡", label: "Trade gate", cls: "ev-trade" },
  politics: { icon: "🔵", label: "Politics gate", cls: "ev-politics" },
  science: { icon: "🟢", label: "Science gate", cls: "ev-science" },
};

// A coloured chip showing the last event-die face rolled.
function EventDieChip({ face }: { face: EventDie }) {
  const m = EVENT_DIE_META[face];
  return (
    <span className={`event-die-chip ${m.cls}`} title={`Event die: ${m.label}`}>
      {m.icon} {m.label}
    </span>
  );
}

function isCK(state: GameState): boolean {
  return state.variant === "cities_and_knights";
}

function winTargetOf(state: GameState): number {
  return isCK(state) ? CK_VICTORY_POINTS_TO_WIN : VICTORY_POINTS_TO_WIN;
}

function commodityTotal(p: PlayerState): number {
  if (!p.commodities) return 0;
  return COMMODITIES.reduce((s, c) => s + (p.commodities![c] ?? 0), 0);
}

// Sum of ranks of a player's *active* knights (their barbarian-defense strength).
function knightStrengthOf(state: GameState, color: PlayerColor): number {
  return (state.knights ?? [])
    .filter((k) => k.owner === color && k.active)
    .reduce((s, k) => s + k.rank, 0);
}

const DEV_META: Record<DevCardKind, { icon: string; label: string }> = {
  knight: { icon: "⚔️", label: "Knight" },
  victory_point: { icon: "⭐", label: "Victory Pt" },
  road_building: { icon: "🛣️", label: "Road Build" },
  year_of_plenty: { icon: "🌾", label: "Year/Plenty" },
  monopoly: { icon: "💰", label: "Monopoly" },
};
const DEV_ORDER: DevCardKind[] = [
  "knight",
  "victory_point",
  "road_building",
  "year_of_plenty",
  "monopoly",
];

// Full name + what the card does, shown when a card is tapped.
const DEV_INFO: Record<DevCardKind, { name: string; desc: string }> = {
  knight: {
    name: "Knight",
    desc: "Move the robber to any other hex, then steal a random resource from a player with a building there. Play 3 knights to claim Largest Army (+2 victory points).",
  },
  victory_point: {
    name: "Victory Point",
    desc: "Worth 1 victory point. It stays hidden in your hand and counts toward the 10 points you need to win.",
  },
  road_building: {
    name: "Road Building",
    desc: "Immediately place 2 roads for free, anywhere they connect to your network.",
  },
  year_of_plenty: {
    name: "Year of Plenty",
    desc: "Take any 2 resource cards of your choice from the bank.",
  },
  monopoly: {
    name: "Monopoly",
    desc: "Name one resource — every other player must hand you all of their cards of that type.",
  },
};

// Themed gradient colours for each card's illustration.
const DEV_ART: Record<DevCardKind, [string, string]> = {
  knight: ["#6b7a90", "#2b3647"],
  victory_point: ["#f3cf5a", "#b8801f"],
  road_building: ["#5a8f6a", "#2f5a3a"],
  year_of_plenty: ["#e8b25a", "#b06a2a"],
  monopoly: ["#8a6cc0", "#4a2f86"],
};

// Group the viewer's own dev cards (playable now vs. bought this turn).
function devHand(me: PlayerState) {
  const g: Partial<Record<DevCardKind, { playable: number; pending: number }>> = {};
  const bump = (k: DevCardKind, key: "playable" | "pending") => {
    (g[k] ??= { playable: 0, pending: 0 })[key]++;
  };
  for (const k of me.devCards) bump(k, "playable");
  for (const k of me.newDevCards) bump(k, "pending");
  for (let i = 0; i < me.victoryPointCards; i++) bump("victory_point", "playable");
  return DEV_ORDER.filter((k) => g[k]).map((k) => ({ kind: k, ...g[k]! }));
}

// Public victory points (hidden VP cards are redacted server-side).
function publicVP(state: GameState, color: PlayerColor): number {
  let vp = 0;
  for (const b of state.buildings)
    if (b.owner === color) vp += b.kind === "city" ? 2 : 1;
  const p = state.players.find((pl) => pl.color === color);
  if (p) vp += p.victoryPointCards; // 0 for others until game ends
  if (state.largestArmyOwner === color) vp += 2;
  if (state.longestRoadOwner === color) vp += 2;
  if (state.metropolisOwner) {
    for (const track of IMPROVEMENT_TRACKS) {
      if (state.metropolisOwner[track] === color) vp += 2; // C&K metropolis
    }
  }
  if (p?.defenderTokens) vp += p.defenderTokens; // C&K Defender of Catan tokens
  return vp;
}

function bankRate(state: GameState, color: PlayerColor, resource: Resource): number {
  const ports = new Set<string>();
  for (const b of state.buildings) {
    if (b.owner !== color) continue;
    const port = state.board.vertices[b.vertexId].port;
    if (port) ports.add(port);
  }
  const base = ports.has(resource) ? 2 : ports.has("any") ? 3 : 4;
  // Merchant Fleet: every bank trade this turn is at least 2:1.
  const me = state.players.find((p) => p.color === color);
  return me?.tradeFleetTurn ? Math.min(2, base) : base;
}

function total(p: PlayerState): number {
  return RESOURCES.reduce((s, r) => s + p.resources[r], 0);
}

export function Hud({
  state,
  you,
  send,
  error,
  clearError,
  buildMode,
  setBuildMode,
  knightMoveFrom = null,
  startKnightMove,
  cancelKnightMove,
  selectedKnight = null,
  setSelectedKnight,
}: {
  state: GameState;
  you: PlayerColor | null;
  send: (msg: ClientMessage) => void;
  error: string | null;
  clearError: () => void;
  buildMode: BuildMode;
  setBuildMode: (m: BuildMode) => void;
  knightMoveFrom?: number | null;
  startKnightMove?: (vertexId: number) => void;
  cancelKnightMove?: () => void;
  selectedKnight?: number | null;
  setSelectedKnight?: (v: number | null) => void;
}) {
  const me = state.players.find((p) => p.color === you) ?? null;
  const isYourTurn = state.players[state.currentPlayerIndex]?.color === you;
  const ck = isCK(state);
  const [panel, setPanel] = useState<"none" | "bank" | "trade" | "dev" | "improve" | "knights">("none");
  const [showCosts, setShowCosts] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showVp, setShowVp] = useState(false);
  const [infoCard, setInfoCard] = useState<DevCardKind | null>(null);
  const [progCard, setProgCard] = useState<ProgressCardKind | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick once a second while any offer has a countdown, to refresh the timer.
  const hasTimedTrade = state.pendingTrades.some((t) => t.expiresAt);
  useEffect(() => {
    if (!hasTimedTrade) return;
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [hasTimedTrade]);

  // Auto-decline incoming offers I can't actually accept (I don't hold the
  // resources they're asking for), so they don't clutter the trade panel.
  const autoDeclined = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!me) return;
    for (const t of state.pendingTrades) {
      if (t.from === you || (t.to && t.to !== you)) continue; // not an offer to me
      const iCanAfford = RESOURCES.every((r) => me.resources[r] >= (t.receive[r] ?? 0));
      if (!iCanAfford && !autoDeclined.current.has(t.id)) {
        autoDeclined.current.add(t.id);
        send({ type: "decline_trade", tradeId: t.id });
      }
    }
  }, [state.pendingTrades, me, you, send]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 4000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  const owesDiscard = you ? state.pendingDiscards[you] : undefined;

  return (
    <div className="hud">
      {error && <div className="toast error" onClick={clearError}>{error}</div>}
      {showCosts && <CostsModal winTarget={winTargetOf(state)} onClose={() => setShowCosts(false)} />}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
      {showVp && me && <VpBreakdownModal state={state} me={me} onClose={() => setShowVp(false)} />}
      {infoCard && <DevCardInfoModal kind={infoCard} onClose={() => setInfoCard(null)} />}
      {progCard && (
        <ProgressCardModal
          kind={progCard}
          me={me}
          canPlay={isYourTurn && state.phase === "main"}
          onPlay={(msg) => {
            send(msg);
            setProgCard(null);
          }}
          onClose={() => setProgCard(null)}
        />
      )}

      {/* Players strip: a card per player with VP + hand clearly shown */}
      <div className="players-strip">
        {state.players.map((p, i) => {
          const devCount = p.devCards.length + p.newDevCards.length;
          return (
            <div
              key={p.color}
              className={`player-card ${p.color} ${
                i === state.currentPlayerIndex ? "active" : ""
              } ${p.color === you ? "you" : ""}`}
            >
              <div className="pc-top">
                <span className={`color-swatch ${p.color}`} />
                <span className="pc-name">
                  {p.isBot ? "🤖 " : ""}
                  {p.name}
                  {p.color === you ? " (you)" : ""}
                </span>
                {!p.connected && !p.isBot && (
                  <span className="off-dot" title="disconnected">●</span>
                )}
              </div>
              <div className="pc-stats">
                <span className="pc-vp" title="Victory points">
                  {publicVP(state, p.color)}
                  <small>VP</small>
                </span>
                <span className="pc-pill" title="Resource cards in hand">
                  <i className="mini-card res" />
                  {total(p)}
                </span>
                <span className="pc-pill" title="Development cards in hand">
                  <i className="mini-card dev" />
                  {devCount}
                </span>
                {ck && (
                  <span className="pc-pill" title="Commodity cards in hand">
                    <i className="mini-card com" />
                    {commodityTotal(p)}
                  </span>
                )}
              </div>
              <div className="pc-tags">
                {state.longestRoadOwner === p.color && (
                  <span className="pc-tag" title="Longest Road (+2 VP)">🛣️</span>
                )}
                {state.largestArmyOwner === p.color && (
                  <span className="pc-tag" title="Largest Army (+2 VP)">🎖️</span>
                )}
                {ck && state.metropolisOwner &&
                  IMPROVEMENT_TRACKS.filter((t) => state.metropolisOwner![t] === p.color).map((t) => (
                    <span key={t} className="pc-tag" title={`${TRACK_META[t].label} metropolis (+2 VP)`}>
                      🏛️
                    </span>
                  ))}
                {ck && knightStrengthOf(state, p.color) > 0 && (
                  <span className="pc-tag muted" title="Active knight strength">
                    ⚔️ {knightStrengthOf(state, p.color)}
                  </span>
                )}
                {ck && (p.defenderTokens ?? 0) > 0 && (
                  <span className="pc-tag" title="Defender of Catan (+1 VP each)">
                    🛡️ {p.defenderTokens}
                  </span>
                )}
                {!ck && p.playedKnights > 0 && (
                  <span className="pc-tag muted" title="Knights played">
                    ⚔️ {p.playedKnights}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Special awards: Longest Road & Largest Army (each worth 2 VP) */}
      <AwardsBar state={state} you={you} />

      {/* Cities & Knights: the advancing barbarian ship */}
      {ck && <BarbarianTracker state={state} />}

      {/* Pending trade offers */}
      {state.pendingTrades.length > 0 && (
        <div className="trade-offers">
          {state.pendingTrades.map((t) => {
            const fromName = state.players.find((p) => p.color === t.from)?.name ?? t.from;
            const mine = t.from === you;
            const forMe = !mine && (t.to === null || t.to === you);
            const canAccept =
              forMe && !!me && RESOURCES.every((r) => me.resources[r] >= (t.receive[r] ?? 0));
            const secsLeft = t.expiresAt
              ? Math.max(0, Math.ceil((t.expiresAt - nowMs) / 1000))
              : null;
            return (
              <div key={t.id} className="trade-offer">
                <span className="trade-text">
                  <strong>{fromName}</strong> gives {fmtBundle(t.give)} for{" "}
                  {fmtBundle(t.receive)}
                  {secsLeft != null && <span className="trade-timer"> · {secsLeft}s</span>}
                </span>
                <span className="trade-actions">
                  {canAccept && (
                    <button
                      className="btn sm primary"
                      onClick={() => send({ type: "accept_trade", tradeId: t.id })}
                    >
                      Accept{secsLeft != null ? ` (${secsLeft}s)` : ""}
                    </button>
                  )}
                  {forMe && (
                    <button
                      className="btn sm ghost"
                      onClick={() => send({ type: "decline_trade", tradeId: t.id })}
                    >
                      Decline
                    </button>
                  )}
                  {mine && (
                    <button
                      className="btn sm"
                      onClick={() => send({ type: "cancel_trade", tradeId: t.id })}
                    >
                      Cancel
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Your panel: victory points, resource cards, dev cards */}
      {me && (
        <div className="me-panel">
          <div className="me-top">
            <button
              type="button"
              className="vp-badge as-btn"
              title="Tap for a breakdown of your victory points"
              onClick={() => setShowVp(true)}
            >
              <span className="vp-star">★</span>
              <span className="vp-count">{publicVP(state, me.color)}</span>
              <span className="vp-of">/ {winTargetOf(state)}</span>
              <span className="vp-text">Victory Points</span>
              <span className="vp-info" aria-hidden>ⓘ</span>
            </button>
            <button
              className="btn sm costs-btn"
              onClick={() => setShowCosts(true)}
              title="Show building costs"
            >
              📋 Costs
            </button>
            {ck && (
              <button
                className="btn sm costs-btn"
                onClick={() => setShowRules(true)}
                title="How Cities & Knights works"
              >
                📖 C&amp;K Rules
              </button>
            )}
          </div>

          <div className="res-cards">
            {RESOURCES.map((r) => (
              <div key={r} className={`res-card res-${r}`} title={r}>
                <span className="rc-icon">{RES_ICON[r]}</span>
                <span className="rc-name">{r}</span>
                <span className="rc-count">{me.resources[r]}</span>
              </div>
            ))}
          </div>

          {ck && me.commodities && (
            <div className="res-cards commodity-cards">
              {COMMODITIES.map((c) => (
                <div key={c} className={`res-card com-${c}`} title={c}>
                  <span className="rc-icon">{COMMODITY_ICON[c]}</span>
                  <span className="rc-name">{c}</span>
                  <span className="rc-count">{me.commodities![c]}</span>
                </div>
              ))}
            </div>
          )}

          {ck && me.improvements && (
            <div className="improve-track-row">
              {IMPROVEMENT_TRACKS.map((t) => (
                <span key={t} className="improve-chip" title={`${TRACK_META[t].label} level`}>
                  {TRACK_META[t].icon}
                  <em>
                    {me.improvements![t]}
                    {state.metropolisOwner?.[t] === me.color ? "🏛️" : ""}
                  </em>
                </span>
              ))}
            </div>
          )}

          {devHand(me).length > 0 && (
            <div className="dev-hand">
              {devHand(me).map((d) => (
                <button
                  key={d.kind}
                  type="button"
                  className={`dev-card-mini ${d.pending && !d.playable ? "pending" : ""}`}
                  title="Tap to see what this card does"
                  onClick={() => setInfoCard(d.kind)}
                >
                  <span className="dc-icon">{DEV_META[d.kind].icon}</span>
                  <span className="dc-label">{DEV_META[d.kind].label}</span>
                  {d.playable + d.pending > 1 && (
                    <span className="dc-count">×{d.playable + d.pending}</span>
                  )}
                  {d.pending > 0 && <span className="dc-new">new</span>}
                  <span className="dc-info" aria-hidden>ⓘ</span>
                </button>
              ))}
            </div>
          )}

          {ck && me.progressCards && me.progressCards.length > 0 && (
            <div className="dev-hand progress-hand">
              {me.progressCards.map((card, i) => {
                const info = PROGRESS_CARD_INFO[card];
                return (
                  <button
                    key={`${card}-${i}`}
                    type="button"
                    className={`dev-card-mini prog-${info.deck}`}
                    title="Tap to read and play this progress card"
                    onClick={() => setProgCard(card)}
                  >
                    <span className="dc-icon">{info.icon}</span>
                    <span className="dc-label">{info.name}</span>
                    <span className="dc-info" aria-hidden>ⓘ</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Phase-specific prompts */}
      <div className="prompt-bar">
        <PromptText state={state} you={you} isYourTurn={isYourTurn} />
      </div>

      {isYourTurn && buildMode === "knight" && (
        <div className="prompt-bar knight-hint">
          <span className="prompt-hot">⚔️ Tap a highlighted spot to place your knight.</span>
        </div>
      )}
      {isYourTurn && buildMode === "wall" && (
        <div className="prompt-bar knight-hint">
          <span className="prompt-hot">🧱 Tap one of your cities to build a wall.</span>
        </div>
      )}
      {isYourTurn && knightMoveFrom != null && (
        <div className="prompt-bar knight-hint">
          <span className="prompt-hot">⚔️ Tap a highlighted spot to move your knight.</span>
          <button className="btn sm ghost" onClick={() => cancelKnightMove?.()}>Cancel</button>
        </div>
      )}
      {ck && selectedKnight != null && me && (() => {
        const k = state.knights?.find((kk) => kk.vertexId === selectedKnight && kk.owner === you);
        if (!k) return null;
        return (
          <SelectedKnightBar
            state={state}
            me={me}
            knight={k}
            canAct={isYourTurn && state.phase === "main"}
            send={send}
            onMove={(v) => startKnightMove?.(v)}
            onClose={() => setSelectedKnight?.(null)}
          />
        );
      })()}

      {/* Discard panel */}
      {owesDiscard ? (
        <DiscardPanel me={me!} owed={owesDiscard} send={send} />
      ) : (
        <>
          {/* Action bar */}
          {isYourTurn && state.phase === "rolling" && (
            <div className="action-bar">
              <button className="btn primary big" onClick={() => send({ type: "roll_dice" })}>
                🎲 Roll
              </button>
              {me && me.devCards.includes("knight") && (
                <button className="btn" onClick={() => send({ type: "play_knight" })}>
                  ⚔️ Knight
                </button>
              )}
            </div>
          )}

          {isYourTurn && state.phase === "main" && (
            <div className="action-bar">
              <ToolBtn label="🛣️ Road" active={buildMode === "road"} onClick={() => setBuildMode(buildMode === "road" ? null : "road")} />
              <ToolBtn label="🏠 Settle" active={buildMode === "settlement"} onClick={() => setBuildMode(buildMode === "settlement" ? null : "settlement")} />
              <ToolBtn label="🏙️ City" active={buildMode === "city"} onClick={() => setBuildMode(buildMode === "city" ? null : "city")} />
              {!ck && (
                <>
                  <button className="btn" onClick={() => send({ type: "buy_dev_card" })}>🃏 Buy</button>
                  <button className="btn" onClick={() => setPanel(panel === "dev" ? "none" : "dev")}>Play card</button>
                </>
              )}
              {ck && (
                <ToolBtn label="🧱 Wall" active={buildMode === "wall"} onClick={() => setBuildMode(buildMode === "wall" ? null : "wall")} />
              )}
              {ck && (
                <button className="btn" onClick={() => setPanel(panel === "improve" ? "none" : "improve")}>
                  🏛️ Improve
                </button>
              )}
              {ck && (
                <button className="btn" onClick={() => setPanel(panel === "knights" ? "none" : "knights")}>
                  ⚔️ Knights
                </button>
              )}
              <button className="btn" onClick={() => setPanel(panel === "bank" ? "none" : "bank")}>🏦 Bank</button>
              <button className="btn" onClick={() => setPanel(panel === "trade" ? "none" : "trade")}>🤝 Offer</button>
              <button className="btn primary" onClick={() => send({ type: "end_turn" })}>End turn ⏭️</button>
            </div>
          )}

          {isYourTurn && state.phase === "main" && panel === "bank" && (
            <BankPanel state={state} you={you!} send={send} />
          )}
          {isYourTurn && state.phase === "main" && panel === "trade" && (
            <OfferPanel send={send} />
          )}
          {isYourTurn && state.phase === "main" && panel === "dev" && me && (
            <DevPanel me={me} send={send} onPlayed={() => setPanel("none")} />
          )}
          {isYourTurn && state.phase === "main" && panel === "improve" && me && ck && (
            <ImprovePanel state={state} me={me} send={send} />
          )}
          {isYourTurn && state.phase === "main" && panel === "knights" && me && ck && (
            <KnightsPanel
              state={state}
              me={me}
              send={send}
              onRecruit={() => {
                setBuildMode("knight");
                setPanel("none");
              }}
              onMove={(v) => {
                startKnightMove?.(v);
                setPanel("none");
              }}
              onSelect={(v) => {
                setSelectedKnight?.(v);
                setPanel("none");
              }}
            />
          )}
        </>
      )}

      {/* Log */}
      <div className="log">
        {state.log.slice(-5).map((l, i) => (
          <div key={i} className="log-line">{l}</div>
        ))}
      </div>
    </div>
  );
}

function PromptText({
  state,
  you,
  isYourTurn,
}: {
  state: GameState;
  you: PlayerColor | null;
  isYourTurn: boolean;
}) {
  if (state.phase === "finished")
    return <span>🏆 {state.winner} wins the game!</span>;
  if (isYourTurn && state.phase === "main" && state.freeRoadsRemaining > 0)
    return (
      <span className="prompt-hot">
        🛣️ Road Building: place {state.freeRoadsRemaining} free road
        {state.freeRoadsRemaining > 1 ? "s" : ""} — tap a highlighted edge.
      </span>
    );
  if (state.phase === "setup") {
    if (!isYourTurn) return <span>Setup: waiting for {state.players[state.currentPlayerIndex]?.name}…</span>;
    return <span>Setup: tap a spot to place your {state.setupStep}.</span>;
  }
  if (state.phase === "discard") {
    const owe = you ? state.pendingDiscards[you] : undefined;
    return <span>{owe ? `Discard ${owe} cards.` : "Waiting for others to discard…"}</span>;
  }
  if (state.phase === "moving_robber")
    return <span>{isYourTurn ? "Tap a hex to move the robber." : "Waiting for the robber…"}</span>;
  if (state.phase === "rolling")
    return <span>{isYourTurn ? "Roll the dice to begin your turn." : "Waiting for the roll…"}</span>;
  if (state.dice)
    return (
      <span className="roll-line">
        Rolled {state.dice[0] + state.dice[1]} 🎲 ({state.dice[0]}+{state.dice[1]})
        {state.eventDie && (
          <>
            {" "}·<EventDieChip face={state.eventDie} />
          </>
        )}
      </span>
    );
  return <span>{isYourTurn ? "Build, trade, or end your turn." : "Opponent's turn."}</span>;
}

// Longest Road & Largest Army holders (each +2 VP). Largest Army also shows
// the leading knight count so progress toward it is visible.
function AwardsBar({ state, you }: { state: GameState; you: PlayerColor | null }) {
  const nameOf = (c: PlayerColor) => state.players.find((p) => p.color === c)?.name ?? c;
  const topKnights = Math.max(0, ...state.players.map((p) => p.playedKnights));
  const armyHolder = state.largestArmyOwner;
  const roadHolder = state.longestRoadOwner;
  return (
    <div className="awards">
      <div className={`award ${roadHolder ? "held" : ""} ${roadHolder === you ? "mine" : ""}`}>
        <span className="award-ic">🛣️</span>
        <span className="award-body">
          <span className="award-lbl">Longest Road</span>
          <span className="award-who">{roadHolder ? nameOf(roadHolder) : "unclaimed"}</span>
        </span>
        <span className="award-vp">+2</span>
      </div>
      <div className={`award ${armyHolder ? "held" : ""} ${armyHolder === you ? "mine" : ""}`}>
        <span className="award-ic">⚔️</span>
        <span className="award-body">
          <span className="award-lbl">Largest Army</span>
          <span className="award-who">
            {armyHolder ? `${nameOf(armyHolder)} · ${topKnights}🛡️` : "unclaimed"}
          </span>
        </span>
        <span className="award-vp">+2</span>
      </div>
    </div>
  );
}

// Cities & Knights: the barbarian ship's progress, and whether Catan's active
// knights currently outweigh its cities (the test when the ship lands).
function BarbarianTracker({ state }: { state: GameState }) {
  const step = state.barbarianStep ?? 0;
  const total = BARBARIAN_TRACK_LENGTH;
  const strength = state.players.reduce((s, p) => s + knightStrengthOf(state, p.color), 0);
  const cities = state.buildings.filter((b) => b.kind === "city").length;
  const safe = strength >= cities;
  return (
    <div className={`barbarian-tracker ${step >= total - 1 ? "imminent" : ""}`}>
      <div className="bt-head">
        <span className="bt-title">🚢 Barbarians</span>
        <span className={`bt-balance ${safe ? "ok" : "danger"}`} title="Total active knight strength vs number of cities">
          ⚔️ {strength} vs 🏙️ {cities}
        </span>
      </div>
      <div className="bt-track">
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} className={`bt-pip ${i < step ? "on" : ""}`} />
        ))}
      </div>
      {state.eventDie && (
        <div className="bt-event">
          <span className="bt-event-label">Last event die:</span>
          <EventDieChip face={state.eventDie} />
        </div>
      )}
    </div>
  );
}

const COST_ROWS: { key: keyof typeof BUILD_COSTS; icon: string; label: string; note?: string }[] = [
  { key: "road", icon: "🛣️", label: "Road", note: "Longest Road = 2 VP" },
  { key: "settlement", icon: "🏠", label: "Settlement", note: "1 VP" },
  { key: "city", icon: "🏙️", label: "City", note: "2 VP (upgrades a settlement)" },
  { key: "dev_card", icon: "🃏", label: "Development card", note: "Knight, VP, and more" },
];

// Thematic vector illustration for a development card.
function DevCardArt({ kind }: { kind: DevCardKind }) {
  const [c1, c2] = DEV_ART[kind];
  const id = `dca-${kind}`;
  return (
    <svg className="dc-art" viewBox="0 0 120 150" role="img" aria-label={DEV_INFO[kind].name}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="114" height="144" rx="12" fill={`url(#${id})`} stroke="rgba(0,0,0,0.35)" />
      <rect x="3" y="3" width="114" height="144" rx="12" fill="none" stroke="rgba(255,255,255,0.25)" />
      <g opacity="0.9">{DevCardBackdrop(kind)}</g>
      <text x="60" y="92" textAnchor="middle" dominantBaseline="central" fontSize="50">
        {DEV_META[kind].icon}
      </text>
    </svg>
  );
}

// Per-card decorative backdrop drawn behind the central emblem.
function DevCardBackdrop(kind: DevCardKind) {
  const w = "rgba(255,255,255,0.18)";
  const wl = "rgba(255,255,255,0.35)";
  switch (kind) {
    case "knight":
      return (
        <g>
          {/* crossed swords */}
          <g stroke={wl} strokeWidth="3" strokeLinecap="round">
            <line x1="34" y1="40" x2="86" y2="118" />
            <line x1="86" y1="40" x2="34" y2="118" />
          </g>
          {/* shield */}
          <path d="M60 30 L92 42 L88 92 Q60 116 60 116 Q60 116 32 92 L28 42 Z" fill={w} stroke={wl} strokeWidth="2" />
        </g>
      );
    case "victory_point":
      return (
        <g>
          {Array.from({ length: 12 }).map((_, i) => {
            const a = (i * Math.PI) / 6;
            return (
              <line
                key={i}
                x1={60 + Math.cos(a) * 22}
                y1={75 + Math.sin(a) * 22}
                x2={60 + Math.cos(a) * 46}
                y2={75 + Math.sin(a) * 46}
                stroke={w}
                strokeWidth="4"
                strokeLinecap="round"
              />
            );
          })}
          <circle cx="60" cy="75" r="40" fill="none" stroke={wl} strokeWidth="2" />
        </g>
      );
    case "road_building":
      return (
        <g stroke={w} strokeWidth="10" strokeLinecap="round">
          <line x1="20" y1="120" x2="60" y2="30" />
          <line x1="100" y1="120" x2="60" y2="30" />
          <g stroke={wl} strokeWidth="2" strokeDasharray="5 6">
            <line x1="40" y1="120" x2="60" y2="40" />
            <line x1="80" y1="120" x2="60" y2="40" />
          </g>
        </g>
      );
    case "year_of_plenty":
      return (
        <g>
          {Array.from({ length: 12 }).map((_, i) => {
            const a = (i * Math.PI) / 6;
            return (
              <line
                key={i}
                x1={60 + Math.cos(a) * 26}
                y1={70 + Math.sin(a) * 26}
                x2={60 + Math.cos(a) * 44}
                y2={70 + Math.sin(a) * 44}
                stroke={w}
                strokeWidth="5"
                strokeLinecap="round"
              />
            );
          })}
          <circle cx="60" cy="70" r="24" fill={w} />
        </g>
      );
    case "monopoly":
      return (
        <g fill={w} stroke={wl} strokeWidth="1.5">
          <ellipse cx="60" cy="116" rx="34" ry="9" />
          <ellipse cx="60" cy="104" rx="30" ry="8" />
          <ellipse cx="60" cy="92" rx="26" ry="7" />
          <circle cx="60" cy="62" r="22" fill="none" stroke={wl} strokeWidth="3" />
        </g>
      );
  }
}

function DevCardInfoModal({ kind, onClose }: { kind: DevCardKind; onClose: () => void }) {
  const info = DEV_INFO[kind];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal devcard-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={info.name}>
        <div className="modal-head">
          <h3>{info.name}</h3>
          <button className="link-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="devcard-body">
          <DevCardArt kind={kind} />
          <p className="devcard-desc">{info.desc}</p>
        </div>
      </div>
    </div>
  );
}

// Read + play a progress card, with target pickers for the cards that need one.
function ProgressCardModal({
  kind,
  me,
  canPlay,
  onPlay,
  onClose,
}: {
  kind: ProgressCardKind;
  me: PlayerState | null;
  canPlay: boolean;
  onPlay: (msg: ClientMessage) => void;
  onClose: () => void;
}) {
  const info = PROGRESS_CARD_INFO[kind];
  const [resource, setResource] = useState<Resource>("brick");
  const [commodity, setCommodity] = useState<Commodity>("coin");
  const [alc, setAlc] = useState<[Resource, Resource]>(["grain", "ore"]);
  const held = (me?.progressCards ?? []).includes(kind);

  const play = () => {
    const msg: ClientMessage = { type: "play_progress_card", card: kind };
    if (kind === "resource_monopoly") (msg as any).resource = resource;
    if (kind === "trade_monopoly") (msg as any).commodity = commodity;
    if (kind === "alchemist") (msg as any).resources = alc;
    onPlay(msg);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal devcard-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={info.name}>
        <div className="modal-head">
          <h3>
            {info.icon} {info.name}
          </h3>
          <button className="link-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="devcard-body">
          <p className="devcard-desc">
            <span className={`prog-deck-tag prog-${info.deck}`}>{info.deck}</span>
            {info.desc}
          </p>
          {kind === "resource_monopoly" && (
            <label className="prog-param">Resource:
              <select value={resource} onChange={(e) => setResource(e.target.value as Resource)}>
                {RESOURCES.map((r) => <option key={r} value={r}>{RES_ICON[r]} {r}</option>)}
              </select>
            </label>
          )}
          {kind === "trade_monopoly" && (
            <label className="prog-param">Commodity:
              <select value={commodity} onChange={(e) => setCommodity(e.target.value as Commodity)}>
                {COMMODITIES.map((c) => <option key={c} value={c}>{COMMODITY_ICON[c]} {c}</option>)}
              </select>
            </label>
          )}
          {kind === "alchemist" && (
            <div className="prog-param">
              Take:
              <select value={alc[0]} onChange={(e) => setAlc([e.target.value as Resource, alc[1]])}>
                {RESOURCES.map((r) => <option key={r} value={r}>{RES_ICON[r]} {r}</option>)}
              </select>
              <select value={alc[1]} onChange={(e) => setAlc([alc[0], e.target.value as Resource])}>
                {RESOURCES.map((r) => <option key={r} value={r}>{RES_ICON[r]} {r}</option>)}
              </select>
            </div>
          )}
        </div>
        <button className="btn primary" disabled={!canPlay || !held} onClick={play}>
          {canPlay ? "Play card" : "Play on your turn"}
        </button>
      </div>
    </div>
  );
}

// A high-level explainer of the Cities & Knights expansion. Each topic expands
// to a full, in-depth description when tapped.
const CK_RULES: { icon: string; title: string; body: string; detail: string[] }[] = [
  {
    icon: "🪙",
    title: "Commodities",
    body: "Your cities produce a commodity on top of the base resource.",
    detail: [
      "There are three commodities: coin (from mountains/ore cities), paper (from forest/lumber cities) and cloth (from pasture/wool cities).",
      "When a city's number is rolled it yields 1 base resource AND 1 matching commodity. Cities on hills (brick) and fields (grain) make no commodity — they still produce 2 of the base resource, as in the base game.",
      "Settlements always produce just 1 base resource and never a commodity, so upgrading to a city is how you turn on commodity income.",
      "Commodities sit in your hand and count toward the 7-card limit: on a 7 you discard half of your resources AND commodities together.",
    ],
  },
  {
    icon: "🏛️",
    title: "City improvements & metropolis",
    body: "Spend commodities to climb three tracks; reach level 4 first for a metropolis.",
    detail: [
      "The three tracks are Trade (bought with cloth), Politics (coin) and Science (paper). Advancing to level n costs n commodities of that type — so 1, then 2, 3, 4 and 5.",
      "Higher levels let you draw progress cards: on a matching coloured gate you draw if your level is at least the red die's value.",
      "The FIRST player to reach level 4 on a track builds a metropolis on one of their cities, worth 2 victory points. If a rival later reaches level 5 on that same track, they take the metropolis from you.",
      "Politics level 3 (Fortress) is also what lets you promote knights all the way to Mighty.",
    ],
  },
  {
    icon: "⚔️",
    title: "Knights",
    body: "Recruit, activate and promote knights to defend and harass.",
    detail: [
      "Recruit a knight for 1 wool + 1 ore on an empty intersection connected to your roads (up to 6 knights).",
      "Activate a knight for 1 grain — only ACTIVE knights can act or help defend against the barbarians.",
      "Promote for 1 wool + 1 ore to raise its rank: Basic (strength 1) → Strong (2) → Mighty (3). Promoting to Mighty requires Politics level 3.",
      "An active knight can move along your roads to an empty spot, displace a weaker enemy knight, or chase the robber off a hex it sits next to. Taking an action (or defending) deactivates the knight, so you must re-pay grain to use it again.",
    ],
  },
  {
    icon: "🚢",
    title: "Barbarians",
    body: "The event die advances a ship that periodically attacks the island.",
    detail: [
      "Every roll also rolls the coloured event die. Three of its six faces show the barbarian ship, which advances one step each time — seven steps and it attacks.",
      "On arrival, the combined strength of ALL players' active knights is compared to the total number of cities on the board.",
      "If knights ≥ cities the island is defended; if cities win, the player (or players) with the least active knight strength each lose one city — their least-valuable non-metropolis city is downgraded to a settlement.",
      "After every attack all knights deactivate and the ship resets to the start, so defending is a recurring effort.",
    ],
  },
  {
    icon: "🛡️",
    title: "Defender of Catan",
    body: "Repel the barbarians as the strongest defender for a victory point.",
    detail: [
      "When the barbarians are driven off, the single player with the most active knight strength earns a Defender of Catan token worth 1 victory point.",
      "If two or more players tie for the most strength, no token is awarded that time.",
      "Tokens accumulate over the game and are a legitimate route to victory — a knight-focused player can win largely on defense.",
    ],
  },
  {
    icon: "📜",
    title: "Progress cards",
    body: "Coloured gates let you draw powerful one-off cards.",
    detail: [
      "The other three event-die faces are gates: yellow (trade), blue (politics) and green (science).",
      "On a gate, every player whose improvement level in that discipline is at least the red number die draws a card from that deck. Invest in a track to draw its cards more often.",
      "You may hold up to 4 progress cards; their contents are hidden from opponents and they're played on your turn.",
      "Trade cards steal and monopolise cards; politics cards manipulate knights, the robber and hands; science cards discount building and hand you resources. In this build the base development cards are replaced entirely by these decks.",
    ],
  },
  {
    icon: "🧱",
    title: "City walls",
    body: "Fortify cities to survive a 7 with a bigger hand.",
    detail: [
      "Build a wall on one of your cities for 2 brick (or free with the Engineer progress card).",
      "Each wall you own raises the number of cards you may hold before a 7 forces a discard, by 2: from 7 up to 9, 11, then 13 with three walls.",
      "If a walled city is sacked by the barbarians, the wall is destroyed along with the city's upgrade.",
    ],
  },
  {
    icon: "🏆",
    title: "Winning",
    body: "First to 13 victory points wins.",
    detail: [
      "Cities & Knights is played to 13 victory points, up from 10 in the base game.",
      "Points come from settlements (1), cities (2), each metropolis (2), Longest Road (2), each Defender of Catan token (1), holding the Merchant (1), and hidden victory-point progress cards.",
      "As always, you can only win on your own turn — reaching 13 during another player's turn just means you win as soon as your turn comes around.",
    ],
  },
];

function RulesModal({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(CK_RULES[0].title);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rules-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Cities & Knights rules">
        <div className="modal-head">
          <h3>🏰 Cities &amp; Knights</h3>
          <button className="link-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="rules-intro muted">Tap a topic for the full rules.</p>
        <ul className="rules-list">
          {CK_RULES.map((r) => {
            const isOpen = open === r.title;
            return (
              <li key={r.title} className={`rules-row ${isOpen ? "open" : ""}`}>
                <button
                  type="button"
                  className="rules-trigger"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : r.title)}
                >
                  <span className="rules-ic">{r.icon}</span>
                  <span className="rules-head-text">
                    <strong>{r.title}</strong>
                    <span className="rules-body">{r.body}</span>
                  </span>
                  <span className={`rules-chevron ${isOpen ? "open" : ""}`} aria-hidden>
                    ▸
                  </span>
                </button>
                {isOpen && (
                  <div className="rules-detail">
                    {r.detail.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// A breakdown of exactly where the viewer's victory points come from.
function VpBreakdownModal({
  state,
  me,
  onClose,
}: {
  state: GameState;
  me: PlayerState;
  onClose: () => void;
}) {
  const color = me.color;
  const settlements = state.buildings.filter((b) => b.owner === color && b.kind === "settlement").length;
  const cities = state.buildings.filter((b) => b.owner === color && b.kind === "city").length;
  const metros = state.metropolisOwner
    ? IMPROVEMENT_TRACKS.filter((t) => state.metropolisOwner![t] === color).length
    : 0;
  const rows: { icon: string; label: string; detail?: string; points: number }[] = [
    { icon: "🏠", label: "Settlements", detail: `${settlements} × 1`, points: settlements },
    { icon: "🏙️", label: "Cities", detail: `${cities} × 2`, points: cities * 2 },
  ];
  if (isCK(state)) rows.push({ icon: "🏛️", label: "Metropolises", detail: `${metros} × 2`, points: metros * 2 });
  if (state.longestRoadOwner === color) rows.push({ icon: "🛣️", label: "Longest Road", points: 2 });
  if (state.largestArmyOwner === color) rows.push({ icon: "🎖️", label: "Largest Army", points: 2 });
  if (isCK(state) && state.merchantOwner === color) rows.push({ icon: "🏪", label: "Merchant", points: 1 });
  if (isCK(state) && (me.defenderTokens ?? 0) > 0)
    rows.push({ icon: "🛡️", label: "Defender of Catan", detail: `${me.defenderTokens} × 1`, points: me.defenderTokens ?? 0 });
  if (me.victoryPointCards > 0)
    rows.push({
      icon: "⭐",
      label: isCK(state) ? "Printer cards" : "Victory point cards",
      detail: `${me.victoryPointCards} × 1 (hidden)`,
      points: me.victoryPointCards,
    });
  const shown = rows.filter((r) => r.points > 0);
  const total = shown.reduce((s, r) => s + r.points, 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal vp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Victory point breakdown">
        <div className="modal-head">
          <h3>★ Your victory points</h3>
          <button className="link-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {shown.length === 0 ? (
          <p className="muted">No victory points yet — build a settlement to get started.</p>
        ) : (
          <ul className="vp-list">
            {shown.map((r) => (
              <li key={r.label} className="vp-row">
                <span className="vp-row-name">
                  <span className="vp-row-ic">{r.icon}</span>
                  <span>
                    {r.label}
                    {r.detail && <span className="vp-row-detail">{r.detail}</span>}
                  </span>
                </span>
                <span className="vp-row-pts">{r.points}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="vp-total">
          <span>Total</span>
          <span>{total} / {winTargetOf(state)}</span>
        </div>
        {me.victoryPointCards > 0 && (
          <p className="vp-foot muted">Hidden cards are shown only to you until the game ends.</p>
        )}
      </div>
    </div>
  );
}

function CostsModal({ winTarget, onClose }: { winTarget: number; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cost-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Building costs">
        <div className="modal-head">
          <h3>Building costs</h3>
          <button className="link-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <ul className="cost-list">
          {COST_ROWS.map((row) => (
            <li key={row.key} className="cost-row">
              <span className="cost-name">
                <span className="cost-emoji">{row.icon}</span>
                <span>
                  {row.label}
                  {row.note && <span className="cost-note">{row.note}</span>}
                </span>
              </span>
              <span className="cost-res">
                {RESOURCES.filter((r) => (BUILD_COSTS[row.key] as Partial<ResourceCounts>)[r]).map((r) => (
                  <span key={r} className="cost-chip" title={r}>
                    {RES_ICON[r]}
                    <em>×{(BUILD_COSTS[row.key] as Partial<ResourceCounts>)[r]}</em>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="cost-foot">First to {winTarget} victory points wins.</p>
      </div>
    </div>
  );
}

function ToolBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`btn tool ${active ? "active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

function DiscardPanel({
  me,
  owed,
  send,
}: {
  me: PlayerState;
  owed: number;
  send: (msg: ClientMessage) => void;
}) {
  const [sel, setSel] = useState<Record<Resource, number>>({
    brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0,
  });
  const [comSel, setComSel] = useState<Record<Commodity, number>>({
    coin: 0, paper: 0, cloth: 0,
  });
  const hasCommodities = !!me.commodities;
  const chosen =
    RESOURCES.reduce((s, r) => s + sel[r], 0) +
    COMMODITIES.reduce((s, c) => s + comSel[c], 0);
  const bump = (r: Resource, d: number) =>
    setSel((s) => ({ ...s, [r]: Math.max(0, Math.min(me.resources[r], s[r] + d)) }));
  const bumpCom = (c: Commodity, d: number) =>
    setComSel((s) => ({ ...s, [c]: Math.max(0, Math.min(me.commodities?.[c] ?? 0, s[c] + d)) }));

  return (
    <div className="panel discard-panel">
      <p>Choose {owed} cards to discard ({chosen}/{owed}).</p>
      <div className="res-picker">
        {RESOURCES.map((r) => (
          <div key={r} className="picker-row">
            <span>{RES_ICON[r]} {me.resources[r]}</span>
            <button className="btn sm" onClick={() => bump(r, -1)}>−</button>
            <span className="picker-val">{sel[r]}</span>
            <button className="btn sm" onClick={() => bump(r, 1)}>+</button>
          </div>
        ))}
        {hasCommodities &&
          COMMODITIES.map((c) => (
            <div key={c} className="picker-row">
              <span>{COMMODITY_ICON[c]} {me.commodities![c]}</span>
              <button className="btn sm" onClick={() => bumpCom(c, -1)}>−</button>
              <span className="picker-val">{comSel[c]}</span>
              <button className="btn sm" onClick={() => bumpCom(c, 1)}>+</button>
            </div>
          ))}
      </div>
      <button
        className="btn primary"
        disabled={chosen !== owed}
        onClick={() => send({ type: "discard", resources: sel, commodities: hasCommodities ? comSel : undefined })}
      >
        Discard
      </button>
    </div>
  );
}

function BankPanel({
  state,
  you,
  send,
}: {
  state: GameState;
  you: PlayerColor;
  send: (msg: ClientMessage) => void;
}) {
  const [give, setGive] = useState<Resource>("brick");
  const [receive, setReceive] = useState<Resource>("ore");
  const rate = bankRate(state, you, give);
  const fleet = !!state.players.find((p) => p.color === you)?.tradeFleetTurn;
  return (
    <div className="panel">
      {fleet && (
        <p className="fleet-note">⛵ Merchant Fleet active — bank trades are 2:1 this turn.</p>
      )}
      <div className="row">
        <label>Give
          <select value={give} onChange={(e) => setGive(e.target.value as Resource)}>
            {RESOURCES.map((r) => <option key={r} value={r}>{RES_ICON[r]} {r}</option>)}
          </select>
        </label>
        <span className="rate">×{rate} →</span>
        <label>Get
          <select value={receive} onChange={(e) => setReceive(e.target.value as Resource)}>
            {RESOURCES.map((r) => <option key={r} value={r}>{RES_ICON[r]} {r}</option>)}
          </select>
        </label>
        <button
          className="btn primary"
          onClick={() => send({ type: "bank_trade", give: { [give]: rate }, receive: { [receive]: 1 } })}
        >
          Trade
        </button>
      </div>
    </div>
  );
}

function OfferPanel({ send }: { send: (msg: ClientMessage) => void }) {
  const [give, setGive] = useState<Resource>("brick");
  const [giveN, setGiveN] = useState(1);
  const [receive, setReceive] = useState<Resource>("ore");
  const [receiveN, setReceiveN] = useState(1);
  return (
    <div className="panel">
      <div className="row">
        <label>Give
          <select value={give} onChange={(e) => setGive(e.target.value as Resource)}>
            {RESOURCES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <input className="num" type="number" min={1} value={giveN} onChange={(e) => setGiveN(+e.target.value)} />
        <span>→</span>
        <label>Get
          <select value={receive} onChange={(e) => setReceive(e.target.value as Resource)}>
            {RESOURCES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <input className="num" type="number" min={1} value={receiveN} onChange={(e) => setReceiveN(+e.target.value)} />
        <button
          className="btn primary"
          onClick={() => send({ type: "offer_trade", to: null, give: { [give]: giveN }, receive: { [receive]: receiveN } })}
        >
          Offer all
        </button>
      </div>
    </div>
  );
}

function DevPanel({
  me,
  send,
  onPlayed,
}: {
  me: PlayerState;
  send: (msg: ClientMessage) => void;
  onPlayed: () => void;
}) {
  const has = (k: string) => me.devCards.includes(k as any);
  const [yop, setYop] = useState<[Resource, Resource]>(["brick", "ore"]);
  const [mono, setMono] = useState<Resource>("brick");
  // Send the play, then close the panel so the board is visible for any
  // follow-up placement (e.g. Road Building's two free roads).
  const play = (msg: ClientMessage) => {
    send(msg);
    onPlayed();
  };
  return (
    <div className="panel dev-panel">
      {has("knight") && (
        <button className="btn" onClick={() => play({ type: "play_knight" })}>⚔️ Knight</button>
      )}
      {has("road_building") && (
        <button className="btn" onClick={() => play({ type: "play_road_building" })}>🛣️ Road Building</button>
      )}
      {has("monopoly") && (
        <div className="row">
          <select value={mono} onChange={(e) => setMono(e.target.value as Resource)}>
            {RESOURCES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn" onClick={() => play({ type: "play_monopoly", resource: mono })}>Monopoly</button>
        </div>
      )}
      {has("year_of_plenty") && (
        <div className="row">
          <select value={yop[0]} onChange={(e) => setYop([e.target.value as Resource, yop[1]])}>
            {RESOURCES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={yop[1]} onChange={(e) => setYop([yop[0], e.target.value as Resource])}>
            {RESOURCES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn" onClick={() => play({ type: "play_year_of_plenty", resources: yop })}>Year of Plenty</button>
        </div>
      )}
      {!has("knight") && !has("road_building") && !has("monopoly") && !has("year_of_plenty") && (
        <span className="muted">No playable cards (newly bought cards wait until next turn).</span>
      )}
    </div>
  );
}

// Cities & Knights: spend commodities to advance the three improvement tracks.
function ImprovePanel({
  state,
  me,
  send,
}: {
  state: GameState;
  me: PlayerState;
  send: (msg: ClientMessage) => void;
}) {
  if (!me.improvements || !me.commodities) return null;
  return (
    <div className="panel improve-panel">
      {IMPROVEMENT_TRACKS.map((track) => {
        const level = me.improvements![track];
        const commodity = TRACK_COMMODITY[track];
        const maxed = level >= MAX_IMPROVEMENT_LEVEL;
        const cost = improvementCost(level + 1);
        const have = me.commodities![commodity];
        const affordable = !maxed && have >= cost;
        const owner = state.metropolisOwner?.[track] ?? null;
        const nextIsMetro = level + 1 === METROPOLIS_LEVEL;
        return (
          <div key={track} className="improve-line">
            <div className="improve-head">
              <span className="improve-name">
                {TRACK_META[track].icon} {TRACK_META[track].label}
              </span>
              <span className="improve-level">
                Lvl {level}/{MAX_IMPROVEMENT_LEVEL}
                {owner === me.color && <span className="metro-flag" title="You hold this metropolis"> 🏛️</span>}
              </span>
            </div>
            <div className="improve-buy">
              {maxed ? (
                <span className="muted">Maxed out.</span>
              ) : (
                <>
                  <span className="improve-cost">
                    {cost} {COMMODITY_ICON[commodity]} <small>(have {have})</small>
                    {nextIsMetro && <em className="metro-hint"> → metropolis +2 VP</em>}
                  </span>
                  <button
                    className="btn sm primary"
                    disabled={!affordable}
                    onClick={() => send({ type: "buy_improvement", track })}
                  >
                    Build
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A focused action bar for the single knight tapped on the board, so it's
// unambiguous which knight you're activating / promoting / moving.
function SelectedKnightBar({
  state,
  me,
  knight,
  canAct,
  send,
  onMove,
  onClose,
}: {
  state: GameState;
  me: PlayerState;
  knight: KnightPiece;
  canAct: boolean;
  send: (msg: ClientMessage) => void;
  onMove: (vertexId: number) => void;
  onClose: () => void;
}) {
  const afford = (cost: Partial<ResourceCounts>) =>
    RESOURCES.every((r) => me.resources[r] >= (cost[r] ?? 0));
  const politics = me.improvements?.politics ?? 0;
  const canPromoteRank =
    knight.rank < KNIGHT_MAX_RANK &&
    (knight.rank + 1 < KNIGHT_MAX_RANK || politics >= MIGHTY_KNIGHT_POLITICS_LEVEL);
  const adjacentRobber = state.board.vertices[knight.vertexId].hexIds.includes(state.board.robberHexId);
  const v = knight.vertexId;
  return (
    <div className="prompt-bar selected-knight">
      <span className={`sk-badge rank-${knight.rank} ${knight.active ? "active" : "idle"}`}>
        ⚔️ {KNIGHT_RANK_NAME[knight.rank]} <small>{knight.active ? "active" : "idle"}</small>
      </span>
      <span className="sk-actions">
        {!knight.active && (
          <button
            className="btn sm primary"
            disabled={!canAct || !afford(KNIGHT_ACTIVATE_COST)}
            title="Activate (1 grain)"
            onClick={() => send({ type: "activate_knight", vertexId: v })}
          >
            Activate 🌾
          </button>
        )}
        <button
          className="btn sm"
          disabled={!canAct || !canPromoteRank || !afford(KNIGHT_PROMOTE_COST)}
          title={
            knight.rank + 1 >= KNIGHT_MAX_RANK && politics < MIGHTY_KNIGHT_POLITICS_LEVEL
              ? "Needs Politics level 3"
              : "Promote (1 wool, 1 ore)"
          }
          onClick={() => send({ type: "promote_knight", vertexId: v })}
        >
          Promote ⬆
        </button>
        {knight.active && (
          <button className="btn sm" disabled={!canAct} onClick={() => onMove(v)}>
            Move
          </button>
        )}
        {knight.active && adjacentRobber && (
          <button
            className="btn sm"
            disabled={!canAct}
            onClick={() => send({ type: "knight_chase_robber", vertexId: v })}
          >
            Chase robber
          </button>
        )}
        <button className="btn sm ghost" onClick={onClose} aria-label="Deselect">✕</button>
      </span>
    </div>
  );
}

// Cities & Knights: recruit, activate, promote, move and deploy knights.
function KnightsPanel({
  state,
  me,
  send,
  onRecruit,
  onMove,
  onSelect,
}: {
  state: GameState;
  me: PlayerState;
  send: (msg: ClientMessage) => void;
  onRecruit: () => void;
  onMove: (vertexId: number) => void;
  onSelect: (vertexId: number) => void;
}) {
  const afford = (cost: Partial<ResourceCounts>) =>
    RESOURCES.every((r) => me.resources[r] >= (cost[r] ?? 0));
  const mine = (state.knights ?? []).filter((k) => k.owner === me.color);
  const activeStrength = mine.filter((k) => k.active).reduce((s, k) => s + k.rank, 0);
  const politics = me.improvements?.politics ?? 0;
  const atLimit = mine.length >= KNIGHT_LIMIT;
  const canRecruit = !atLimit && afford(KNIGHT_BUILD_COST);
  const robberHex = state.board.robberHexId;
  const adjacentRobber = (k: KnightPiece) =>
    state.board.vertices[k.vertexId].hexIds.includes(robberHex);

  return (
    <div className="panel knights-panel">
      <div className="knights-head">
        <span className="muted">
          Knights {mine.length}/{KNIGHT_LIMIT} · active strength <strong>{activeStrength}</strong>
        </span>
        <button className="btn sm primary" disabled={!canRecruit} onClick={onRecruit}>
          ＋ Recruit 🐑1 ⛰️1
        </button>
      </div>
      {mine.length === 0 ? (
        <p className="muted knights-empty">No knights yet. Recruit one to defend Catan.</p>
      ) : (
        <p className="muted knights-empty">Tap a knight here (or on the board) to select it, then act.</p>
      )}
      {mine.map((k) => {
        const canActivate = !k.active && afford(KNIGHT_ACTIVATE_COST);
        const canPromoteRank =
          k.rank < KNIGHT_MAX_RANK &&
          (k.rank + 1 < KNIGHT_MAX_RANK || politics >= MIGHTY_KNIGHT_POLITICS_LEVEL);
        const canPromote = canPromoteRank && afford(KNIGHT_PROMOTE_COST);
        return (
          <div key={k.vertexId} className="knight-row">
            <button
              type="button"
              className={`knight-badge as-btn rank-${k.rank} ${k.active ? "active" : "idle"}`}
              title="Highlight this knight on the board"
              onClick={() => onSelect(k.vertexId)}
            >
              ⚔️ {KNIGHT_RANK_NAME[k.rank]}
              <small>{k.active ? "active" : "idle"}</small>
            </button>
            <span className="knight-actions">
              {!k.active && (
                <button
                  className="btn sm"
                  disabled={!canActivate}
                  title="Activate (1 grain)"
                  onClick={() => send({ type: "activate_knight", vertexId: k.vertexId })}
                >
                  Activate 🌾
                </button>
              )}
              <button
                className="btn sm"
                disabled={!canPromote}
                title={
                  k.rank + 1 >= KNIGHT_MAX_RANK && politics < MIGHTY_KNIGHT_POLITICS_LEVEL
                    ? "Needs Politics level 3"
                    : "Promote (1 wool, 1 ore)"
                }
                onClick={() => send({ type: "promote_knight", vertexId: k.vertexId })}
              >
                Promote ⬆
              </button>
              {k.active && (
                <button className="btn sm" onClick={() => onMove(k.vertexId)}>
                  Move
                </button>
              )}
              {k.active && adjacentRobber(k) && (
                <button
                  className="btn sm"
                  onClick={() => send({ type: "knight_chase_robber", vertexId: k.vertexId })}
                >
                  Chase robber
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function fmtBundle(b: Partial<Record<Resource, number>>): string {
  const parts = Object.entries(b).filter(([, n]) => n).map(([r, n]) => `${n}${RES_ICON[r as Resource]}`);
  return parts.length ? parts.join(" ") : "—";
}
