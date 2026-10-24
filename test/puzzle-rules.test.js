const test = require("node:test");
const assert = require("node:assert/strict");

test("chess.js loads FEN with castling, en passant, and promotion", async () => {
  const { Chess } = await import("../lib/chess.js");
  const castle = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert.ok(castle.move("e1g1"));
  const ep = new Chess("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3");
  assert.ok(ep.move("e5f6"));
  const promo = new Chess("8/P7/8/8/8/8/8/4K2k w - - 0 1");
  assert.ok(promo.move({ from: "a7", to: "a8", promotion: "q" }));
  assert.equal(promo.get("a8").type, "q");
});

test("Retry Your Blunders no longer packages Chess.com navigation hooks", () => {
  const { packSession } = require("../lib/puzzle-session.js");
  const session = packSession({
    result: {
      gameId: "1",
      white: { name: "a" },
      black: { name: "b" },
      plies: [
        {
          ply: 10,
          fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          san: "e5",
          bestUci: "e7e5",
          cls: "blunder",
          color: "b",
          moveNumber: 5,
          drop: 15,
        },
      ],
    },
    username: "b",
  });
  const blob = JSON.stringify(session);
  assert.equal(blob.includes("jumpToPly"), false);
  assert.equal(blob.includes("clickMoveNode"), false);
  assert.equal(blob.includes("next move"), false);
  assert.ok(session.puzzles[0].fen.startsWith("rnbqkbnr"));
});
