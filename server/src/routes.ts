import { Router, type Request, type Response, type NextFunction } from "express";
import {
  HttpError,
  loginUser,
  registerUser,
  signToken,
  verifyToken,
} from "./auth.js";
import {
  addBot,
  createLobby,
  deleteGame,
  getLobby,
  joinLobby,
  leaveLobby,
  listMyGames,
  listOpenLobbies,
  removeBot,
} from "./gameManager.js";

export const router = Router();

interface AuthedRequest extends Request {
  userId?: string;
  username?: string;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    req.username = payload.username;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session." });
  }
}

function wrap(fn: (req: AuthedRequest, res: Response) => void) {
  return (req: AuthedRequest, res: Response) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
      } else {
        res.status(400).json({ error: (err as Error).message });
      }
    }
  };
}

// ---- Auth ----

router.post(
  "/auth/register",
  wrap((req, res) => {
    const { username, password } = req.body ?? {};
    const user = registerUser(username, password);
    res.json({ token: signToken(user), user: { id: user.id, username: user.username } });
  })
);

router.post(
  "/auth/login",
  wrap((req, res) => {
    const { username, password } = req.body ?? {};
    const user = loginUser(username, password);
    res.json({ token: signToken(user), user: { id: user.id, username: user.username } });
  })
);

router.get(
  "/me",
  requireAuth,
  wrap((req, res) => {
    res.json({ user: { id: req.userId, username: req.username } });
  })
);

// ---- Lobby ----

router.get(
  "/games",
  requireAuth,
  wrap((req, res) => {
    res.json({ open: listOpenLobbies(), mine: listMyGames(req.userId!) });
  })
);

router.post(
  "/games",
  requireAuth,
  wrap((req, res) => {
    const variant =
      req.body?.variant === "cities_and_knights" ? "cities_and_knights" : "base";
    const lobby = createLobby(req.userId!, req.body?.name ?? "New Game", variant);
    res.json({ game: lobby });
  })
);

router.get(
  "/games/:id",
  requireAuth,
  wrap((req, res) => {
    const lobby = getLobby(req.params.id);
    if (!lobby) return res.status(404).json({ error: "Game not found." });
    res.json({ game: lobby });
  })
);

router.post(
  "/games/:id/join",
  requireAuth,
  wrap((req, res) => {
    res.json({ game: joinLobby(req.params.id, req.userId!) });
  })
);

router.post(
  "/games/:id/leave",
  requireAuth,
  wrap((req, res) => {
    leaveLobby(req.params.id, req.userId!);
    res.json({ ok: true });
  })
);

router.post(
  "/games/:id/delete",
  requireAuth,
  wrap((req, res) => {
    deleteGame(req.params.id, req.userId!);
    res.json({ ok: true });
  })
);

router.post(
  "/games/:id/bots",
  requireAuth,
  wrap((req, res) => {
    res.json({ game: addBot(req.params.id, req.userId!) });
  })
);

router.post(
  "/games/:id/bots/remove",
  requireAuth,
  wrap((req, res) => {
    res.json({ game: removeBot(req.params.id, req.userId!, req.body?.botUserId) });
  })
);
