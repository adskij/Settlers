import { useMemo, useState } from "react";
import type {
  ClientMessage,
  GameState,
  PlayerColor,
  PortKind,
  Terrain,
} from "@settlers/shared";
import type { BuildMode } from "./GameScreen.js";

// Per-terrain [light, base, dark] for a subtle radial "relief" gradient.
const TERRAIN_GRAD: Record<Terrain, [string, string]> = {
  lumber: ["#3f8a4c", "#234f29"],
  wool: ["#a7da6c", "#6da23c"],
  grain: ["#f4d877", "#c79f2e"],
  brick: ["#cc6a40", "#8c3d1f"],
  ore: ["#9aa6b4", "#5d6976"],
  desert: ["#e8dab4", "#c2ac7c"],
};

// Faint motif drawn behind each tile's number token.
const TERRAIN_GLYPH: Record<Terrain, string> = {
  lumber: "🌲",
  wool: "🐑",
  grain: "🌾",
  brick: "🧱",
  ore: "⛰️",
  desert: "🏜️",
};

const PORT_COLOR: Record<PortKind, string> = {
  brick: "#b5562f",
  lumber: "#2f6b3a",
  wool: "#7fae3f",
  grain: "#e0b62f",
  ore: "#6f7c8b",
  any: "#3a7d8c",
};

const PORT_ICON: Record<PortKind, string> = {
  brick: "🧱",
  lumber: "🌲",
  wool: "🐑",
  grain: "🌾",
  ore: "⛰️",
  any: "⚓",
};

const PLAYER_FILL: Record<PlayerColor, string> = {
  red: "#d64545",
  blue: "#3f7fd6",
  white: "#f0f0f0",
  orange: "#e6892b",
};

export function Board({
  state,
  you,
  send,
  buildMode,
  clearBuildMode,
}: {
  state: GameState;
  you: PlayerColor | null;
  send: (msg: ClientMessage) => void;
  buildMode: BuildMode;
  clearBuildMode: () => void;
}) {
  const board = state.board;
  const [robberHex, setRobberHex] = useState<number | null>(null);

  const isYourTurn = state.players[state.currentPlayerIndex]?.color === you;

  // Compute viewBox from vertex extents with padding.
  const view = useMemo(() => {
    const xs = board.vertices.map((v) => v.pos.x);
    const ys = board.vertices.map((v) => v.pos.y);
    const pad = 9; // extra room for port signs hanging off the coast
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) - minX + pad;
    const h = Math.max(...ys) - minY + pad;
    return { minX, minY, w, h };
  }, [board]);

  const center = useMemo(() => {
    const n = board.vertices.length;
    const sx = board.vertices.reduce((s, v) => s + v.pos.x, 0);
    const sy = board.vertices.reduce((s, v) => s + v.pos.y, 0);
    return { x: sx / n, y: sy / n };
  }, [board]);

  // One marker per coastal port edge (both endpoints carry the same port).
  const portEdges = useMemo(() => {
    const out: { id: number; kind: PortKind; mid: { x: number; y: number }; sign: { x: number; y: number }; v1: { x: number; y: number }; v2: { x: number; y: number } }[] = [];
    for (const e of board.edges) {
      const a = board.vertices[e.v1];
      const b = board.vertices[e.v2];
      if (a.port && b.port && a.port === b.port) {
        const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
        const dx = mid.x - center.x;
        const dy = mid.y - center.y;
        const len = Math.hypot(dx, dy) || 1;
        const sign = { x: mid.x + (dx / len) * 4, y: mid.y + (dy / len) * 4 };
        out.push({ id: e.id, kind: a.port, mid, sign, v1: a.pos, v2: b.pos });
      }
    }
    return out;
  }, [board, center]);

  // --- interaction handlers ---
  const onVertex = (vertexId: number) => {
    if (!isYourTurn) return;
    if (state.phase === "setup" && state.setupStep === "settlement") {
      send({ type: "place_setup_settlement", vertexId });
    } else if (state.phase === "main" && buildMode === "settlement") {
      send({ type: "build_settlement", vertexId });
      clearBuildMode();
    } else if (state.phase === "main" && buildMode === "city") {
      send({ type: "build_city", vertexId });
      clearBuildMode();
    }
  };

  const onEdge = (edgeId: number) => {
    if (!isYourTurn) return;
    if (state.phase === "setup" && state.setupStep === "road") {
      send({ type: "place_setup_road", edgeId });
    } else if (state.phase === "main" && buildMode === "road") {
      send({ type: "build_road", edgeId });
      clearBuildMode();
    }
  };

  const onHex = (hexId: number) => {
    if (!isYourTurn || state.phase !== "moving_robber") return;
    setRobberHex(hexId);
  };

  // Steal targets for the chosen robber hex.
  const stealTargets = useMemo(() => {
    if (robberHex == null) return [];
    const colors = new Set<PlayerColor>();
    for (const b of state.buildings) {
      const v = board.vertices[b.vertexId];
      if (v.hexIds.includes(robberHex) && b.owner !== you) colors.add(b.owner);
    }
    return [...colors];
  }, [robberHex, state.buildings, board, you]);

  const confirmRobber = (stealFrom: PlayerColor | null) => {
    if (robberHex == null) return;
    send({ type: "move_robber", hexId: robberHex, stealFrom });
    setRobberHex(null);
  };

  const vertexActive =
    isYourTurn &&
    ((state.phase === "setup" && state.setupStep === "settlement") ||
      (state.phase === "main" && (buildMode === "settlement" || buildMode === "city")));
  const edgeActive =
    isYourTurn &&
    ((state.phase === "setup" && state.setupStep === "road") ||
      (state.phase === "main" && buildMode === "road"));
  const hexActive = isYourTurn && state.phase === "moving_robber";

  return (
    <div className="board-wrap">
      <svg
        className="board-svg"
        viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          {(Object.keys(TERRAIN_GRAD) as Terrain[]).map((t) => (
            <radialGradient key={t} id={`tg-${t}`} cx="0.5" cy="0.42" r="0.65">
              <stop offset="0%" stopColor={TERRAIN_GRAD[t][0]} />
              <stop offset="100%" stopColor={TERRAIN_GRAD[t][1]} />
            </radialGradient>
          ))}
          {/* Subtle grain overlay for a textured, non-flat surface. */}
          <pattern id="tile-grain" width="1.4" height="1.4" patternUnits="userSpaceOnUse" patternTransform="rotate(12)">
            <rect width="1.4" height="1.4" fill="transparent" />
            <circle cx="0.35" cy="0.35" r="0.16" fill="#000" opacity="0.05" />
            <circle cx="1.0" cy="1.0" r="0.12" fill="#fff" opacity="0.05" />
          </pattern>
          <filter id="piece-shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="0.25" stdDeviation="0.35" floodColor="#000" floodOpacity="0.4" />
          </filter>
          {/* Robber: dark stone with a top-down highlight for a 3D pawn look. */}
          <linearGradient id="robber-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5b5b68" />
            <stop offset="55%" stopColor="#33333d" />
            <stop offset="100%" stopColor="#141418" />
          </linearGradient>
        </defs>

        {/* Hexes */}
        {board.hexes.map((hex) => {
          const pts = hex.vertexIds
            .map((vid) => board.vertices[vid].pos)
            .map((p) => `${p.x},${p.y}`)
            .join(" ");
          return (
            <g key={hex.id} onClick={() => onHex(hex.id)}>
              <polygon
                points={pts}
                fill={`url(#tg-${hex.terrain})`}
                stroke="#0f2a17"
                strokeWidth={0.35}
                strokeLinejoin="round"
                className={hexActive ? "hex-clickable" : ""}
              />
              <polygon points={pts} fill="url(#tile-grain)" pointerEvents="none" />
              {/* Faint terrain motif */}
              <text
                x={hex.center.x}
                y={hex.center.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={6.5}
                opacity={0.18}
                pointerEvents="none"
              >
                {TERRAIN_GLYPH[hex.terrain]}
              </text>
              {hex.number != null && hex.id !== board.robberHexId && (
                <NumberToken cx={hex.center.x} cy={hex.center.y} n={hex.number} />
              )}
              {hex.id === board.robberHexId && (
                <Robber cx={hex.center.x} cy={hex.center.y} />
              )}
            </g>
          );
        })}

        {/* Ports: dock lines + a clear colored sign */}
        {portEdges.map((p) => (
          <g key={`port-${p.id}`} pointerEvents="none">
            <line x1={p.sign.x} y1={p.sign.y} x2={p.v1.x} y2={p.v1.y} stroke="#6b4f2a" strokeWidth={0.45} opacity={0.85} />
            <line x1={p.sign.x} y1={p.sign.y} x2={p.v2.x} y2={p.v2.y} stroke="#6b4f2a" strokeWidth={0.45} opacity={0.85} />
            <g filter="url(#piece-shadow)">
              <rect
                x={p.sign.x - 2.6}
                y={p.sign.y - 2.6}
                width={5.2}
                height={5.2}
                rx={1.1}
                fill="#f5ead0"
                stroke={PORT_COLOR[p.kind]}
                strokeWidth={0.7}
              />
            </g>
            <text x={p.sign.x} y={p.sign.y - 0.7} textAnchor="middle" dominantBaseline="central" fontSize={2.4}>
              {PORT_ICON[p.kind]}
            </text>
            <text
              x={p.sign.x}
              y={p.sign.y + 1.5}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={1.7}
              fontWeight={800}
              fill={PORT_COLOR[p.kind]}
            >
              {p.kind === "any" ? "3:1" : "2:1"}
            </text>
          </g>
        ))}

        {/* Edges (roads + clickable slots) */}
        {board.edges.map((e) => {
          const v1 = board.vertices[e.v1].pos;
          const v2 = board.vertices[e.v2].pos;
          const road = state.roads.find((r) => r.edgeId === e.id);
          if (road) {
            return (
              <g key={e.id} pointerEvents="none">
                <line x1={v1.x} y1={v1.y} x2={v2.x} y2={v2.y} stroke="#11212b" strokeWidth={1.9} strokeLinecap="round" />
                <line x1={v1.x} y1={v1.y} x2={v2.x} y2={v2.y} stroke={PLAYER_FILL[road.owner]} strokeWidth={1.3} strokeLinecap="round" />
              </g>
            );
          }
          return (
            <line
              key={e.id}
              x1={v1.x}
              y1={v1.y}
              x2={v2.x}
              y2={v2.y}
              stroke={edgeActive ? "#ffffff" : "transparent"}
              strokeOpacity={edgeActive ? 0.55 : 0}
              strokeWidth={edgeActive ? 1.2 : 2.4}
              strokeLinecap="round"
              className={edgeActive ? "edge-clickable" : "edge-hit"}
              onClick={() => onEdge(e.id)}
            />
          );
        })}

        {/* Vertices (buildings + clickable slots) */}
        {board.vertices.map((v) => {
          const b = state.buildings.find((bb) => bb.vertexId === v.id);
          if (b) {
            return (
              <g key={v.id} filter="url(#piece-shadow)" onClick={() => onVertex(v.id)}>
                {b.kind === "city" ? (
                  <rect
                    x={v.pos.x - 1.7}
                    y={v.pos.y - 1.7}
                    width={3.4}
                    height={3.4}
                    rx={0.5}
                    fill={PLAYER_FILL[b.owner]}
                    stroke="#11212b"
                    strokeWidth={0.4}
                  />
                ) : (
                  <circle
                    cx={v.pos.x}
                    cy={v.pos.y}
                    r={1.6}
                    fill={PLAYER_FILL[b.owner]}
                    stroke="#11212b"
                    strokeWidth={0.4}
                  />
                )}
                {b.metropolis && (
                  // Metropolis: a small gold dome crowning the city (+2 VP).
                  <g>
                    <path
                      d={`M ${v.pos.x - 1.1} ${v.pos.y - 1.4} Q ${v.pos.x} ${v.pos.y - 3.2} ${
                        v.pos.x + 1.1
                      } ${v.pos.y - 1.4} Z`}
                      fill="#f4cf4a"
                      stroke="#8a6a12"
                      strokeWidth={0.28}
                    />
                    <circle cx={v.pos.x} cy={v.pos.y - 3.1} r={0.42} fill="#f4cf4a" stroke="#8a6a12" strokeWidth={0.2} />
                  </g>
                )}
              </g>
            );
          }
          return (
            <circle
              key={v.id}
              cx={v.pos.x}
              cy={v.pos.y}
              r={vertexActive ? 1.5 : 1.6}
              fill={vertexActive ? "#ffffff" : "transparent"}
              fillOpacity={vertexActive ? 0.65 : 0}
              className={vertexActive ? "vertex-clickable" : "vertex-hit"}
              onClick={() => onVertex(v.id)}
            />
          );
        })}
      </svg>

      {robberHex != null && (
        <div className="robber-prompt">
          <p>Steal from:</p>
          <div className="row">
            {stealTargets.length === 0 && (
              <button className="btn" onClick={() => confirmRobber(null)}>
                No one (confirm)
              </button>
            )}
            {stealTargets.map((c) => (
              <button key={c} className="btn" onClick={() => confirmRobber(c)}>
                <span className={`color-swatch ${c}`} /> {c}
              </button>
            ))}
            <button className="link-btn" onClick={() => setRobberHex(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Wooden number token with red highlight on the high-probability 6 & 8.
// The robber: a classic dark pawn (hooded silhouette) with shading, a head
// highlight and a soft ground shadow, sitting on the blocked hex.
function Robber({ cx, cy }: { cx: number; cy: number }) {
  const body = `M ${cx - 0.85} ${cy - 1.3}
    C ${cx - 1.5} ${cy - 0.1} ${cx - 2.1} ${cy + 1.4} ${cx - 2.1} ${cy + 2.2}
    Q ${cx - 2.1} ${cy + 2.9} ${cx - 1.4} ${cy + 2.9}
    L ${cx + 1.4} ${cy + 2.9}
    Q ${cx + 2.1} ${cy + 2.9} ${cx + 2.1} ${cy + 2.2}
    C ${cx + 2.1} ${cy + 1.4} ${cx + 1.5} ${cy - 0.1} ${cx + 0.85} ${cy - 1.3} Z`;
  return (
    <g pointerEvents="none">
      {/* soft shadow on the ground */}
      <ellipse cx={cx} cy={cy + 3.15} rx={2.6} ry={0.7} fill="#000" opacity={0.35} />
      <g filter="url(#piece-shadow)">
        <path d={body} fill="url(#robber-grad)" stroke="#0c0c10" strokeWidth={0.25} />
        {/* collar between head and body */}
        <ellipse cx={cx} cy={cy - 1.2} rx={1.15} ry={0.42} fill="url(#robber-grad)" stroke="#0c0c10" strokeWidth={0.2} />
        {/* head */}
        <circle cx={cx} cy={cy - 2.6} r={1.45} fill="url(#robber-grad)" stroke="#0c0c10" strokeWidth={0.25} />
        {/* highlight */}
        <ellipse cx={cx - 0.45} cy={cy - 3.0} rx={0.5} ry={0.72} fill="#ffffff" opacity={0.22} />
      </g>
    </g>
  );
}

function NumberToken({ cx, cy, n }: { cx: number; cy: number; n: number }) {
  const hot = n === 6 || n === 8;
  const pips = 6 - Math.abs(7 - n); // probability dots
  return (
    <g pointerEvents="none" filter="url(#piece-shadow)">
      <circle cx={cx} cy={cy} r={2.7} fill="#f5efd9" stroke="#b79b6b" strokeWidth={0.3} />
      <text
        x={cx}
        y={cy - 0.3}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={2.7}
        fontWeight={800}
        fill={hot ? "#c0392b" : "#2b2b2b"}
      >
        {n}
      </text>
      {/* probability pips */}
      <g fill={hot ? "#c0392b" : "#6b6b6b"}>
        {Array.from({ length: pips }).map((_, i) => (
          <circle key={i} cx={cx - (pips - 1) * 0.25 + i * 0.5} cy={cy + 1.7} r={0.18} />
        ))}
      </g>
    </g>
  );
}
