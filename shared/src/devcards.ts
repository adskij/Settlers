import type { DevCardKind } from "./types.js";
import { shuffle } from "./rng.js";

// Standard development card deck (25 cards).
export function buildDevDeck(rng: () => number): DevCardKind[] {
  const deck: DevCardKind[] = [
    ...Array(14).fill("knight"),
    ...Array(5).fill("victory_point"),
    ...Array(2).fill("road_building"),
    ...Array(2).fill("year_of_plenty"),
    ...Array(2).fill("monopoly"),
  ];
  return shuffle(deck, rng);
}
