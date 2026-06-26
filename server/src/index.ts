import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { router } from "./routes.js";
import { attachWebSocket } from "./ws.js";
import "./db.js"; // initialize schema on boot

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", router);
app.get("/health", (_req, res) => res.json({ ok: true }));

// In production (e.g. the Docker image) the server also serves the built
// client, so the whole app is a single artifact on one origin.
const clientDist = process.env.CLIENT_DIST;
if (clientDist && existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback for client-side routing (but never for the API/WS).
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
  console.log(`Serving client from ${clientDist}`);
}

const server = createServer(app);
attachWebSocket(server);

server.listen(PORT, () => {
  console.log(`Settlers server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
