const test = require("node:test");
const assert = require("node:assert/strict");

test("opening books merge master games ahead of the Lichess database", async () => {
  const { mergeBooks, popularity } = await import("../lib/theory-data.js");
  const book = mergeBooks(
    { opening: { eco: "C50", name: "Italian Game" }, moves: [{ uci: "g1f3", san: "Nf3", white: 40, draws: 10, black: 20 }] },
    {
      moves: [
        { uci: "g1f3", san: "Nf3", white: 10, draws: 0, black: 0 },
        { uci: "b1c3", san: "Nc3", white: 80, draws: 10, black: 10, opening: { eco: "C25", name: "Vienna Game" } },
      ],
    }
  );
  assert.equal(book.opening.name, "Italian Game");
  assert.equal(book.moves[0].uci, "g1f3");
  assert.equal(book.moves[0].masters, 70);
  assert.equal(book.moves[0].lichess, 10);
  assert.ok(popularity(book.moves[0]) > popularity(book.moves[1]));
  assert.equal(book.moves[1].opening.name, "Vienna Game");
});

test("a rare move is not theory, and a named sideline is another variation", async () => {
  const { classifyDeviation } = await import("../lib/theory-data.js");
  const book = {
    opening: { eco: "C50", name: "Italian Game" },
    moves: [
      { uci: "f1c4", san: "Bc4", masters: 80, lichess: 400, opening: { eco: "C50", name: "Italian Game" } },
      { uci: "f1b5", san: "Bb5", masters: 60, lichess: 300, opening: { eco: "C60", name: "Ruy Lopez" } },
      { uci: "f2f4", san: "f4", masters: 1, lichess: 4 },
    ],
  };
  assert.equal(classifyDeviation({ playedUci: "a2a3", book, lessonName: "Italian Game", mainUci: "f1c4" }).kind, "unbooked");
  assert.equal(classifyDeviation({ playedUci: "f2f4", book, lessonName: "Italian Game", mainUci: "f1c4" }).kind, "unbooked");
  const variation = classifyDeviation({ playedUci: "f1b5", book, lessonName: "Italian Game", mainUci: "f1c4" });
  assert.equal(variation.kind, "variation");
  assert.equal(variation.name, "Ruy Lopez");
  assert.equal(classifyDeviation({ playedUci: "f1c4", book, lessonName: "Italian Game", mainUci: "f1c4" }).kind, "book");
});

test("chessdb rank marks book moves, and a question-mark move is not theory", async () => {
  const { isTheoryMove, fromChessDb, openingNameFor, sansToPgn } = await import("../lib/theory-data.js");
  const book = fromChessDb({
    moves: [
      { uci: "f1c4", san: "Bc4", score: 0, rank: 1, note: "* (31-02)" },
      { uci: "e1e2", san: "Ke2", score: -253, rank: 0, note: "? (31-01)" },
    ],
  });
  assert.equal(isTheoryMove(book.moves.find((move) => move.uci === "f1c4")), true);
  assert.equal(isTheoryMove(book.moves.find((move) => move.uci === "e1e2")), false);
  assert.equal(sansToPgn(["e4", "e6"]), "1. e4 e6");
  const named = openingNameFor(
    [
      { eco: "C00", name: "French Defense", pgn: "1. e4 e6" },
      { eco: "C01", name: "French Defense: Exchange", pgn: "1. e4 e6 2. d4 d5 3. exd5" },
    ],
    ["e4", "e6", "d4", "d5", "exd5"]
  );
  assert.equal(named.name, "French Defense: Exchange");
});

test("move grades follow centipawn loss from the side that moved", async () => {
  const { gradeLoss, moverLoss, scoreCp } = await import("../lib/theory-data.js");
  assert.equal(moverLoss(30, -180, "w"), 210);
  assert.equal(moverLoss(30, 80, "b"), 50);
  assert.equal(gradeLoss(0).id, "best");
  assert.equal(gradeLoss(15).id, "excellent");
  assert.equal(gradeLoss(40).id, "good");
  assert.equal(gradeLoss(80).id, "inaccuracy");
  assert.equal(gradeLoss(180).id, "mistake");
  assert.equal(gradeLoss(400).label, "Blunder");
  assert.equal(scoreCp({ mate: 2 }), 9980);
  assert.equal(scoreCp({ cp: -15 }), -15);
});
