// Pure helpers for pre-blunder puzzle navigation. No Chess.com DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CfnPuzzleBoard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Half-move to select so the board shows the position BEFORE this blunder ply (1-based).
  function targetNavPly(blunderPly) {
    const ply = Number(blunderPly) || 0;
    return ply <= 1 ? 0 : ply - 1;
  }

  function placementFromFen(fen) {
    const parts = String(fen || "").split(" ");
    const map = new Map();
    let i = 0;
    for (const row of (parts[0] || "").split("/")) {
      if (!row) continue;
      for (const ch of row) {
        if (/\d/.test(ch)) i += Number(ch);
        else {
          const file = (i % 8) + 1;
          const rank = 8 - Math.floor(i / 8);
          map.set(`${file}${rank}`, { color: ch === ch.toUpperCase() ? "w" : "b", type: ch.toLowerCase() });
          i += 1;
        }
      }
    }
    return {
      squares: map,
      sideToMove: parts[1] || "",
      castling: parts[2] || "",
      enPassant: parts[3] || "",
      halfmove: parts[4] || "",
      fullmove: parts[5] || "",
    };
  }

  function placementKey(squares) {
    return [...squares.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([sq, p]) => `${sq}:${p.color}${p.type}`)
      .join(" ");
  }

  // Piece placement only. Castling, en passant, and side to move are reported from the FEN, not proven by pieces.
  function comparePlacements(expectedFen, actualSquares) {
    const expected = placementFromFen(expectedFen);
    const mismatched = [];
    const squares = new Set([...expected.squares.keys(), ...actualSquares.keys()]);
    for (const sq of squares) {
      const a = expected.squares.get(sq);
      const b = actualSquares.get(sq);
      const same = a && b && a.color === b.color && a.type === b.type;
      const bothEmpty = !a && !b;
      if (!same && !bothEmpty) {
        mismatched.push({
          square: sq,
          expected: a ? `${a.color}${a.type}` : "",
          actual: b ? `${b.color}${b.type}` : "",
        });
      }
    }
    return {
      matched: mismatched.length === 0 && expected.squares.size === actualSquares.size,
      expectedPlacement: placementKey(expected.squares),
      actualPlacement: placementKey(actualSquares),
      mismatchedSquares: mismatched.sort((a, b) => a.square.localeCompare(b.square)),
      fenFieldsNotProvenByPieces: {
        sideToMove: expected.sideToMove,
        castling: expected.castling,
        enPassant: expected.enPassant,
        halfmove: expected.halfmove,
        fullmove: expected.fullmove,
      },
      piecePlacementOnly: true,
    };
  }

  // Chess.com square classes are board coordinates: 11 = a1, 18 = a8, 81 = h1, 88 = h8.
  // Flipping the board rotates the drawing. It does not renumber those classes.
  function squareFromClass(squareClass, flipped) {
    const match = String(squareClass || "").match(/square-(\d)(\d)/);
    if (!match) return "";
    void flipped;
    return `${match[1]}${match[2]}`;
  }

  function sanMatches(text, san) {
    const clean = String(san || "").replace(/[+#]/g, "").toLowerCase();
    if (!clean) return false;
    const compact = String(text || "").toLowerCase().replace(/\s+/g, "");
    if (!compact) return false;
    if (compact.includes(clean.replace(/[!?]/g, ""))) return true;
    const dest = clean.match(/[a-h][1-8]/g)?.pop();
    return !!dest && compact === dest;
  }

  // Pick the interactive main-line chip for a 1-based half-move. Never the Nth DOM node.
  function chooseMoveNode(candidates, ply, san) {
    const want = String(ply);
    const leaves = (candidates || []).filter(
      (c) =>
        c &&
        String(c.dataPly) === want &&
        c.visible !== false &&
        c.interactive &&
        !c.variation &&
        !c.containsOtherPly &&
        String(c.text || "").trim()
    );
    const main = leaves.filter((c) => c.mainLine);
    const pool = main.length ? main : leaves;
    const bySan = san ? pool.filter((c) => sanMatches(c.text, san)) : [];
    const chosen = (bySan.length ? bySan : pool).slice().sort((a, b) => a.text.length - b.text.length)[0];
    return chosen || null;
  }

  function activeBoardPieces(boards) {
    const visible = (boards || []).filter((b) => b && b.visible && Number(b.area) > 0);
    if (!visible.length) {
      return { boardId: null, squares: new Map(), reason: "Chess.com board pieces were not found." };
    }
    visible.sort((a, b) => Number(b.area) - Number(a.area));
    const board = visible[0];
    const squares = new Map();
    for (const piece of board.pieces || []) {
      if (!piece || piece.hidden || !piece.square) continue;
      if (!squares.has(piece.square)) squares.set(piece.square, { color: piece.color, type: piece.type });
    }
    return { boardId: board.id || "", squares, reason: squares.size ? "" : "Chess.com board pieces were not found." };
  }

  function flipSquare(square) {
    const file = Number(square[0]);
    const rank = Number(square[1]);
    if (file < 1 || file > 8 || rank < 1 || rank > 8) return square;
    return `${9 - file}${9 - rank}`;
  }

  function flipPlacement(squares) {
    const flipped = new Map();
    for (const [sq, piece] of squares) flipped.set(flipSquare(sq), piece);
    return flipped;
  }

  function closestHistoricalPosition(actualSquares, positions) {
    let exact = null;
    let closest = null;
    for (const pos of positions || []) {
      const compared = comparePlacements(pos.fen, actualSquares);
      const row = {
        shownAfterPly: pos.shownAfterPly,
        mismatches: compared.mismatchedSquares.length,
        matched: compared.matched,
      };
      if (compared.matched && !exact) exact = row;
      if (!closest || row.mismatches < closest.mismatches) closest = row;
    }
    const flipped = flipPlacement(actualSquares);
    let flippedExact = null;
    for (const pos of positions || []) {
      if (comparePlacements(pos.fen, flipped).matched) {
        flippedExact = pos.shownAfterPly;
        break;
      }
    }
    return {
      exactPly: exact ? exact.shownAfterPly : null,
      closestPly: closest ? closest.shownAfterPly : null,
      closestMismatches: closest ? closest.mismatches : null,
      flippedMatchesPly: flippedExact,
    };
  }

  function observationStatus({ matched, elapsedMs, timeoutMs, boardFound }) {
    if (!boardFound) return { done: true, matched: false, reason: "Chess.com board pieces were not found." };
    if (matched) return { done: true, matched: true, reason: "" };
    if (elapsedMs >= timeoutMs) {
      return { done: true, matched: false, reason: "Board did not reach the puzzle position within 2 seconds." };
    }
    return { done: false, matched: false, reason: "" };
  }

  return {
    targetNavPly,
    placementFromFen,
    comparePlacements,
    placementKey,
    squareFromClass,
    chooseMoveNode,
    activeBoardPieces,
    flipPlacement,
    closestHistoricalPosition,
    observationStatus,
  };
});
