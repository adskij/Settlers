import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { ClientMessage, ServerMessage } from "@settlers/shared";
import { verifyToken } from "./auth.js";
import {
  handleAction,
  loadGame,
  setBroadcaster,
  setOnDeleted,
  setConnected,
  startGame,
  colorForUser,
} from "./gameManager.js";
import { redactFor } from "./engine.js";

interface Client {
  ws: WebSocket;
  userId: string;
  gameId: string | null;
}

// gameId -> set of connected clients (for broadcast).
const rooms = new Map<string, Set<Client>>();

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Let the game manager push bot moves to all clients in a room.
  setBroadcaster(broadcastState);

  // When a game is deleted, tell everyone in its room and clear it.
  setOnDeleted((gameId) => {
    const room = rooms.get(gameId);
    if (!room) return;
    for (const client of room) {
      send(client.ws, { type: "closed", reason: "The host deleted this game." });
      client.gameId = null;
    }
    rooms.delete(gameId);
  });

  wss.on("connection", (ws, req) => {
    // Authenticate via ?token= query param.
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    let userId: string;
    try {
      userId = verifyToken(token ?? "").userId;
    } catch {
      send(ws, { type: "error", message: "Authentication failed." });
      ws.close();
      return;
    }

    const client: Client = { ws, userId, gameId: null };

    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(ws, { type: "error", message: "Malformed message." });
      }
      handleClientMessage(client, msg);
    });

    ws.on("close", () => {
      if (client.gameId) {
        rooms.get(client.gameId)?.delete(client);
        setConnected(client.gameId, client.userId, false);
        broadcastState(client.gameId);
      }
    });
  });
}

function handleClientMessage(client: Client, msg: ClientMessage) {
  try {
    if (msg.type === "join_game") {
      joinRoom(client, msg.gameId);
      return;
    }
    if (msg.type === "leave_game") {
      leaveRoom(client);
      return;
    }
    if (!client.gameId) {
      return send(client.ws, { type: "error", message: "Join a game first." });
    }
    if (msg.type === "start_game") {
      try {
        startGame(client.gameId, client.userId);
      } catch (err) {
        return send(client.ws, { type: "error", message: (err as Error).message });
      }
      broadcastState(client.gameId);
      return;
    }

    const { result } = handleAction(client.gameId, client.userId, msg);
    if (!result.ok) {
      send(client.ws, { type: "error", message: result.error ?? "Invalid action." });
    }
    broadcastState(client.gameId);
  } catch (err) {
    send(client.ws, { type: "error", message: (err as Error).message });
  }
}

function joinRoom(client: Client, gameId: string) {
  leaveRoom(client);
  client.gameId = gameId;
  if (!rooms.has(gameId)) rooms.set(gameId, new Set());
  rooms.get(gameId)!.add(client);
  setConnected(gameId, client.userId, true);
  // Send current state (may be a started game or still a lobby).
  sendStateTo(client);
  broadcastState(gameId);
}

function leaveRoom(client: Client) {
  if (!client.gameId) return;
  const room = rooms.get(client.gameId);
  room?.delete(client);
  setConnected(client.gameId, client.userId, false);
  const gid = client.gameId;
  client.gameId = null;
  broadcastState(gid);
}

function sendStateTo(client: Client) {
  if (!client.gameId) return;
  const game = loadGame(client.gameId);
  if (!game) return; // still in lobby; REST drives lobby UI
  const color = colorForUser(game, client.userId);
  send(client.ws, { type: "state", state: redactFor(game.state, color), you: color });
}

function broadcastState(gameId: string) {
  const game = loadGame(gameId);
  if (!game) return;
  const room = rooms.get(gameId);
  if (!room) return;
  for (const client of room) {
    const color = colorForUser(game, client.userId);
    send(client.ws, { type: "state", state: redactFor(game.state, color), you: color });
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
