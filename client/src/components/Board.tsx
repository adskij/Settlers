import { useMemo, useState } from "react";
import type {
  ClientMessage,
  GameState,
  PlayerColor,
  Terrain,
} from "@settlers/shared";
import type { BuildMode } from "./GameScreen.js";

const TERRAIN_COLOR: Record<Terrain, string> = {
  lumber: "#2f6b3a",
  wool: "#8cc152",
  grain: "#e8c34a",
  brick: "#b5562f",
  ore: "#7d8a99",
  desert: "#d9c79a",
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
    const pad = 6;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) - minX + pad;
    const h = Math.max(...ys) - minY + pad;
    return { minX, minY, w, h };
  }, [board]);

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
                fill={TERRAIN_COLOR[hex.terrain]}
                stroke="#11212b"
                strokeWidth={0.3}
                className={hexActive ? "hex-clickable" : ""}
              />
              {hex.number != null && (
                <g>
                  <circle
                    cx={hex.center.x}
                    cy={hex.center.y}
                    r={2.6}
                    fill="#f5efd9"
                    stroke="#11212b"
                    strokeWidth={0.2}
                  />
                  <text
                    x={hex.center.x}
                    y={hex.center.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={2.6}
                    fontWeight={700}
                    fill={hex.number === 6 || hex.number === 8 ? "#c0392b" : "#222"}
                  >
                    {hex.number}
                  </text>
                </g>
              )}
              {hex.id === board.robberHexId && (
                <circle
                  cx={hex.center.x}
                  cy={hex.center.y - 4}
                  r={1.6}
                  fill="#111"
                  opacity={0.85}
                />
              )}
            </g>
          );
        })}

        {/* Ports */}
        {board.vertices
          .filter((v) => v.port)
          .map((v) => (
            <text
              key={`port-${v.id}`}
              x={v.pos.x}
              y={v.pos.y - 2}
              textAnchor="middle"
              fontSize={1.8}
              fill="#0d2430"
            >
              {v.port === "any" ? "3:1" : `2:1 ${v.port![0].toUpperCase()}`}
            </text>
          ))}

        {/* Edges (roads + clickable slots) */}
        {board.edges.map((e) => {
          const v1 = board.vertices[e.v1].pos;
          const v2 = board.vertices[e.v2].pos;
          const road = state.roads.find((r) => r.edgeId === e.id);
          if (road) {
            return (
              <line
                key={e.id}
                x1={v1.x}
                y1={v1.y}
                x2={v2.x}
                y2={v2.y}
                stroke={PLAYER_FILL[road.owner]}
                strokeWidth={1.4}
                strokeLinecap="round"
              />
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
              strokeOpacity={edgeActive ? 0.5 : 0}
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
            return b.kind === "city" ? (
              <rect
                key={v.id}
                x={v.pos.x - 1.6}
                y={v.pos.y - 1.6}
                width={3.2}
                height={3.2}
                rx={0.4}
                fill={PLAYER_FILL[b.owner]}
                stroke="#11212b"
                strokeWidth={0.3}
                onClick={() => onVertex(v.id)}
              />
            ) : (
              <circle
                key={v.id}
                cx={v.pos.x}
                cy={v.pos.y}
                r={1.5}
                fill={PLAYER_FILL[b.owner]}
                stroke="#11212b"
                strokeWidth={0.3}
                onClick={() => onVertex(v.id)}
              />
            );
          }
          return (
            <circle
              key={v.id}
              cx={v.pos.x}
              cy={v.pos.y}
              r={vertexActive ? 1.4 : 1.6}
              fill={vertexActive ? "#ffffff" : "transparent"}
              fillOpacity={vertexActive ? 0.6 : 0}
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
