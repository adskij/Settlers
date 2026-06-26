// Generates the standard 19-hex base-game board geometry from a numeric seed.
import type {
  Board,
  Edge,
  Hex,
  PortKind,
  Point,
  Terrain,
  Vertex,
} from "./types.js";
import { mulberry32, shuffle } from "./rng.js";

const HEX_SIZE = 10; // normalized units; client scales to pixels.

// Standard tile distribution (19 hexes).
const TERRAIN_BAG: Terrain[] = [
  "lumber", "lumber", "lumber", "lumber",
  "wool", "wool", "wool", "wool",
  "grain", "grain", "grain", "grain",
  "brick", "brick", "brick",
  "ore", "ore", "ore",
  "desert",
];

// Standard number tokens (18 of them; desert gets none).
const NUMBER_BAG = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

const PORT_BAG: PortKind[] = [
  "any", "any", "any", "any",
  "brick", "lumber", "wool", "grain", "ore",
];

function axialToPixel(q: number, r: number): Point {
  const x = HEX_SIZE * Math.sqrt(3) * (q + r / 2);
  const y = HEX_SIZE * (3 / 2) * r;
  return { x, y };
}

// Pointy-top hex corners.
function hexCorners(center: Point): Point[] {
  const corners: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({
      x: center.x + HEX_SIZE * Math.cos(angle),
      y: center.y + HEX_SIZE * Math.sin(angle),
    });
  }
  return corners;
}

function key(p: Point): string {
  return `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`;
}

function axialCoords(): { q: number; r: number }[] {
  const coords: { q: number; r: number }[] = [];
  const N = 2;
  for (let q = -N; q <= N; q++) {
    for (let r = -N; r <= N; r++) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= N) {
        coords.push({ q, r });
      }
    }
  }
  // Sort for stable ids (top-to-bottom, left-to-right).
  coords.sort((a, b) => a.r - b.r || a.q - b.q);
  return coords;
}

export function generateBoard(seed: number): Board {
  const rng = mulberry32(seed);
  const coords = axialCoords();

  const terrains = shuffle(TERRAIN_BAG, rng);
  const numbers = shuffle(NUMBER_BAG, rng);

  // Build vertices (deduped) and hexes.
  const vertexMap = new Map<string, Vertex>();
  const vertices: Vertex[] = [];
  const hexes: Hex[] = [];

  function getVertex(p: Point): Vertex {
    const k = key(p);
    let v = vertexMap.get(k);
    if (!v) {
      v = { id: vertices.length, pos: p, hexIds: [], adjacentVertexIds: [] };
      vertexMap.set(k, v);
      vertices.push(v);
    }
    return v;
  }

  let numberIdx = 0;
  coords.forEach((c, i) => {
    const center = axialToPixel(c.q, c.r);
    const terrain = terrains[i];
    const corners = hexCorners(center);
    const cornerVerts = corners.map(getVertex);
    const hex: Hex = {
      id: i,
      q: c.q,
      r: c.r,
      center,
      terrain,
      number: terrain === "desert" ? null : numbers[numberIdx++],
      vertexIds: cornerVerts.map((v) => v.id),
    };
    cornerVerts.forEach((v) => v.hexIds.push(hex.id));
    hexes.push(hex);
  });

  // Build edges from consecutive hex corners; dedupe by vertex pair.
  const edgeMap = new Map<string, Edge>();
  const edges: Edge[] = [];
  function edgeKey(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }
  function addEdge(v1: number, v2: number) {
    const k = edgeKey(v1, v2);
    if (edgeMap.has(k)) return;
    const p1 = vertices[v1].pos;
    const p2 = vertices[v2].pos;
    const edge: Edge = {
      id: edges.length,
      v1,
      v2,
      pos: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
    };
    edgeMap.set(k, edge);
    edges.push(edge);
    if (!vertices[v1].adjacentVertexIds.includes(v2))
      vertices[v1].adjacentVertexIds.push(v2);
    if (!vertices[v2].adjacentVertexIds.includes(v1))
      vertices[v2].adjacentVertexIds.push(v1);
  }

  hexes.forEach((hex) => {
    const vs = hex.vertexIds;
    for (let i = 0; i < vs.length; i++) {
      addEdge(vs[i], vs[(i + 1) % vs.length]);
    }
  });

  assignPorts(vertices, edges, rng);

  const robberHexId = hexes.find((h) => h.terrain === "desert")?.id ?? 0;

  return { hexes, vertices, edges, robberHexId };
}

// Place 9 ports on coastal edges, spread evenly around the board.
function assignPorts(vertices: Vertex[], edges: Edge[], rng: () => number) {
  // Coastal edge = belongs to exactly one hex => both vertices are coastal and
  // the edge's vertices share only that one hex. Approximate by: vertices with
  // < 3 adjacent hexes form the coast; an edge whose both endpoints are coastal
  // and that lies on the outer ring.
  const coastalEdges = edges.filter((e) => {
    const a = vertices[e.v1];
    const b = vertices[e.v2];
    const shared = a.hexIds.filter((h) => b.hexIds.includes(h));
    return shared.length === 1 && a.hexIds.length < 3 && b.hexIds.length < 3;
  });

  // Order coastal edges by angle around the centroid.
  const cx =
    vertices.reduce((s, v) => s + v.pos.x, 0) / vertices.length;
  const cy =
    vertices.reduce((s, v) => s + v.pos.y, 0) / vertices.length;
  coastalEdges.sort(
    (e1, e2) =>
      Math.atan2(e1.pos.y - cy, e1.pos.x - cx) -
      Math.atan2(e2.pos.y - cy, e2.pos.x - cx)
  );

  const ports = shuffle(PORT_BAG, rng);
  const count = coastalEdges.length;
  // Spread ~evenly, skipping edges between ports.
  for (let i = 0; i < ports.length && count > 0; i++) {
    const idx = Math.floor((i * count) / ports.length);
    const edge = coastalEdges[idx];
    if (!edge) continue;
    vertices[edge.v1].port = ports[i];
    vertices[edge.v2].port = ports[i];
  }
}
