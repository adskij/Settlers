import { useEffect, useState, useCallback } from "react";
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
      const r = await api.createGame(name || `${user.username}'s game`);
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
          {error && <p className="error-text">{error}</p>}
        </section>

        {mine.length > 0 && (
          <section className="card">
            <h2>Your games</h2>
            <GameList games={mine} userId={user.id} onEnter={onEnterGame} />
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
                    <span className="muted"> · {g.players.length}/4</span>
                  </div>
                  <button className="btn" onClick={() => join(g.id)}>
                    {g.players.some((p) => p.userId === user.id) ? "Open" : "Join"}
                  </button>
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
}: {
  games: LobbyGame[];
  userId: string;
  onEnter: (id: string) => void;
}) {
  return (
    <ul className="game-list">
      {games.map((g) => (
        <li key={g.id} className="game-row">
          <div>
            <strong>{g.name}</strong>
            <span className="muted">
              {" "}
              · {g.phase === "lobby" ? "waiting" : g.phase} · {g.players.length}/4
            </span>
          </div>
          <button className="btn" onClick={() => onEnter(g.id)}>
            Open
          </button>
        </li>
      ))}
    </ul>
  );
}
