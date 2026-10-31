// Insights derived from a finished-game review. No engine calls.
import { Chess } from "./chess.js";

export const OPENING_MOVES = 12;
export const MEANINGFUL_DROP = 10;
export const TAKEAWAY_DROP = 5;

export function queensInFen(fen) {
  const board = String(fen || "").split(" ")[0];
  return {
    w: (board.match(/Q/g) || []).length,
    b: (board.match(/q/g) || []).length,
  };
}

export function queenlessFen(fen) {
  const queens = queensInFen(fen);
  return queens.w === 0 && queens.b === 0;
}

export function moverCp(whiteCp, color) {
  if (whiteCp == null || Number.isNaN(Number(whiteCp))) return null;
  const value = Number(whiteCp);
  return color === "w" ? value : -value;
}

export function formatEval(whiteCp, color) {
  const value = moverCp(whiteCp, color);
  if (value == null) return "unclear";
  if (Math.abs(value) >= 9000) return value > 0 ? "mate" : "getting mated";
  const pawns = value / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

// Plays only moves chess.js accepts. Stops at the first illegal move.
export function legalContinuation(fen, pv, bestmove, limit = 6) {
  const raw = (Array.isArray(pv) ? pv : []).filter((uci) => uci && uci !== "(none)");
  const first = bestmove && bestmove !== "(none)" ? bestmove : raw[0];
  const list = !first ? raw : raw[0] === first ? raw : [first, ...raw];
  let board;
  try {
    board = new Chess(fen);
  } catch {
    return [];
  }
  const steps = [];
  for (const uci of list) {
    if (steps.length >= limit) break;
    const played = playUci(board, uci);
    if (!played) break;
    steps.push({
      uci: played.from + played.to + (played.promotion || ""),
      san: played.san,
      fen: board.fen(),
      check: board.inCheck(),
      capture: !!played.captured,
    });
  }
  return steps;
}

function playUci(board, uci) {
  const from = String(uci || "").slice(0, 2);
  const to = String(uci || "").slice(2, 4);
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return null;
  const given = uci[4];
  const tryMove = (promotion) => {
    try {
      return board.move({ from, to, promotion });
    } catch {
      return null;
    }
  };
  return tryMove(given) || (!given ? tryMove("q") : null);
}

export function explainMistake({ san, best, evalBefore, evalAfter, color }) {
  const before = moverCp(evalBefore, color);
  const after = moverCp(evalAfter, color);
  const alternative = best ? `playing ${best}` : "the engine's best move";
  const beforeText = formatEval(evalBefore, color);
  const afterText = formatEval(evalAfter, color);
  if (before == null || after == null) {
    return `${san} was worse than ${alternative}.`;
  }
  if (after <= -150 && before > -80) {
    return `${alternative} would have avoided a lost position. ${san} left the evaluation at ${afterText}.`;
  }
  if (before >= 150 && after < 80) {
    return `${alternative} would have kept a clear advantage. ${san} dropped it from ${beforeText} to ${afterText}.`;
  }
  const lost = before - after;
  if (lost >= 80) {
    return `${alternative} holds the evaluation near ${beforeText} instead of ${afterText} after ${san}.`;
  }
  return `${alternative} was the stronger choice. ${san} made the position worse by about ${Math.max(0, lost / 100).toFixed(1)} pawns.`;
}

function pack(ply) {
  return {
    ply: ply.ply,
    moveNumber: ply.moveNumber,
    color: ply.color,
    san: ply.san,
    uci: ply.uci,
    best: ply.best,
    bestUci: ply.bestUci,
    drop: ply.drop,
    cls: ply.cls,
    fen: ply.fen,
    evalBefore: ply.evalBefore ?? null,
    evalAfter: ply.evalAfter ?? null,
    line: Array.isArray(ply.line) ? ply.line : [],
    text: explainMistake({
      san: ply.san,
      best: ply.best,
      evalBefore: ply.evalBefore,
      evalAfter: ply.evalAfter,
      color: ply.color,
    }),
  };
}

// Pawns lost from the mover's side. Win chance stays flat once a game is already
// decided, so a thrown piece in a won or lost ending would otherwise disappear.
function lossPawns(ply) {
  const before = moverCp(ply.evalBefore, ply.color);
  const after = moverCp(ply.evalAfter, ply.color);
  if (before == null || after == null) return 0;
  return Math.max(0, (before - after) / 100);
}

function hasAlternative(ply) {
  const alt = ply.best || ply.bestUci;
  return !!(alt && alt !== "(none)");
}

function worthShowing(ply) {
  return (
    ply.cls === "blunder" ||
    ply.cls === "mistake" ||
    ply.cls === "inaccuracy" ||
    (ply.drop || 0) >= TAKEAWAY_DROP ||
    lossPawns(ply) >= 0.8
  );
}

function serious(ply) {
  return ply.cls === "blunder" || ply.cls === "mistake" || (ply.drop || 0) >= MEANINGFUL_DROP || lossPawns(ply) >= 1.5;
}

export function buildInsights(plies, color) {
  const mine = (plies || []).filter((ply) => ply.color === color && hasAlternative(ply));
  const byDrop = (a, b) => b.drop - a.drop || a.ply - b.ply;
  const byLoss = (a, b) => lossPawns(b) - lossPawns(a) || b.drop - a.drop || a.ply - b.ply;
  const takeaway =
    mine
      .filter((ply) => (ply.drop || 0) >= TAKEAWAY_DROP || lossPawns(ply) >= 0.8)
      .sort(byDrop)[0] || null;
  const opening = mine
    .filter((ply) => ply.moveNumber <= OPENING_MOVES && worthShowing(ply))
    .sort(byLoss)
    .slice(0, 3)
    .map(pack);
  const queenless = mine.filter((ply) => queenlessFen(ply.fen));
  const fromEnd = [...queenless].reverse();
  const endgame = fromEnd.find(serious) || fromEnd.find(worthShowing) || null;
  return {
    takeaway: takeaway ? pack(takeaway) : null,
    opening,
    endgameEligible: queenless.length > 0,
    endgame: endgame ? pack(endgame) : null,
  };
}
