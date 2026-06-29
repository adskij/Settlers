import { useEffect, useState } from "react";
import {
  RESOURCES,
  VICTORY_POINTS_TO_WIN,
  type ClientMessage,
  type DevCardKind,
  type GameState,
  type PlayerColor,
  type PlayerState,
  type Resource,
} from "@settlers/shared";
import type { BuildMode } from "./GameScreen.js";

const RES_ICON: Record<Resource, string> = {
  brick: "🧱",
  lumber: "🌲",
  wool: "🐑",
  grain: "🌾",
  ore: "⛰️",
};

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
  return vp;
}

function bankRate(state: GameState, color: PlayerColor, resource: Resource): number {
  const ports = new Set<string>();
  for (const b of state.buildings) {
    if (b.owner !== color) continue;
    const port = state.board.vertices[b.vertexId].port;
    if (port) ports.add(port);
  }
  if (ports.has(resource)) return 2;
  if (ports.has("any")) return 3;
  return 4;
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
}: {
  state: GameState;
  you: PlayerColor | null;
  send: (msg: ClientMessage) => void;
  error: string | null;
  clearError: () => void;
  buildMode: BuildMode;
  setBuildMode: (m: BuildMode) => void;
}) {
  const me = state.players.find((p) => p.color === you) ?? null;
  const isYourTurn = state.players[state.currentPlayerIndex]?.color === you;
  const [panel, setPanel] = useState<"none" | "bank" | "trade" | "dev">("none");

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 4000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  const owesDiscard = you ? state.pendingDiscards[you] : undefined;

  return (
    <div className="hud">
      {error && <div className="toast error" onClick={clearError}>{error}</div>}

      {/* Players strip */}
      <div className="players-strip">
        {state.players.map((p, i) => (
          <div
            key={p.color}
            className={`player-tag ${p.color} ${
              i === state.currentPlayerIndex ? "active" : ""
            } ${p.color === you ? "you" : ""}`}
          >
            <span className={`color-swatch ${p.color}`} />
            <span className="pname">{p.isBot ? "🤖 " : ""}{p.name}</span>
            <span className="vp">{publicVP(state, p.color)}⭐</span>
            <span className="cards">
              🂠{p.color === you ? total(p) : total(p)}
            </span>
            {state.largestArmyOwner === p.color && <span title="Largest Army">⚔️</span>}
            {state.longestRoadOwner === p.color && <span title="Longest Road">🛣️</span>}
            {!p.connected && <span className="off-dot" title="disconnected">●</span>}
          </div>
        ))}
      </div>

      {/* Pending trade offers */}
      {state.pendingTrades.length > 0 && (
        <div className="trade-offers">
          {state.pendingTrades.map((t) => (
            <div key={t.id} className="trade-offer">
              <span>
                <strong>{t.from}</strong> gives {fmtBundle(t.give)} for{" "}
                {fmtBundle(t.receive)}
              </span>
              {t.from !== you && (
                <button
                  className="btn sm"
                  onClick={() => send({ type: "accept_trade", tradeId: t.id })}
                >
                  Accept
                </button>
              )}
              {t.from === you && (
                <button
                  className="btn sm"
                  onClick={() => send({ type: "cancel_trade", tradeId: t.id })}
                >
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Your panel: victory points, resource cards, dev cards */}
      {me && (
        <div className="me-panel">
          <div className="me-top">
            <div className="vp-badge" title="Your victory points (incl. hidden cards)">
              <span className="vp-star">★</span>
              <span className="vp-count">{publicVP(state, me.color)}</span>
              <span className="vp-of">/ {VICTORY_POINTS_TO_WIN}</span>
              <span className="vp-text">Victory Points</span>
            </div>
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

          {devHand(me).length > 0 && (
            <div className="dev-hand">
              {devHand(me).map((d) => (
                <div
                  key={d.kind}
                  className={`dev-card-mini ${d.pending && !d.playable ? "pending" : ""}`}
                  title={
                    d.pending
                      ? `${DEV_META[d.kind].label} — bought this turn (playable next turn)`
                      : DEV_META[d.kind].label
                  }
                >
                  <span className="dc-icon">{DEV_META[d.kind].icon}</span>
                  <span className="dc-label">{DEV_META[d.kind].label}</span>
                  {d.playable + d.pending > 1 && (
                    <span className="dc-count">×{d.playable + d.pending}</span>
                  )}
                  {d.pending > 0 && <span className="dc-new">new</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Phase-specific prompts */}
      <div className="prompt-bar">
        <PromptText state={state} you={you} isYourTurn={isYourTurn} />
      </div>

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
              <button className="btn" onClick={() => send({ type: "buy_dev_card" })}>🃏 Buy</button>
              <button className="btn" onClick={() => setPanel(panel === "dev" ? "none" : "dev")}>Play card</button>
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
    return <span>Rolled {state.dice[0] + state.dice[1]} 🎲 ({state.dice[0]}+{state.dice[1]})</span>;
  return <span>{isYourTurn ? "Build, trade, or end your turn." : "Opponent's turn."}</span>;
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
  const chosen = RESOURCES.reduce((s, r) => s + sel[r], 0);
  const bump = (r: Resource, d: number) =>
    setSel((s) => ({ ...s, [r]: Math.max(0, Math.min(me.resources[r], s[r] + d)) }));

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
      </div>
      <button
        className="btn primary"
        disabled={chosen !== owed}
        onClick={() => send({ type: "discard", resources: sel })}
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
  return (
    <div className="panel">
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

function fmtBundle(b: Partial<Record<Resource, number>>): string {
  const parts = Object.entries(b).filter(([, n]) => n).map(([r, n]) => `${n}${RES_ICON[r as Resource]}`);
  return parts.length ? parts.join(" ") : "—";
}
