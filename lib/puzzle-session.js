// Pure helpers for Retry Your Blunders training sessions (no DOM, no Chess.com).
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CfnPuzzleSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
  const CLASS_RANK = { blunder: 0, mistake: 1, inaccuracy: 2 };

  function buildPuzzleItems(result, username) {
    const me = String(username || "").trim().toLowerCase();
    const own =
      me && String(result?.white?.name || "").toLowerCase() === me
        ? "w"
        : me && String(result?.black?.name || "").toLowerCase() === me
          ? "b"
          : null;
    const stale = !(result?.plies || []).some((p) => p.fen);
    const items = (result?.plies || [])
      .filter((p) => p.fen && p.bestUci && CLASS_RANK[p.cls] != null && (!own || p.color === own))
      .sort((a, b) => CLASS_RANK[a.cls] - CLASS_RANK[b.cls] || b.drop - a.drop)
      .slice(0, 5)
      .map((p, i) => ({
        id: `${result.gameId || "game"}-${p.ply}-${i}`,
        ply: p.ply,
        fen: p.fen,
        san: p.san,
        best: p.best,
        bestUci: p.bestUci,
        acceptedUcis: [String(p.bestUci).toLowerCase()],
        line: [String(p.bestUci).toLowerCase()],
        cls: p.cls,
        color: p.color,
        moveNumber: p.moveNumber,
        drop: p.drop,
      }));
    return { own, stale, items };
  }

  function packSession({ result, username, sourceTabId, sourceUrl }) {
    const built = buildPuzzleItems(result, username);
    const orientation = built.own || "w";
    return {
      version: 1,
      gameId: result?.gameId || "",
      sourceTabId: sourceTabId ?? null,
      sourceUrl: sourceUrl || "",
      createdAt: Date.now(),
      orientation,
      players: {
        white: {
          name: result?.white?.name || "White",
          rating: result?.white?.rating || null,
          accuracy: result?.white?.accuracy ?? null,
          counts: result?.white?.counts || null,
        },
        black: {
          name: result?.black?.name || "Black",
          rating: result?.black?.rating || null,
          accuracy: result?.black?.accuracy ?? null,
          counts: result?.black?.counts || null,
        },
      },
      evals: Array.isArray(result?.evals) ? result.evals : [],
      marks: (result?.plies || [])
        .filter((p) => p.cls === "brilliant" || p.cls === "inaccuracy" || p.cls === "mistake" || p.cls === "blunder")
        .map((p) => ({
          ply: p.ply,
          cls: p.cls,
          san: p.san,
          moveNumber: p.moveNumber,
          color: p.color,
        })),
      own: built.own,
      stale: built.stale,
      puzzles: built.items,
    };
  }

  function sessionIsFresh(session, now = Date.now()) {
    if (!session || !Array.isArray(session.puzzles)) return false;
    if (!session.createdAt) return false;
    return now - session.createdAt <= SESSION_TTL_MS;
  }

  function uciParts(uci) {
    const u = String(uci || "").toLowerCase();
    return {
      from: u.slice(0, 2),
      to: u.slice(2, 4),
      promotion: u.slice(4, 5) || "",
    };
  }

  function moveToUci(move) {
    if (!move) return "";
    return `${move.from}${move.to}${move.promotion || ""}`.toLowerCase();
  }

  // Compatible with a single bestUci today; accepts a list when present.
  function isAcceptedMove(puzzle, uci, step = 0) {
    const played = String(uci || "").toLowerCase();
    if (!played) return false;
    const line = puzzle.line || puzzle.acceptedUcis || [puzzle.bestUci];
    const expected = String(line[step] || puzzle.bestUci || "").toLowerCase();
    if (expected && played === expected) return true;
    const accepted = (puzzle.acceptedUcis || []).map((u) => String(u).toLowerCase());
    return step === 0 && accepted.includes(played);
  }

  function puzzleComplete(puzzle, stepAfterMove) {
    const line = puzzle.line || [puzzle.bestUci];
    return stepAfterMove >= line.length;
  }

  function hintPiece(puzzle, step = 0) {
    const { from } = uciParts((puzzle.line || [puzzle.bestUci])[step] || puzzle.bestUci);
    return from;
  }

  function hintDestination(puzzle, step = 0) {
    const { to } = uciParts((puzzle.line || [puzzle.bestUci])[step] || puzzle.bestUci);
    return to;
  }

  function accuracy({ solved, total, incorrectAttempts }) {
    const t = Number(total) || 0;
    if (!t) return 0;
    const wrong = Number(incorrectAttempts) || 0;
    const attempts = Number(solved) + wrong;
    if (!attempts) return 0;
    return Math.round((Number(solved) / attempts) * 1000) / 10;
  }

  function progressEntry({ gameId, puzzle, attempts, correct, hintsUsed, completed }) {
    return {
      gameId: gameId || "",
      puzzleId: puzzle?.id || "",
      fen: puzzle?.fen || "",
      attempts: Number(attempts) || 0,
      correct: !!correct,
      hintsUsed: Number(hintsUsed) || 0,
      completed: !!completed,
      completedAt: Date.now(),
    };
  }

  return {
    SESSION_TTL_MS,
    buildPuzzleItems,
    packSession,
    sessionIsFresh,
    uciParts,
    moveToUci,
    isAcceptedMove,
    puzzleComplete,
    hintPiece,
    hintDestination,
    accuracy,
    progressEntry,
  };
});
