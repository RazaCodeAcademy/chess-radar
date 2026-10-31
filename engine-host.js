// One Stockfish worker for the whole offscreen page.
// The lite build reserves 128 MB as soon as it starts. A second worker (live eval
// plus a full-game review) grows past what this page can hold and the engine
// aborts with "RuntimeError: unreachable", which leaves the review waiting forever.

const STALE = { stale: true, bestmove: null, cp: null, mate: null, pv: null, depth: 0 };

let worker = null;
let generation = 0;
let ready = null;
let readyResolve = null;
let readyReject = null;
let current = null;
let queued = null;
let booting = false;
let analysisLock = 0;

function blank() {
  return { cp: null, mate: null, pv: null, depth: 0 };
}

function timeoutFor(search) {
  const ms = Number(String(search || "").match(/movetime (\d+)/)?.[1] || 1000);
  return ms + 4000;
}

function spawn() {
  if (worker) return ready;
  const gen = ++generation;
  worker = new Worker(new URL("./engine/stockfish-19-lite-single.js", import.meta.url));
  ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  worker.onmessage = (e) => {
    if (gen !== generation) return;
    onLine(typeof e.data === "string" ? e.data : "");
  };
  worker.onerror = (e) => {
    if (gen !== generation) return;
    e.preventDefault();
    failAll(new Error("Stockfish crashed. Start the review again."));
  };
  worker.postMessage("uci");
  return ready;
}

function stopEngine() {
  try {
    worker?.postMessage("stop");
  } catch {
    // The worker is already gone; failAll handles the waiting search.
  }
}

function failAll(err) {
  const jobs = [current, queued].filter(Boolean);
  const rejectReady = readyReject;
  current = null;
  queued = null;
  booting = false;
  const dead = worker;
  worker = null;
  ready = null;
  readyResolve = null;
  readyReject = null;
  generation += 1;
  try {
    dead?.terminate();
  } catch {
    // Already stopped.
  }
  rejectReady?.(err);
  for (const job of jobs) {
    clearTimeout(job.timer);
    job.reject(err);
  }
}

function onLine(line) {
  if (line === "uciok") {
    worker.postMessage("setoption name Threads value 1");
    worker.postMessage("setoption name Hash value 16");
    worker.postMessage("isready");
  } else if (line === "readyok") {
    readyResolve();
  } else if (line.startsWith("info") && current && line.includes(" score ") && !line.includes("bound")) {
    const multipv = line.match(/ multipv (\d+)/);
    if (multipv && multipv[1] !== "1") return;
    const cp = line.match(/ score cp (-?\d+)/);
    const mate = line.match(/ score mate (-?\d+)/);
    const pv = line.match(/ pv (.+)$/);
    current.info = {
      depth: Number(line.match(/ depth (\d+)/)?.[1] || 0),
      cp: cp ? Number(cp[1]) : null,
      mate: mate ? Number(mate[1]) : null,
      pv: pv ? pv[1].trim().split(/\s+/) : current.info.pv || null,
    };
  } else if (line.startsWith("bestmove") && current) {
    const job = current;
    current = null;
    clearTimeout(job.timer);
    const info = job.info || blank();
    job.resolve({ ...info, bestmove: line.split(/\s+/)[1] || null });
    pump();
  }
}

function arm(job) {
  job.info = blank();
  job.timer = setTimeout(() => {
    if (current !== job) return;
    failAll(new Error("Stockfish timed out on this position."));
  }, job.timeout);
  worker.postMessage(`position fen ${job.fen}`);
  worker.postMessage(job.search);
}

function launch(job) {
  booting = true;
  const pending = spawn();
  const gen = generation;
  pending
    .then(() => {
      booting = false;
      if (gen !== generation || !worker) {
        job.reject(new Error("Stockfish crashed. Start the review again."));
        pump();
        return;
      }
      current = job;
      arm(job);
    })
    .catch((err) => {
      booting = false;
      if (current === job) current = null;
      job.reject(err);
      pump();
    });
}

function pump() {
  if (current || booting || !queued) return;
  const job = queued;
  queued = null;
  launch(job);
}

function settleQueued(job) {
  clearTimeout(job.timer);
  if (job.kind === "analysis") job.reject(new Error("Analysis was replaced by a newer request."));
  else job.resolve(STALE);
}

export function beginAnalysis() {
  analysisLock += 1;
}

export function endAnalysis() {
  analysisLock = Math.max(0, analysisLock - 1);
}

// kind "analysis" is never interrupted by the eval bar. Live searches replace each other.
export function engineSearch(fen, search, opts = {}) {
  const kind = opts.kind === "analysis" ? "analysis" : "live";
  if (kind === "live" && analysisLock) return Promise.resolve(STALE);
  const timeout = opts.timeout || timeoutFor(search);
  return new Promise((resolve, reject) => {
    const job = { fen, search, kind, timeout, resolve, reject, info: blank(), timer: 0 };
    if (current || booting) {
      if (queued) settleQueued(queued);
      queued = job;
      if (current?.kind === "live") stopEngine();
      return;
    }
    launch(job);
  });
}
