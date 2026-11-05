// Full-game review: replays a game and scores every move with a dedicated Stockfish worker.
import { Chess } from "./lib/chess.js";
import { decodeTcn } from "./lib/tcn.js";
import { buildInsights, legalContinuation } from "./lib/insights.js";
import { beginAnalysis, endAnalysis, engineSearch } from "./engine-host.js";

const MATE_CP = 10000;
const ANALYSIS_DEPTHS = [12, 14, 16, 18, 20, 22, 24];
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

const CLASSES = [
  { name: "blunder", minDrop: 15 },
  { name: "mistake", minDrop: 10 },
  { name: "inaccuracy", minDrop: 5 },
  { name: "good", minDrop: 2 },
  { name: "excellent", minDrop: 0 },
];

// A sound engine-best move that leaves a piece hanging for less material than it is worth.
function isBrilliantSacrifice(fenBefore, move) {
  if (!move || move.piece === "p" || move.piece === "k") return false;
  const board = new Chess(fenBefore);
  let played;
  try {
    played = board.move({ from: move.from, to: move.to, promotion: move.promotion });
  } catch {
    return false;
  }
  if (!played) return false;
  const them = played.color === "w" ? "b" : "w";
  if (!board.isAttacked(played.to, them)) return false;
  const gave = PIECE_VALUE[played.piece] || 0;
  const took = played.captured ? PIECE_VALUE[played.captured] || 0 : 0;
  return gave > took;
}

let currentRun = 0;
const cache = new Map();

function analysisDepthOf(value) {
  const depth = Number(value);
  return ANALYSIS_DEPTHS.includes(depth) ? depth : 12;
}

function analysisTimeout(depth) {
  return 20000 + Math.max(0, depth - 12) * 8000;
}

// Lichess scores are from White's side. The local engine scores from the side to move.
async function searchCloud(fen) {
  const res = await fetch(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=1`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const pv = data?.pvs?.[0];
  if (!pv) return null;
  const moves = String(pv.moves || "").trim().split(/\s+/).filter(Boolean);
  const sign = fen.split(" ")[1] === "b" ? -1 : 1;
  return {
    depth: data.depth || 0,
    cp: pv.cp == null ? null : pv.cp * sign,
    mate: pv.mate == null ? null : pv.mate * sign,
    bestmove: moves[0] || null,
    pv: moves,
  };
}

function searchLocal(fen, depth) {
  const command = `go depth ${depth}`;
  const timeout = analysisTimeout(depth);
  const run = () => engineSearch(fen, command, { kind: "analysis", timeout });
  return run().catch((err) => {
    if (String(err?.message || "").includes("replaced")) throw err;
    return run();
  });
}

// Centipawns from White's point of view, with mates mapped to large values.
function whiteCp(result, turn) {
  const sign = turn === "w" ? 1 : -1;
  if (result.mate != null) {
    if (result.mate === 0) return -sign * MATE_CP;
    return sign * Math.sign(result.mate) * (MATE_CP - Math.abs(result.mate) * 10);
  }
  return sign * (result.cp ?? 0);
}

const winChance = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
const moveAccuracy = (drop) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

function sanOf(fen, uci) {
  if (!uci || uci === "(none)") return null;
  try {
    const board = new Chess(fen);
    return board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
}

async function evaluatePosition(fen, board, search) {
  const turn = board.turn();
  if (board.isCheckmate()) return { cp: turn === "w" ? -MATE_CP : MATE_CP, bestmove: null, mate: null, matedSide: turn };
  if (board.isDraw() || board.isStalemate()) return { cp: 0, bestmove: null, mate: null };
  const res = await search(fen);
  const mate = res.mate != null && res.mate !== 0 ? res.mate * (turn === "w" ? 1 : -1) : null;
  return { cp: whiteCp(res, turn), bestmove: res.bestmove, mate, pv: res.pv || [] };
}

// Piece placement + side to move: what the page's board can be matched on.
const positionKey = (fen) => fen.split(" ").slice(0, 2).join(" ");

async function analyze({ gameId, moveList, finished, players, engineId, depth: requestedDepth, fresh }, onProgress) {
  const depth = analysisDepthOf(requestedDepth);
  const engine = engineId === "lichess-cloud" || engineId === "stockfish-deep" || engineId === "stockfish-lite"
    ? engineId
    : "stockfish-lite";
  const key = `v5:${gameId}:${moveList.length}:${engine}:${depth}`;
  if (finished && !fresh && cache.has(key)) return cache.get(key);

  async function search(fen) {
    if (engine === "lichess-cloud") {
      try {
        const cloud = await searchCloud(fen);
        if (cloud && cloud.depth >= depth) return cloud;
      } catch {
        // A missing cloud position is searched locally at the selected depth.
      }
    }
    return searchLocal(fen, depth);
  }

  const run = ++currentRun;
  beginAnalysis();
  try {
  const board = new Chess();
  const positions = [{ fen: board.fen(), legal: board.moves().length }];
  const moves = [];
  for (const mv of decodeTcn(moveList)) {
    const color = board.turn();
    const played = board.move(mv);
    moves.push({
      san: played.san,
      uci: played.from + played.to + (played.promotion || ""),
      color,
      from: played.from,
      to: played.to,
      piece: played.piece,
      promotion: played.promotion,
    });
    positions.push({ fen: board.fen(), legal: board.moves().length });
  }
  if (!moves.length) throw new Error("No moves to analyze yet.");

  const evals = [];
  const replay = new Chess();
  for (let i = 0; i < positions.length; i++) {
    if (run !== currentRun) throw new Error("Analysis was replaced by a newer request.");
    if (i > 0) replay.move(moves[i - 1].san);
    evals.push(await evaluatePosition(positions[i].fen, replay, search));
    onProgress(i + 1, positions.length);
  }

  const sides = { w: { drops: [], counts: {} }, b: { drops: [], counts: {} } };
  const plies = moves.map((m, i) => {
    const before = winChance(evals[i].cp);
    const after = winChance(evals[i + 1].cp);
    const drop = Math.max(0, m.color === "w" ? before - after : after - before);
    const forced = positions[i].legal === 1;
    const bestUci = evals[i].bestmove && evals[i].bestmove !== "(none)" ? evals[i].bestmove : null;
    const isBest = forced || m.uci === bestUci;
    const moverCp = m.color === "w" ? evals[i].cp : -evals[i].cp;
    let cls;
    if (isBest && drop < 2 && moverCp < 700 && isBrilliantSacrifice(positions[i].fen, m)) cls = "brilliant";
    else if (isBest) cls = "best";
    else cls = CLASSES.find((c) => drop >= c.minDrop)?.name || "good";
    const side = sides[m.color];
    side.drops.push(drop);
    side.counts[cls] = (side.counts[cls] || 0) + 1;
    return {
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      color: m.color,
      san: m.san,
      uci: m.uci,
      fen: positions[i].fen,
      bestUci: cls === "best" || cls === "brilliant" ? null : bestUci,
      afterKey: positionKey(positions[i + 1].fen),
      cls,
      drop: Math.round(drop * 10) / 10,
      best: cls === "best" || cls === "brilliant" ? null : sanOf(positions[i].fen, bestUci),
      evalBefore: evals[i].cp,
      evalAfter: evals[i + 1].cp,
      line: legalContinuation(positions[i].fen, evals[i].pv, bestUci),
    };
  });

  const summary = (c) => {
    const drops = sides[c].drops;
    const accuracy = drops.length ? drops.reduce((s, d) => s + moveAccuracy(d), 0) / drops.length : 100;
    return { ...players[c], accuracy: Math.round(accuracy * 10) / 10, counts: sides[c].counts };
  };

  const result = {
    ok: true,
    gameId,
    finished,
    engineId: engine,
    depth,
    white: summary("w"),
    black: summary("b"),
    evals: evals.map((e) => e.cp),
    positions: evals.map((e, i) => ({
      key: positionKey(positions[i].fen),
      bestmove: e.bestmove && e.bestmove !== "(none)" ? e.bestmove : null,
      bestSan: sanOf(positions[i].fen, e.bestmove),
      cp: Math.abs(e.cp) >= MATE_CP - 1000 ? null : e.cp,
      mate: e.mate,
      matedSide: e.matedSide || null,
    })),
    plies,
    insights: {
      w: buildInsights(plies, "w"),
      b: buildInsights(plies, "b"),
    },
  };
  if (finished) cache.set(key, result);
  return result;
  } finally {
    endAnalysis();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "analyze") return false;
  const progress = (done, total) =>
    chrome.runtime.sendMessage({ type: "analysisProgress", tabId: msg.tabId, done, total }).catch(() => {});
  analyze(msg.game, progress)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
