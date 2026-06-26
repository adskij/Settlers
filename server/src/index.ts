import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { router } from "./routes.js";
import { attachWebSocket } from "./ws.js";
import "./db.js"; // initialize schema on boot

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", router);
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = createServer(app);
attachWebSocket(server);

server.listen(PORT, () => {
  console.log(`Settlers server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
