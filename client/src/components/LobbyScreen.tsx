import { useEffect, useState, useCallback } from "react";
import type { GameVariant } from "@settlers/shared";
import { api } from "../lib/api.js";
import type { LobbyGame } from "../lib/types.js";
import type { CurrentUser } from "../App.js";

export function LobbyScreen({
  user,
  onLogout,
  onEnterGame,
}: {
  user: CurrentUser;
  onLogout: () => void;
  onEnterGame: (id: string) => void;
}) {
  const [open, setOpen] = useState<LobbyGame[]>([]);
  const [mine, setMine] = useState<LobbyGame[]>([]);
  const [name, setName] = useState("");
  const [variant, setVariant] = useState<GameVariant>("base");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listGames();
      setOpen(r.open);
      setMine(r.mine);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000); // light polling for lobby list
    return () => clearInterval(t);
  }, [refresh]);

  const create = async () => {
    setError(null);
    try {
      const r = await api.createGame(name || `${user.username}'s game`, variant);
      onEnterGame(r.game.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const join = async (id: string) => {
    setError(null);
    try {
      await api.joinGame(id);
      onEnterGame(id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const del = async (id: string) => {
    setError(null);
    if (!window.confirm("Delete this game for everyone? This can't be undone.")) return;
    try {
      await api.deleteGame(id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="lobby">
      <header className="topbar">
        <span className="brand-sm">⚓ Settlers</span>
        <span className="spacer" />
        <span className="user-chip">{user.username}</span>
        <button className="link-btn" onClick={onLogout}>
          Log out
        </button>
      </header>

      <div className="lobby-body">
        <section className="card">
          <h2>New game</h2>
          <div className="row">
            <input
              placeholder="Game name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn primary" onClick={create}>
              Create
            </button>
          </div>
          <div className="variant-picker">
            <span className="variant-label">Ruleset:</span>
            <div className="variant-seg">
              <button
                type="button"
                className={`variant-opt ${variant === "base" ? "on" : ""}`}
                onClick={() => setVariant("base")}
              >
                Base game
              </button>
              <button
                type="button"
                className={`variant-opt ${variant === "cities_and_knights" ? "on" : ""}`}
                onClick={() => setVariant("cities_and_knights")}
              >
                Cities &amp; Knights
              </button>
            </div>
          </div>
          <p className="variant-hint muted">
            {variant === "cities_and_knights"
              ? "Cities produce commodities you spend on city improvements; first to 13 VP wins."
              : "The classic game — first to 10 victory points wins."}
          </p>
          {error && <p className="error-text">{error}</p>}
        </section>

        {mine.length > 0 && (
          <section className="card">
            <h2>Your games</h2>
            <GameList games={mine} userId={user.id} onEnter={onEnterGame} onDelete={del} />
          </section>
        )}

        <section className="card">
          <h2>Open games</h2>
          {open.length === 0 ? (
            <p className="muted">No open games. Create one!</p>
          ) : (
            <ul className="game-list">
              {open.map((g) => (
                <li key={g.id} className="game-row">
                  <div>
                    <strong>{g.name}</strong>
                    {g.variant === "cities_and_knights" && (
                      <span className="ck-badge" title="Cities & Knights">C&amp;K</span>
                    )}
                    <span className="muted"> · {g.players.length}/4</span>
                  </div>
                  <div className="row">
                    <button className="btn" onClick={() => join(g.id)}>
                      {g.players.some((p) => p.userId === user.id) ? "Open" : "Join"}
                    </button>
                    {g.hostId === user.id && (
                      <button
                        className="btn danger"
                        title="Delete game"
                        onClick={() => del(g.id)}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function GameList({
  games,
  userId,
  onEnter,
  onDelete,
}: {
  games: LobbyGame[];
  userId: string;
  onEnter: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <ul className="game-list">
      {games.map((g) => (
        <li key={g.id} className="game-row">
          <div>
            <strong>{g.name}</strong>
            {g.variant === "cities_and_knights" && (
              <span className="ck-badge" title="Cities & Knights">C&amp;K</span>
            )}
            <span className="muted">
              {" "}
              · {g.phase === "lobby" ? "waiting" : g.phase} · {g.players.length}/4
            </span>
          </div>
          <div className="row">
            <button className="btn" onClick={() => onEnter(g.id)}>
              Open
            </button>
            {g.hostId === userId && (
              <button
                className="btn danger"
                title="Delete game"
                onClick={() => onDelete(g.id)}
              >
                🗑
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
