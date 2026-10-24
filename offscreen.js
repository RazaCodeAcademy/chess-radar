const SEARCH = "go depth 16 movetime 1200";

const engine = new Worker("engine/stockfish-19-lite-single.js");
const post = (cmd) => engine.postMessage(cmd);

let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
let current = null;
let queued = null;

engine.onmessage = (e) => {
  const line = typeof e.data === "string" ? e.data : "";
  if (line === "uciok") post("isready");
  else if (line === "readyok") readyResolve();
  else if (line.startsWith("info") && current) parseInfo(line);
  else if (line.startsWith("bestmove") && current) {
    const job = current;
    current = null;
    job.resolve({ ok: true, fen: job.fen, bestmove: line.split(" ")[1], ...job.result });
    if (queued) {
      const next = queued;
      queued = null;
      start(next);
    }
  }
};

post("uci");

function parseInfo(line) {
  if (!line.includes(" score ") || line.includes("bound")) return;
  const multipv = line.match(/ multipv (\d+)/);
  if (multipv && multipv[1] !== "1") return;
  const depth = Number(line.match(/ depth (\d+)/)?.[1] || 0);
  const cp = line.match(/ score cp (-?\d+)/);
  const mate = line.match(/ score mate (-?\d+)/);
  // Stockfish reports from the side to move; convert to White's point of view.
  const sign = current.fen.split(" ")[1] === "b" ? -1 : 1;
  current.result = {
    depth,
    pv: line.match(/ pv (\S+)/)?.[1] || null,
    cp: cp ? Number(cp[1]) * sign : null,
    mate: mate ? Number(mate[1]) * sign : null,
    matedSide: mate && Number(mate[1]) === 0 ? current.fen.split(" ")[1] : null,
  };
}

async function start(job) {
  await ready;
  current = job;
  post(`position fen ${job.fen}`);
  post(SEARCH);
}

function evaluate(fen) {
  return new Promise((resolve) => {
    const job = { fen, resolve, result: {} };
    if (current) {
      if (queued) queued.resolve({ ok: false, stale: true, fen: queued.fen });
      queued = job;
      post("stop");
    } else {
      start(job);
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "evaluate") return false;
  evaluate(msg.fen).then(sendResponse);
  return true;
});
