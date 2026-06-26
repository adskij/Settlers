import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./lib/api.js";
import { AuthScreen } from "./components/AuthScreen.js";
import { LobbyScreen } from "./components/LobbyScreen.js";
import { GameScreen } from "./components/GameScreen.js";

export interface CurrentUser {
  id: string;
  username: string;
}

export function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);

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

  const logout = () => {
    setToken(null);
    setUser(null);
    setActiveGameId(null);
  };

  if (loading) {
    return <div className="centered">Loading…</div>;
  }

  if (!user) {
    return <AuthScreen onAuthed={setUser} />;
  }

  if (activeGameId) {
    return (
      <GameScreen
        gameId={activeGameId}
        user={user}
        onExit={() => setActiveGameId(null)}
      />
    );
  }

  return (
    <LobbyScreen
      user={user}
      onLogout={logout}
      onEnterGame={(id) => setActiveGameId(id)}
    />
  );
}
