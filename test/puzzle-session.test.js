const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPuzzleItems,
  packSession,
  sessionIsFresh,
  isAcceptedMove,
  puzzleComplete,
  hintPiece,
  hintDestination,
  accuracy,
  progressEntry,
  SESSION_TTL_MS,
} = require("../lib/puzzle-session.js");

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const BEFORE = "3r1rk1/1pp1q1p1/p5Qp/3bb3/4N3/3B3P/PPP5/1K3RR1 b - - 8 30";

function sampleResult() {
  return {
    gameId: "185448182494",
    white: { name: "alice" },
    black: { name: "bob" },
    plies: [
      { ply: 1, fen: START, san: "e4", bestUci: "e2e4", cls: "best", color: "w", moveNumber: 1, drop: 0 },
      { ply: 20, fen: BEFORE, san: "Qe6", bestUci: "e7e6", cls: "inaccuracy", color: "b", moveNumber: 10, drop: 6 },
      { ply: 39, fen: BEFORE, san: "h3", bestUci: "g2g4", cls: "mistake", color: "w", moveNumber: 20, drop: 12 },
      { ply: 40, fen: BEFORE, san: "Qe6", bestUci: "f8e8", cls: "blunder", color: "b", moveNumber: 20, drop: 20 },
      { ply: 60, fen: BEFORE, san: "Qe6", bestUci: "e7e6", cls: "blunder", color: "b", moveNumber: 30, drop: 18 },
    ],
  };
}

test("loads exact FEN and ranks blunders before mistakes", () => {
  const built = buildPuzzleItems(sampleResult(), "bob");
  assert.equal(built.own, "b");
  assert.equal(built.items[0].cls, "blunder");
  assert.equal(built.items[0].fen, BEFORE);
  assert.ok(built.items.every((p) => p.fen.includes(" ")));
});

test("white and black orientation come from the player color", () => {
  assert.equal(packSession({ result: sampleResult(), username: "alice" }).orientation, "w");
  assert.equal(packSession({ result: sampleResult(), username: "bob" }).orientation, "b");
});

test("accepted move validation keeps bestUci and allows listed equivalents", () => {
  const puzzle = { bestUci: "e7e6", acceptedUcis: ["e7e6", "f8e8"], line: ["e7e6"] };
  assert.equal(isAcceptedMove(puzzle, "e7e6"), true);
  assert.equal(isAcceptedMove(puzzle, "f8e8"), true);
  assert.equal(isAcceptedMove(puzzle, "a2a3"), false);
});

test("illegal empty moves are rejected", () => {
  assert.equal(isAcceptedMove({ bestUci: "e2e4" }, ""), false);
});

test("single-move puzzles complete after the first correct move", () => {
  assert.equal(puzzleComplete({ line: ["e7e6"] }, 1), true);
  assert.equal(puzzleComplete({ line: ["e7e6", "g6g7", "e6e1"] }, 1), false);
});

test("hints expose origin then destination squares", () => {
  const puzzle = { bestUci: "e7e6", line: ["e7e6"] };
  assert.equal(hintPiece(puzzle), "e7");
  assert.equal(hintDestination(puzzle), "e6");
});

test("progress entries store game and puzzle identity", () => {
  const entry = progressEntry({
    gameId: "185448182494",
    puzzle: { id: "p1", fen: BEFORE },
    attempts: 2,
    correct: true,
    hintsUsed: 1,
    completed: true,
  });
  assert.equal(entry.gameId, "185448182494");
  assert.equal(entry.puzzleId, "p1");
  assert.equal(entry.fen, BEFORE);
  assert.equal(entry.correct, true);
});

test("session expiration uses the configured TTL", () => {
  const fresh = { puzzles: [{}], createdAt: Date.now() };
  const old = { puzzles: [{}], createdAt: Date.now() - SESSION_TTL_MS - 1 };
  assert.equal(sessionIsFresh(fresh), true);
  assert.equal(sessionIsFresh(old), false);
  assert.equal(sessionIsFresh(null), false);
});

test("accuracy ignores invented scores and uses attempt counts", () => {
  assert.equal(accuracy({ solved: 4, total: 5, incorrectAttempts: 1 }), 80);
  assert.equal(accuracy({ solved: 0, total: 0, incorrectAttempts: 0 }), 0);
});

test("puzzle packaging never invents FENs or Chess.com navigation actions", () => {
  const session = packSession({ result: sampleResult(), username: "bob" });
  assert.ok(session.puzzles.every((p) => typeof p.fen === "string" && p.fen.split(" ").length >= 4));
  assert.equal(session.puzzles.some((p) => p.nav === "next"), false);
  assert.equal(JSON.stringify(session).includes("jumpToPly"), false);
});
