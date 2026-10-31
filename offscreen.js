import { engineSearch } from "./engine-host.js";

const SEARCH = "go depth 16 movetime 1200";

function evaluate(fen, search) {
  return engineSearch(fen, search || SEARCH, { kind: "live" }).then((raw) => {
    if (!raw || raw.stale) return { ok: false, stale: true, fen };
    const sign = fen.split(" ")[1] === "b" ? -1 : 1;
    return {
      ok: true,
      fen,
      bestmove: raw.bestmove,
      depth: raw.depth || 0,
      pv: raw.pv?.[0] || null,
      cp: raw.cp == null ? null : raw.cp * sign,
      mate: raw.mate == null ? null : raw.mate * sign,
      matedSide: raw.mate === 0 ? fen.split(" ")[1] : null,
    };
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "evaluate") return false;
  evaluate(msg.fen, msg.search).then(sendResponse, (err) =>
    sendResponse({ ok: false, fen: msg.fen, error: err?.message || "Stockfish failed." })
  );
  return true;
});
