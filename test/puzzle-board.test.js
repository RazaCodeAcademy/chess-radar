const test = require("node:test");
const assert = require("node:assert/strict");
const {
  targetNavPly,
  placementFromFen,
  comparePlacements,
  squareFromClass,
  chooseMoveNode,
  activeBoardPieces,
  closestHistoricalPosition,
  observationStatus,
} = require("../lib/puzzle-board.js");

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("white blunder on move 18 is ply 35, navigate to ply 34", () => {
  assert.equal(targetNavPly(35), 34);
});

test("black blunder on move 18 is ply 36, navigate to ply 35", () => {
  assert.equal(targetNavPly(36), 35);
});

test("first-move mistake navigates to the start position", () => {
  assert.equal(targetNavPly(1), 0);
});

test("middle-game and late-game plies stay one half-move earlier", () => {
  assert.equal(targetNavPly(20), 19);
  assert.equal(targetNavPly(59), 58);
});

test("FEN piece placement round-trips the starting position", () => {
  const placed = placementFromFen(START);
  assert.equal(placed.squares.get("52").type, "p");
  assert.equal(placed.squares.get("52").color, "w");
  assert.equal(placed.squares.get("28").type, "n");
  assert.equal(placed.squares.get("28").color, "b");
  assert.equal(placed.sideToMove, "w");
  assert.equal(placed.castling, "KQkq");
  assert.equal(placed.squares.size, 32);
});

test("successful board verification matches every occupied square", () => {
  const actual = placementFromFen(START).squares;
  const result = comparePlacements(START, actual);
  assert.equal(result.matched, true);
  assert.equal(result.mismatchedSquares.length, 0);
  assert.equal(result.piecePlacementOnly, true);
});

test("failed board verification lists mismatched squares", () => {
  const actual = placementFromFen(START).squares;
  actual.delete("52");
  actual.set("54", { color: "w", type: "p" });
  const result = comparePlacements(START, actual);
  assert.equal(result.matched, false);
  assert.ok(result.mismatchedSquares.some((m) => m.square === "52" && m.actual === ""));
  assert.ok(result.mismatchedSquares.some((m) => m.square === "54" && m.expected === ""));
});

test("piece comparison does not claim castling or en passant were seen on the board", () => {
  const result = comparePlacements("8/8/8/8/8/8/8/4K2k w - a3 0 40", new Map());
  assert.equal(result.fenFieldsNotProvenByPieces.castling, "-");
  assert.equal(result.fenFieldsNotProvenByPieces.enPassant, "a3");
  assert.equal(result.fenFieldsNotProvenByPieces.sideToMove, "w");
  assert.equal(result.piecePlacementOnly, true);
});

const BEFORE_PLY_60 = "3r1rk1/1pp1q1p1/p5Qp/3bb3/4N3/3B3P/PPP5/1K3RR1 b - - 8 30";
const AFTER_PLY_60 = "3r1rk1/1pp3p1/p3q1Qp/3bb3/4N3/3B3P/PPP5/1K3RR1 w - - 9 31";
const AFTER_PLY_58 = "3r1rk1/1pp1q1p1/p6p/3bb3/4N3/3B3P/PPP3Q1/1K3RR1 w - - 7 30";

test("one-based data-ply 59 is the move before ply 60, not the zero-based slot", () => {
  assert.equal(targetNavPly(60), 59);
  const nodes = [
    { dataPly: "58", text: "Qe5", mainLine: true, interactive: true, visible: true, variation: false, containsOtherPly: false },
    { dataPly: "59", text: "Qg6", mainLine: true, interactive: true, visible: true, variation: false, containsOtherPly: false },
    { dataPly: "60", text: "Qe6", mainLine: true, interactive: true, visible: true, variation: false, containsOtherPly: false },
  ];
  assert.equal(chooseMoveNode(nodes, 59, "Qg6").text, "Qg6");
  assert.equal(chooseMoveNode(nodes, 59, "Qg6").dataPly, "59");
});

test("a short variation chip with the same data-ply is not the main-line target", () => {
  const nodes = [
    { dataPly: "59", text: "e4", mainLine: false, interactive: true, visible: true, variation: true, containsOtherPly: false },
    { dataPly: "59", text: "30.", mainLine: true, interactive: true, visible: true, variation: false, containsOtherPly: true },
    { dataPly: "59", text: "Qg6", mainLine: true, interactive: true, visible: true, variation: false, containsOtherPly: false },
  ];
  assert.equal(chooseMoveNode(nodes, 59, "Qg6").text, "Qg6");
});

test("missing main-line node does not fall back to another ply", () => {
  const nodes = [
    { dataPly: "58", text: "h3", mainLine: true, interactive: true, visible: true, variation: false, containsOtherPly: false },
    { dataPly: "60", text: "Qe6", mainLine: true, interactive: true, visible: true, variation: false, containsOtherPly: false },
  ];
  assert.equal(chooseMoveNode(nodes, 59, "Qg6"), null);
});

test("square classes stay a1/a8/h1/h8 when the board is flipped", () => {
  assert.equal(squareFromClass("piece wr square-11", false), "11");
  assert.equal(squareFromClass("piece br square-18", true), "18");
  assert.equal(squareFromClass("piece wr square-81", true), "81");
  assert.equal(squareFromClass("piece br square-88", true), "88");
});

test("hidden pieces and a second board are ignored", () => {
  const start = placementFromFen(START);
  const pieces = [...start.squares].map(([square, piece]) => ({ square, ...piece, hidden: false }));
  pieces.push({ square: "52", color: "w", type: "q", hidden: true });
  const read = activeBoardPieces([
    { id: "thumbnail", visible: true, area: 100, pieces: [{ square: "11", color: "w", type: "r" }] },
    { id: "post-game", visible: true, area: 40000, pieces },
    { id: "hidden-preview", visible: false, area: 90000, pieces: [{ square: "55", color: "b", type: "q" }] },
  ]);
  assert.equal(read.boardId, "post-game");
  assert.equal(comparePlacements(START, read.squares).matched, true);
});

test("missing board is reported instead of reading stray pieces", () => {
  const read = activeBoardPieces([{ id: "offscreen", visible: false, area: 0, pieces: [{ square: "11", color: "w", type: "r" }] }]);
  assert.equal(read.boardId, null);
  assert.match(read.reason, /not found/);
});

test("position after the blunder is a different historical ply than the puzzle position", () => {
  const positions = [
    { shownAfterPly: 58, fen: AFTER_PLY_58 },
    { shownAfterPly: 59, fen: BEFORE_PLY_60 },
    { shownAfterPly: 60, fen: AFTER_PLY_60 },
  ];
  const expected = closestHistoricalPosition(placementFromFen(BEFORE_PLY_60).squares, positions);
  assert.equal(expected.exactPly, 59);
  const afterBlunder = closestHistoricalPosition(placementFromFen(AFTER_PLY_60).squares, positions);
  assert.equal(afterBlunder.exactPly, 60);
  assert.notEqual(afterBlunder.exactPly, 59);
});

test("navigation wait succeeds on a match and times out without one", () => {
  assert.equal(observationStatus({ matched: true, elapsedMs: 20, timeoutMs: 2000, boardFound: true }).matched, true);
  assert.match(observationStatus({ matched: false, elapsedMs: 2000, timeoutMs: 2000, boardFound: true }).reason, /2 seconds/);
  assert.equal(observationStatus({ matched: false, elapsedMs: 50, timeoutMs: 2000, boardFound: false }).done, true);
  assert.equal(observationStatus({ matched: false, elapsedMs: 50, timeoutMs: 2000, boardFound: true }).done, false);
});
