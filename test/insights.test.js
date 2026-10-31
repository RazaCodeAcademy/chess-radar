const test = require("node:test");
const assert = require("node:assert/strict");

const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const queenless = "8/8/8/4k3/8/4K3/8/8 w - - 0 40";
const withQueen = "8/8/8/4k3/8/4K3/8/Q7 w - - 0 50";

function ply(partial) {
  return {
    ply: 1,
    moveNumber: 1,
    color: "w",
    san: "a3",
    uci: "a2a3",
    best: "e4",
    bestUci: "e2e4",
    drop: 12,
    cls: "mistake",
    fen: start,
    evalBefore: 20,
    evalAfter: -40,
    line: [],
    ...partial,
  };
}

test("quick takeaway is the largest meaningful loss, not a small inaccuracy", async () => {
  const { buildInsights } = await import("../lib/insights.js");
  const insights = buildInsights(
    [
      ply({ ply: 1, drop: 4, cls: "good", san: "a3" }),
      ply({ ply: 5, moveNumber: 3, drop: 18, cls: "blunder", san: "Nf3", evalBefore: 80, evalAfter: -260 }),
      ply({ ply: 9, moveNumber: 5, drop: 11, cls: "mistake", san: "h3" }),
    ],
    "w"
  );
  assert.equal(insights.takeaway.san, "Nf3");
  assert.equal(insights.takeaway.ply, 5);
  assert.match(insights.takeaway.text, /Nf3|playing/);
  assert.doesNotMatch(insights.takeaway.text, /guarantee|winning/);
});

test("opening mistakes stay inside the opening and cap at three", async () => {
  const { buildInsights } = await import("../lib/insights.js");
  const insights = buildInsights(
    [
      ply({ ply: 2, moveNumber: 1, drop: 12, san: "a3" }),
      ply({ ply: 6, moveNumber: 3, drop: 30, san: "h3" }),
      ply({ ply: 10, moveNumber: 5, drop: 16, san: "Na3" }),
      ply({ ply: 14, moveNumber: 7, drop: 22, san: "Nh3" }),
      ply({ ply: 30, moveNumber: 15, drop: 40, san: "Qh5" }),
      ply({ ply: 4, moveNumber: 2, drop: 6, cls: "inaccuracy", san: "d3" }),
    ],
    "w"
  );
  assert.deepEqual(
    insights.opening.map((row) => row.san),
    ["h3", "Nh3", "Na3"]
  );
});

test("a clean opening does not invent mistakes", async () => {
  const { buildInsights } = await import("../lib/insights.js");
  const insights = buildInsights([ply({ drop: 3, cls: "good", moveNumber: 2, evalBefore: 20, evalAfter: 0 })], "w");
  assert.deepEqual(insights.opening, []);
});

test("opening lists inaccuracies from the first 12 moves", async () => {
  const { buildInsights } = await import("../lib/insights.js");
  const insights = buildInsights(
    [
      ply({ ply: 2, moveNumber: 1, drop: 6, cls: "inaccuracy", san: "a3" }),
      ply({ ply: 40, moveNumber: 20, drop: 20, cls: "blunder", san: "Qh4" }),
    ],
    "w"
  );
  assert.deepEqual(
    insights.opening.map((row) => row.san),
    ["a3"]
  );
});

test("endgame takeaway requires a queenless position and uses the last significant blunder", async () => {
  const { buildInsights, queenlessFen } = await import("../lib/insights.js");
  assert.equal(queenlessFen(start), false);
  assert.equal(queenlessFen(queenless), true);
  assert.equal(queenlessFen(withQueen), false);

  const stillQueens = buildInsights([ply({ ply: 40, moveNumber: 20, drop: 25, cls: "blunder", fen: start })], "w");
  assert.equal(stillQueens.endgameEligible, false);
  assert.equal(stillQueens.endgame, null);

  const insights = buildInsights(
    [
      ply({ ply: 60, moveNumber: 30, drop: 40, cls: "blunder", san: "Kd2", fen: queenless }),
      ply({ ply: 70, moveNumber: 35, drop: 12, cls: "mistake", san: "Ke2", fen: queenless }),
      ply({ ply: 80, moveNumber: 40, drop: 50, cls: "blunder", san: "Qb2", fen: withQueen }),
    ],
    "w"
  );
  assert.equal(insights.endgameEligible, true);
  assert.equal(insights.endgame.san, "Ke2");
  assert.equal(insights.endgame.ply, 70);
});

test("a queenless inaccuracy is shown when the ending has no bigger mistake", async () => {
  const { buildInsights } = await import("../lib/insights.js");
  const insights = buildInsights(
    [ply({ ply: 60, moveNumber: 30, drop: 6, cls: "inaccuracy", san: "Kd3", fen: queenless })],
    "w"
  );
  assert.equal(insights.endgame.san, "Kd3");
});

test("throwing pawns in an already won ending still counts", async () => {
  const { buildInsights } = await import("../lib/insights.js");
  const insights = buildInsights(
    [
      ply({
        ply: 62,
        moveNumber: 31,
        drop: 3,
        cls: "good",
        san: "Kf3",
        fen: queenless,
        evalBefore: 600,
        evalAfter: 200,
      }),
    ],
    "w"
  );
  assert.equal(insights.endgame.san, "Kf3");
});

test("an accurate queenless move is not called a blunder", async () => {
  const { buildInsights } = await import("../lib/insights.js");
  const insights = buildInsights(
    [ply({ ply: 64, moveNumber: 32, drop: 2, cls: "good", fen: queenless, evalBefore: 30, evalAfter: 10 })],
    "w"
  );
  assert.equal(insights.endgameEligible, true);
  assert.equal(insights.endgame, null);
});

test("a losing position is not described as gaining an advantage", async () => {
  const { explainMistake } = await import("../lib/insights.js");
  const text = explainMistake({
    san: "Kf2",
    best: "Kd2",
    evalBefore: -400,
    evalAfter: -800,
    color: "w",
  });
  assert.match(text, /Kd2/);
  assert.doesNotMatch(text, /advantage|winning|won the/);
});

test("continuations stop at an illegal move and keep castling legal", async () => {
  const { legalContinuation } = await import("../lib/insights.js");
  const bad = legalContinuation(start, ["e1g1", "e7e5"], "e2e4");
  assert.equal(bad[0].uci, "e2e4");
  assert.ok(bad.every((step) => step.san));
  assert.ok(!bad.some((step) => step.uci === "e1g1"));

  const castleFen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const castle = legalContinuation(castleFen, ["e1g1", "e8e7", "e1e2"], "e1g1");
  assert.equal(castle[0].san, "O-O");
  assert.equal(castle[1].uci, "e8e7");
  assert.ok(!castle.some((step) => step.uci === "e1e2"));

  const ep = legalContinuation("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", ["e5d6"], "e5d6");
  assert.equal(ep[0].capture, true);
  assert.equal(ep[0].uci, "e5d6");
});
