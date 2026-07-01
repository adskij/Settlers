import { useEffect, useRef, useState, useCallback } from "react";
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
  const [actionError, setActionError] = useState<string | null>(null);
  const joinAttempted = useRef(false);

  // Reset any selected build tool whenever the turn/phase changes.
  const phaseKey = `${sock.state?.phase}:${sock.state?.currentPlayerIndex}`;
  useEffect(() => setBuildMode(null), [phaseKey]);

  // After playing Road Building (or any free-road effect), drop straight into
  // road-placement mode so the player can just tap the board.
  const youAreCurrent =
    !!sock.state &&
    sock.state.players[sock.state.currentPlayerIndex]?.color === sock.you;
  const freeRoads = sock.state?.freeRoadsRemaining ?? 0;
  useEffect(() => {
    if (freeRoads > 0 && youAreCurrent) setBuildMode("road");
  }, [freeRoads, youAreCurrent]);

  // The host deleted this game while we were in it — return to the lobby.
  useEffect(() => {
    if (sock.closedReason) {
      alert(sock.closedReason);
      onExit();
    }
  }, [sock.closedReason, onExit]);

  // While the game hasn't started, poll lobby info over REST.
  const refreshLobby = useCallback(() => {
    api
      .getGame(gameId)
      .then((r) => setLobby(r.game))
      .catch((e) => {
        // Game no longer exists (deleted) — leave the empty waiting room.
        if (/not found/i.test((e as Error).message)) onExit();
      });
  }, [gameId, onExit]);

  useEffect(() => {
    if (sock.state) return; // game running; WS drives everything
    refreshLobby();
    const t = setInterval(refreshLobby, 3000);
    return () => clearInterval(t);
  }, [sock.state, refreshLobby]);

  // Arrived via an invite link and not seated yet? Take an open seat.
  useEffect(() => {
    if (!lobby || sock.state || joinAttempted.current) return;
    if (lobby.phase !== "lobby") return;
    if (lobby.players.some((p) => p.userId === user.id)) return;
    joinAttempted.current = true;
    api
      .joinGame(gameId)
      .then((r) => setLobby(r.game))
      .catch((e) => setActionError((e as Error).message));
  }, [lobby, sock.state, gameId, user.id]);

  const leave = async () => {
    sock.send({ type: "leave_game" });
    try {
      await api.leaveGame(gameId);
    } catch {
      /* already started; just exit */
    }
    onExit();
  };

  const addBot = async () => {
    setActionError(null);
    try {
      const r = await api.addBot(gameId);
      setLobby(r.game);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const removeBot = async (botUserId: string) => {
    setActionError(null);
    try {
      const r = await api.removeBot(gameId, botUserId);
      setLobby(r.game);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  if (!sock.state) {
    return (
      <WaitingRoom
        gameId={gameId}
        lobby={lobby}
        user={user}
        connected={sock.connected}
        error={actionError ?? sock.error}
        onStart={() => sock.send({ type: "start_game" })}
        onAddBot={addBot}
        onRemoveBot={removeBot}
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
  gameId,
  lobby,
  user,
  connected,
  error,
  onStart,
  onAddBot,
  onRemoveBot,
  onLeave,
  onBack,
}: {
  gameId: string;
  lobby: LobbyGame | null;
  user: CurrentUser;
  connected: boolean;
  error: string | null;
  onStart: () => void;
  onAddBot: () => void;
  onRemoveBot: (botUserId: string) => void;
  onLeave: () => void;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!lobby) return <div className="centered">Connecting…</div>;
  const isHost = lobby.hostId === user.id;
  const started = lobby.phase !== "lobby";
  const openSeats = 4 - lobby.players.length;

  const inviteUrl = `${window.location.origin}${window.location.pathname}?game=${gameId}`;
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      /* clipboard blocked; the field below is selectable as a fallback */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

        {/* Invite link */}
        <div className="invite">
          <p className="muted">Invite players with this link:</p>
          <div className="invite-row">
            <input className="invite-input" readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={copyInvite}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>

        <ul className="seat-list">
          {lobby.players.map((p) => (
            <li key={p.userId} className="seat">
              <span className={`color-swatch ${p.color}`} />
              <span>
                {p.isBot ? "🤖 " : ""}
                {p.name}
              </span>
              {p.userId === lobby.hostId && <span className="host-tag">host</span>}
              {isHost && !started && p.isBot && (
                <button
                  className="seat-remove"
                  title="Remove bot"
                  onClick={() => onRemoveBot(p.userId)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {Array.from({ length: openSeats }).map((_, i) => (
            <li key={i} className="seat empty">
              <span className="color-swatch empty" />
              <span className="muted">open seat</span>
              {isHost && !started && (
                <button className="seat-addbot" onClick={onAddBot}>
                  + Add bot
                </button>
              )}
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
