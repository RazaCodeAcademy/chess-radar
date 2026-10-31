// Opening lines and engine choices. Book data is fetched live; these moves only
// identify each opening so the lesson can start without a network round trip.

export const ENGINES = [
  {
    id: "lichess-cloud",
    name: "Lichess Cloud",
    detail: "Stockfish at high depth on Lichess. Strongest option. Needs internet. Positions missing from their database use the local engine.",
  },
  {
    id: "stockfish-deep",
    name: "Stockfish 19 deep",
    detail: "Local Stockfish, searching longer. Works offline. Weaker than the cloud engine.",
  },
  {
    id: "stockfish-lite",
    name: "Stockfish 19 lite",
    detail: "Local Stockfish, faster and shallower. This is the engine the evaluation bar used before. Works offline.",
  },
];

export const ENGINE_SEARCH = {
  "stockfish-deep": "go depth 20 movetime 2800",
  "stockfish-lite": "go depth 16 movetime 1200",
};

export const OPENINGS = [
  { id: "italian", name: "Italian Game", eco: "C50", moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"] },
  { id: "ruy", name: "Ruy Lopez", eco: "C60", moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"] },
  { id: "scotch", name: "Scotch Game", eco: "C44", moves: ["e2e4", "e7e5", "g1f3", "b8c6", "d2d4"] },
  { id: "petrov", name: "Petrov Defense", eco: "C42", moves: ["e2e4", "e7e5", "g1f3", "g8f6"] },
  { id: "vienna", name: "Vienna Game", eco: "C25", moves: ["e2e4", "e7e5", "b1c3"] },
  { id: "kings-gambit", name: "King's Gambit", eco: "C30", moves: ["e2e4", "e7e5", "f2f4"] },
  { id: "sicilian-najdorf", name: "Sicilian Defense: Najdorf", eco: "B90", moves: ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6"] },
  { id: "sicilian-dragon", name: "Sicilian Defense: Dragon", eco: "B70", moves: ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "g7g6"] },
  { id: "sicilian-sveshnikov", name: "Sicilian Defense: Sveshnikov", eco: "B33", moves: ["e2e4", "c7c5", "g1f3", "b8c6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "e7e5"] },
  { id: "french", name: "French Defense", eco: "C00", moves: ["e2e4", "e7e6"] },
  { id: "caro", name: "Caro-Kann Defense", eco: "B10", moves: ["e2e4", "c7c6"] },
  { id: "scandinavian", name: "Scandinavian Defense", eco: "B01", moves: ["e2e4", "d7d5"] },
  { id: "alekhine", name: "Alekhine Defense", eco: "B02", moves: ["e2e4", "g8f6"] },
  { id: "qgd", name: "Queen's Gambit Declined", eco: "D30", moves: ["d2d4", "d7d5", "c2c4", "e7e6"] },
  { id: "qga", name: "Queen's Gambit Accepted", eco: "D20", moves: ["d2d4", "d7d5", "c2c4", "d5c4"] },
  { id: "slav", name: "Slav Defense", eco: "D10", moves: ["d2d4", "d7d5", "c2c4", "c7c6"] },
  { id: "nimzo", name: "Nimzo-Indian Defense", eco: "E20", moves: ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4"] },
  { id: "kings-indian", name: "King's Indian Defense", eco: "E60", moves: ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6"] },
  { id: "grunfeld", name: "Grünfeld Defense", eco: "D80", moves: ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "d7d5"] },
  { id: "catalan", name: "Catalan Opening", eco: "E00", moves: ["d2d4", "g8f6", "c2c4", "e7e6", "g2g3"] },
  { id: "london", name: "London System", eco: "D02", moves: ["d2d4", "d7d5", "c1f4"] },
  { id: "dutch", name: "Dutch Defense", eco: "A80", moves: ["d2d4", "f7f5"] },
  { id: "benoni", name: "Benoni Defense", eco: "A65", moves: ["d2d4", "g8f6", "c2c4", "c7c5"] },
  { id: "english", name: "English Opening", eco: "A10", moves: ["c2c4"] },
  { id: "reti", name: "Réti Opening", eco: "A04", moves: ["g1f3"] },
];

const MASTER_WEIGHT = 4;
const THEORY_MASTERS = 15;
const THEORY_LICHESS = 120;

export function popularity(move) {
  return (move?.masters || 0) * MASTER_WEIGHT + (move?.lichess || 0) + (move?.rank || 0) * 1000 + (move?.score || 0);
}

export function mergeBooks(masters, lichess) {
  const map = new Map();
  const take = (payload, source) => {
    for (const move of payload?.moves || []) {
      if (!move?.uci) continue;
      const row = map.get(move.uci) || {
        uci: move.uci,
        san: move.san || "",
        masters: 0,
        lichess: 0,
        white: 0,
        draws: 0,
        black: 0,
        opening: null,
      };
      const games = (move.white || 0) + (move.draws || 0) + (move.black || 0);
      row[source] += games;
      row.white += move.white || 0;
      row.draws += move.draws || 0;
      row.black += move.black || 0;
      if (move.san) row.san = move.san;
      if (move.opening?.name) row.opening = { eco: move.opening.eco || "", name: move.opening.name };
      map.set(move.uci, row);
    }
  };
  take(masters, "masters");
  take(lichess, "lichess");
  const moves = [...map.values()].sort((a, b) => popularity(b) - popularity(a) || a.uci.localeCompare(b.uci));
  const opening = masters?.opening?.name
    ? { eco: masters.opening.eco || "", name: masters.opening.name }
    : lichess?.opening?.name
      ? { eco: lichess.opening.eco || "", name: lichess.opening.name }
      : null;
  return { opening, moves };
}

export function isTheoryMove(move) {
  if (!move) return false;
  if ((move.masters || 0) >= THEORY_MASTERS || (move.lichess || 0) >= THEORY_LICHESS) return true;
  const dubious = /^\s*\?/.test(move.note || "");
  return (move.rank || 0) >= 1 && !dubious;
}

export function fromChessDb(payload) {
  const moves = (payload?.moves || [])
    .filter((move) => move?.uci)
    .map((move) => ({
      uci: move.uci,
      san: move.san || "",
      masters: 0,
      lichess: 0,
      white: 0,
      draws: 0,
      black: 0,
      rank: Number(move.rank) || 0,
      score: Number(move.score) || 0,
      note: move.note || "",
      opening: null,
    }));
  moves.sort((a, b) => popularity(b) - popularity(a) || a.uci.localeCompare(b.uci));
  return { opening: null, moves };
}

export function combineBooks(books) {
  const map = new Map();
  let opening = null;
  for (const book of books || []) {
    if (!opening && book?.opening?.name) opening = book.opening;
    for (const move of book?.moves || []) {
      const row = map.get(move.uci) || {
        uci: move.uci,
        san: "",
        masters: 0,
        lichess: 0,
        white: 0,
        draws: 0,
        black: 0,
        rank: 0,
        score: 0,
        note: "",
        opening: null,
      };
      row.masters += move.masters || 0;
      row.lichess += move.lichess || 0;
      row.white += move.white || 0;
      row.draws += move.draws || 0;
      row.black += move.black || 0;
      row.rank = Math.max(row.rank, move.rank || 0);
      if ((move.score || 0) > row.score) row.score = move.score;
      if (move.san) row.san = move.san;
      if (move.note) row.note = move.note;
      if (move.opening?.name) row.opening = move.opening;
      map.set(move.uci, row);
    }
  }
  const moves = [...map.values()].sort((a, b) => popularity(b) - popularity(a) || a.uci.localeCompare(b.uci));
  return { opening, moves };
}

export function classifyDeviation({ playedUci, book, lessonName, mainUci }) {
  const move = (book?.moves || []).find((row) => row.uci === playedUci) || null;
  if (!isTheoryMove(move)) return { kind: "unbooked", move };
  const name = move.opening?.name || book?.opening?.name || "";
  const differentName = name && lessonName && name.toLowerCase() !== lessonName.toLowerCase();
  const sideline = !!mainUci && playedUci !== mainUci;
  if (differentName || sideline) {
    return {
      kind: "variation",
      name: name || "A known sideline",
      eco: move.opening?.eco || book?.opening?.eco || "",
      move,
    };
  }
  return { kind: "book", move };
}

export function mateToCp(mate) {
  if (mate == null || Number.isNaN(Number(mate))) return null;
  const value = Number(mate);
  const sign = value > 0 ? 1 : value < 0 ? -1 : 0;
  if (!sign) return 0;
  return sign * (10000 - Math.min(99, Math.abs(value)) * 10);
}

export function scoreCp(result) {
  if (!result) return null;
  if (result.mate != null) return mateToCp(result.mate);
  if (result.cp == null) return null;
  return result.cp;
}

// Centipawn loss for the side that just moved. Scores are white's point of view.
export function moverLoss(cpBefore, cpAfter, color) {
  if (cpBefore == null || cpAfter == null) return null;
  return color === "w" ? cpBefore - cpAfter : cpAfter - cpBefore;
}

export function gradeLoss(loss) {
  if (loss == null) return { id: "unknown", label: "Unclear" };
  if (loss <= 0) return { id: "best", label: "Best move" };
  if (loss <= 20) return { id: "excellent", label: "Excellent" };
  if (loss <= 50) return { id: "good", label: "Good" };
  if (loss <= 100) return { id: "inaccuracy", label: "Inaccuracy" };
  if (loss <= 250) return { id: "mistake", label: "Mistake" };
  return { id: "blunder", label: "Blunder" };
}

export function explainBookMove(step, lessonName) {
  const name = step?.opening?.name || lessonName || "This opening";
  const total = (step?.white || 0) + (step?.draws || 0) + (step?.black || 0);
  if (total) {
    const whitePct = Math.round((step.white / total) * 100);
    const parts = [];
    if (step.masters) parts.push(`${step.masters.toLocaleString()} master games`);
    if (step.lichess) parts.push(`${step.lichess.toLocaleString()} rated games`);
    const where = parts.length ? ` It shows up in ${parts.join(" and ")}.` : "";
    return `${name}. ${step.san} is the main move here.${where} White scored about ${whitePct}% in those games.`;
  }
  if (step?.rank) {
    return `${name}. ${step.san} is a standard book move in ChessDB (rank ${step.rank}). Play it, or try another move to see if it is a different opening.`;
  }
  return `${step?.san || "This move"} is the move that defines ${name}.`;
}

export function openingNameFor(catalog, sans) {
  const pgn = sansToPgn(sans);
  if (!pgn || !catalog?.length) return null;
  let best = null;
  for (const row of catalog) {
    if (!row?.pgn) continue;
    const matches = pgn === row.pgn || pgn.startsWith(`${row.pgn} `);
    if (!matches) continue;
    if (!best || row.pgn.length > best.pgn.length) best = row;
  }
  return best ? { eco: best.eco, name: best.name } : null;
}

export function sansToPgn(sans) {
  const parts = [];
  for (let i = 0; i < (sans || []).length; i += 2) {
    const number = i / 2 + 1;
    parts.push(sans[i + 1] ? `${number}. ${sans[i]} ${sans[i + 1]}` : `${number}. ${sans[i]}`);
  }
  return parts.join(" ");
}
