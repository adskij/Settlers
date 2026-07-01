import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  GameState,
  PlayerColor,
  ServerMessage,
} from "@settlers/shared";
import { getToken } from "./api.js";

function wsUrl(): string {
  const override = import.meta.env.VITE_WS_URL;
  if (override) return override as string;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export interface GameSocket {
  connected: boolean;
  state: GameState | null;
  you: PlayerColor | null;
  error: string | null;
  /** Set when the server closes this game (e.g. host deleted it). */
  closedReason: string | null;
  send: (msg: ClientMessage) => void;
  clearError: () => void;
}

export function useGameSocket(gameId: string | null): GameSocket {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<GameState | null>(null);
  const [you, setYou] = useState<PlayerColor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) return;
    const token = getToken();
    if (!token) return;

    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(`${wsUrl()}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: "join_game", gameId } as ClientMessage));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.type === "state") {
          setState(msg.state);
          setYou(msg.you);
        } else if (msg.type === "error") {
          setError(msg.message);
        } else if (msg.type === "closed") {
          closedByUs = true; // game is gone; don't try to reconnect
          setClosedReason(msg.reason);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) retry = setTimeout(connect, 1500); // auto-reconnect
      };
    };

    connect();
    return () => {
      closedByUs = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [gameId]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { connected, state, you, error, closedReason, send, clearError };
}
