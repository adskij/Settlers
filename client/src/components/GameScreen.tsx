import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api.js";
import type { LobbyGame } from "../lib/types.js";
import type { CurrentUser } from "../App.js";
import { useGameSocket } from "../lib/useGameSocket.js";
import { Board } from "./Board.js";
import { Hud } from "./Hud.js";

export type BuildMode = "road" | "settlement" | "city" | null;

export function GameScreen({
  gameId,
  user,
  onExit,
}: {
  gameId: string;
  user: CurrentUser;
  onExit: () => void;
}) {
  const sock = useGameSocket(gameId);
  const [lobby, setLobby] = useState<LobbyGame | null>(null);
  const [buildMode, setBuildMode] = useState<BuildMode>(null);

  // Reset any selected build tool whenever the turn/phase changes.
  const phaseKey = `${sock.state?.phase}:${sock.state?.currentPlayerIndex}`;
  useEffect(() => setBuildMode(null), [phaseKey]);

  // While the game hasn't started, poll lobby info over REST.
  const refreshLobby = useCallback(() => {
    api
      .getGame(gameId)
      .then((r) => setLobby(r.game))
      .catch(() => {});
  }, [gameId]);

  useEffect(() => {
    if (sock.state) return; // game running; WS drives everything
    refreshLobby();
    const t = setInterval(refreshLobby, 3000);
    return () => clearInterval(t);
  }, [sock.state, refreshLobby]);

  const leave = async () => {
    sock.send({ type: "leave_game" });
    try {
      await api.leaveGame(gameId);
    } catch {
      /* already started; just exit */
    }
    onExit();
  };

  if (!sock.state) {
    return (
      <WaitingRoom
        lobby={lobby}
        user={user}
        connected={sock.connected}
        error={sock.error}
        onStart={() => sock.send({ type: "start_game" })}
        onLeave={leave}
        onBack={onExit}
      />
    );
  }

  return (
    <div className="game-screen">
      <header className="topbar game-topbar">
        <button className="link-btn" onClick={onExit}>
          ← Lobby
        </button>
        <span className="spacer" />
        <TurnBadge state={sock.state} you={sock.you} />
        <span className="spacer" />
        <span className={`conn-dot ${sock.connected ? "on" : "off"}`} />
      </header>

      <div className="board-area">
        <Board
          state={sock.state}
          you={sock.you}
          send={sock.send}
          buildMode={buildMode}
          clearBuildMode={() => setBuildMode(null)}
        />
      </div>

      <Hud
        state={sock.state}
        you={sock.you}
        send={sock.send}
        error={sock.error}
        clearError={sock.clearError}
        buildMode={buildMode}
        setBuildMode={setBuildMode}
      />
    </div>
  );
}

function TurnBadge({
  state,
  you,
}: {
  state: NonNullable<ReturnType<typeof useGameSocket>["state"]>;
  you: string | null;
}) {
  const cur = state.players[state.currentPlayerIndex];
  const yours = cur?.color === you;
  return (
    <span className={`turn-badge ${yours ? "yours" : ""}`}>
      {state.phase === "finished"
        ? `🏆 ${state.winner} wins`
        : yours
        ? "Your turn"
        : `${cur?.name}'s turn`}
    </span>
  );
}

function WaitingRoom({
  lobby,
  user,
  connected,
  error,
  onStart,
  onLeave,
  onBack,
}: {
  lobby: LobbyGame | null;
  user: CurrentUser;
  connected: boolean;
  error: string | null;
  onStart: () => void;
  onLeave: () => void;
  onBack: () => void;
}) {
  if (!lobby) return <div className="centered">Connecting…</div>;
  const isHost = lobby.hostId === user.id;
  const started = lobby.phase !== "lobby";

  return (
    <div className="waiting-room">
      <header className="topbar">
        <button className="link-btn" onClick={onBack}>
          ← Back
        </button>
        <span className="spacer" />
        <span className={`conn-dot ${connected ? "on" : "off"}`} />
      </header>
      <div className="card waiting-card">
        <h2>{lobby.name}</h2>
        <p className="muted">Share this game's link or name so friends can join.</p>
        <ul className="seat-list">
          {lobby.players.map((p) => (
            <li key={p.userId} className="seat">
              <span className={`color-swatch ${p.color}`} />
              <span>{p.name}</span>
              {p.userId === lobby.hostId && <span className="host-tag">host</span>}
            </li>
          ))}
          {Array.from({ length: 4 - lobby.players.length }).map((_, i) => (
            <li key={i} className="seat empty">
              <span className="color-swatch empty" />
              <span className="muted">open seat</span>
            </li>
          ))}
        </ul>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          {isHost && !started && (
            <button
              className="btn primary"
              disabled={lobby.players.length < 2}
              onClick={onStart}
            >
              Start game
            </button>
          )}
          {!isHost && !started && (
            <p className="muted">Waiting for the host to start…</p>
          )}
          <button className="btn" onClick={onLeave}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
