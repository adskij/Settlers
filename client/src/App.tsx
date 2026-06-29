import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./lib/api.js";
import { AuthScreen } from "./components/AuthScreen.js";
import { LobbyScreen } from "./components/LobbyScreen.js";
import { GameScreen } from "./components/GameScreen.js";

export interface CurrentUser {
  id: string;
  username: string;
}

// Read ?game=<id> from the URL so invite links deep-link into a game.
function gameIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("game");
}

// Reflect the active game in the URL so it's shareable / survives refresh.
function setUrlGame(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("game", id);
  else url.searchParams.delete("game");
  window.history.replaceState({}, "", url.toString());
}

export function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeGameId, setActiveGameId] = useState<string | null>(gameIdFromUrl);

  // Restore session from a stored token on first load.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const enterGame = (id: string | null) => {
    setActiveGameId(id);
    setUrlGame(id);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    enterGame(null);
  };

  if (loading) {
    return <div className="centered">Loading…</div>;
  }

  if (!user) {
    // Preserve the invite link through login so the user lands in the game.
    return <AuthScreen onAuthed={setUser} />;
  }

  if (activeGameId) {
    return (
      <GameScreen
        gameId={activeGameId}
        user={user}
        onExit={() => enterGame(null)}
      />
    );
  }

  return (
    <LobbyScreen user={user} onLogout={logout} onEnterGame={enterGame} />
  );
}
