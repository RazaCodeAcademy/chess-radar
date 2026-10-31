import { Chess } from "./lib/chess.js";
import {
  OPENINGS,
  explainBookMove,
  mergeBooks,
  combineBooks,
  fromChessDb,
  classifyDeviation,
  scoreCp,
  moverLoss,
  gradeLoss,
  popularity,
  openingNameFor,
} from "./lib/theory-data.js";

const $ = (id) => document.getElementById(id);
const PIECE = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const FILES = "abcdefgh";

const state = {
  opening: null,
  line: [],
  ply: 0,
  chess: new Chess(),
  selected: "",
  last: null,
  marks: [],
  bookCache: new Map(),
  busy: false,
  wait: "",
  feedback: null,
  analysis: null,
};

$("filter").addEventListener("input", renderPicker);
$("backBtn").onclick = showPicker;
$("bookBtn").onclick = () => {
  if (state.chess.history().length > state.ply) {
    while (state.chess.history().length > state.ply) state.chess.undo();
    state.marks.length = state.chess.history().length;
    const prev = state.chess.history({ verbose: true }).at(-1);
    state.last = prev ? { from: prev.from, to: prev.to } : null;
    state.feedback = null;
    state.selected = "";
    renderLesson();
    return;
  }
  void playBookMove();
};
$("analyseBtn").onclick = () => analyse();
$("undoBtn").onclick = () => undo();
$("board").addEventListener("pointerdown", onBoardPointerDown);

renderPicker();

function renderPicker() {
  const q = $("filter").value.trim().toLowerCase();
  const list = $("openingList");
  list.replaceChildren();
  for (const opening of OPENINGS) {
    const hay = `${opening.name} ${opening.eco}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opening";
    const name = document.createElement("strong");
    name.textContent = opening.name;
    const eco = document.createElement("span");
    eco.textContent = opening.eco;
    btn.append(name, eco);
    btn.onclick = () => startLesson(opening);
    list.append(btn);
  }
}

function showPicker() {
  state.opening = null;
  $("picker").hidden = false;
  $("lesson").hidden = true;
  $("backBtn").hidden = true;
  $("title").textContent = "Opening theory";
}

async function startLesson(opening) {
  state.opening = opening;
  state.line = sansFor(opening.moves);
  state.ply = 0;
  state.chess = new Chess();
  state.selected = "";
  state.last = null;
  state.marks = [];
  state.feedback = null;
  state.analysis = null;
  state.bookCache = new Map();
  $("picker").hidden = true;
  $("lesson").hidden = false;
  $("backBtn").hidden = false;
  $("title").textContent = opening.name;
  $("eco").textContent = opening.eco;
  renderLesson();
  void attachStats(0);
}

function sansFor(ucis) {
  const chess = new Chess();
  return ucis.map((uci) => {
    const played = chess.move(parseUci(uci));
    return { uci, san: played?.san || uci, masters: 0, lichess: 0, white: 0, draws: 0, black: 0, opening: null };
  });
}

function parseUci(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" };
}

function renderLesson() {
  const step = state.line[state.ply];
  const offBook = state.chess.history().length > state.ply;
  const done = !step && !offBook;
  $("prompt").textContent = offBook
    ? "Off the main line"
    : done
      ? "Main line complete"
      : `Move ${Math.floor(state.ply / 2) + 1}${state.ply % 2 ? "…" : "."} ${step.san}`;
  $("explain").textContent = offBook
    ? "The note below says whether this is another opening or a move outside theory. Analyse still works from here."
    : done
      ? "You have played the main line. Analyse the position, or go back and try a different move."
      : explainBookMove(step, state.opening?.name);
  $("bookBtn").disabled = (done && !offBook) || state.busy;
  $("bookBtn").textContent = offBook ? "Return to the book move" : done ? "Line complete" : `Play ${step.san}`;
  $("undoBtn").disabled = state.ply === 0 || state.busy;
  $("status").textContent = state.busy ? state.wait || "Checking ChessDB and the Lichess opening books…" : "";
  renderFeedback();
  renderAnalysis();
  renderBoard();
}

function renderFeedback() {
  const box = $("feedback");
  box.replaceChildren();
  const info = state.feedback;
  if (!info) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = `feedback ${info.kind || ""}`;
  const title = document.createElement("strong");
  title.textContent = info.title;
  const text = document.createElement("p");
  text.textContent = info.text;
  box.append(title, text);
  if (info.learn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn primary learn-instead";
    btn.textContent = "Learn this opening instead";
    btn.onclick = () => learnInstead(info.learn);
    box.append(btn);
  }
}

function renderAnalysis() {
  const box = $("analysis");
  box.replaceChildren();
  const info = state.analysis;
  if (!info) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const title = document.createElement("strong");
  title.textContent = info.title;
  const text = document.createElement("p");
  text.textContent = info.text;
  box.append(title, text);
}

function renderBoard() {
  const board = $("board");
  board.replaceChildren();
  const legal = new Map();
  if (state.selected) {
    for (const move of state.chess.moves({ square: state.selected, verbose: true })) {
      if (!legal.has(move.to)) legal.set(move.to, move);
    }
  }
  const book = state.line[state.ply];
  const bookFrom = book ? book.uci.slice(0, 2) : "";
  const bookTo = book ? book.uci.slice(2, 4) : "";
  for (let rank = 8; rank >= 1; rank -= 1) {
    for (let file = 0; file < 8; file += 1) {
      const sq = FILES[file] + rank;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sq" + ((file + rank) % 2 === 1 ? " dark" : "");
      btn.setAttribute("aria-label", sq);
      const mark = moveMark();
      const tone = markTone(mark);
      if (tone && state.last && (sq === state.last.from || sq === state.last.to)) btn.classList.add(`grade-${tone}`);
      if (sq === state.selected) btn.classList.add("selected");
      else if (state.last && (sq === state.last.from || sq === state.last.to) && !tone) btn.classList.add("last");
      else if (!state.selected && (sq === bookFrom || sq === bookTo)) btn.classList.add("book");
      const piece = state.chess.get(sq);
      if (legal.has(sq) && sq !== state.selected) btn.classList.add(piece ? "capture" : "dest");
      if (piece) btn.append(pieceImage(piece));
      if (mark && state.last && sq === state.last.to) btn.append(moveBadge(mark));
      board.append(btn);
    }
  }
}

let drag = null;

function legalMovesFrom(square) {
  const map = new Map();
  for (const move of state.chess.moves({ square, verbose: true })) {
    if (!map.has(move.to)) map.set(move.to, move);
  }
  return map;
}

function squareFromPoint(x, y, ignore) {
  if (ignore) ignore.hidden = true;
  const el = document.elementFromPoint(x, y);
  if (ignore) ignore.hidden = false;
  const btn = el?.closest?.(".sq");
  const board = $("board");
  return btn && board.contains(btn) ? btn.getAttribute("aria-label") : "";
}

function onBoardPointerDown(event) {
  if (state.busy || event.button !== 0) return;
  const board = $("board");
  const btn = event.target.closest(".sq");
  if (!btn || !board.contains(btn)) return;
  const sq = btn.getAttribute("aria-label");
  const piece = state.chess.get(sq);
  const turn = state.chess.turn();
  if (!(piece && piece.color === turn)) {
    if (state.selected) {
      const legal = legalMovesFrom(state.selected);
      if (legal.has(sq)) {
        void playUserMove(legal.get(sq));
        return;
      }
    }
    state.selected = "";
    renderBoard();
    return;
  }
  const wasSelected = state.selected === sq;
  state.selected = sq;
  renderBoard();
  drag = {
    from: sq,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    moved: false,
    wasSelected,
    ghost: null,
    origin: board.querySelector(`[aria-label="${sq}"] img`),
  };
  document.addEventListener("pointermove", onBoardPointerMove);
  document.addEventListener("pointerup", onBoardPointerUp);
  document.addEventListener("pointercancel", onBoardPointerUp);
  event.preventDefault();
}

function onBoardPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
  drag.moved = true;
  if (!drag.ghost && drag.origin) {
    const rect = drag.origin.getBoundingClientRect();
    const ghost = drag.origin.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.origin.style.opacity = "0.28";
  }
  if (drag.ghost) {
    drag.ghost.style.left = `${event.clientX - drag.ghost.offsetWidth / 2}px`;
    drag.ghost.style.top = `${event.clientY - drag.ghost.offsetHeight / 2}px`;
  }
  const board = $("board");
  board.querySelectorAll(".sq.hover").forEach((el) => el.classList.remove("hover"));
  const over = squareFromPoint(event.clientX, event.clientY, drag.ghost);
  if (over && legalMovesFrom(drag.from).has(over)) {
    board.querySelector(`[aria-label="${over}"]`)?.classList.add("hover");
  }
}

function onBoardPointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const current = drag;
  drag = null;
  document.removeEventListener("pointermove", onBoardPointerMove);
  document.removeEventListener("pointerup", onBoardPointerUp);
  document.removeEventListener("pointercancel", onBoardPointerUp);
  const over = current.moved ? squareFromPoint(event.clientX, event.clientY, current.ghost) : "";
  current.ghost?.remove();
  $("board").querySelectorAll(".sq.hover").forEach((el) => el.classList.remove("hover"));
  if (!current.moved) {
    if (current.wasSelected) {
      state.selected = "";
      renderBoard();
    }
    return;
  }
  const move = legalMovesFrom(current.from).get(over);
  if (move) {
    void playUserMove(move);
    return;
  }
  renderBoard();
}

async function playBookMove() {
  const step = state.line[state.ply];
  if (!step || state.busy) return;
  playOnBoard(step.uci);
  setMoveMark("book");
  state.feedback = { kind: "book", title: "Book move", text: `${step.san} stays in the main line.` };
  state.ply += 1;
  state.selected = "";
  renderLesson();
  if (state.ply >= state.line.length) await extendLine();
  else void attachStats(state.ply);
}

async function playUserMove(move) {
  if (state.feedback?.learn) {
    const pending = state.feedback.learn;
    state.feedback = null;
    await adoptLine(pending);
  }
  const uci = move.from + move.to + (move.promotion || "");
  const expected = state.line[state.ply];
  if (expected && uci === expected.uci) {
    await playBookMove();
    return;
  }
  const before = state.chess.fen();
  const color = state.chess.turn();
  const played = state.chess.move(move);
  if (!played) return;
  state.last = { from: move.from, to: move.to };
  state.selected = "";
  state.busy = true;
  state.wait = "Checking the opening books…";
  state.feedback = null;
  renderLesson();
  const play = state.line.slice(0, state.ply).map((step) => step.uci);
  try {
    let book = { moves: [], opening: null };
    try {
      book = await fetchBook(play);
    } catch {
      book = { moves: [], opening: null };
    }
    const verdict = classifyDeviation({
      playedUci: uci,
      book,
      lessonName: state.opening?.name || "",
      mainUci: expected?.uci || "",
    });
    if (verdict.kind === "variation") {
      setMoveMark("variation");
      state.feedback = {
        kind: "variation",
        title: "Another variation",
        text: `${played.san} is book theory, but it is ${verdict.name}${verdict.eco ? ` (${verdict.eco})` : ""}, not ${state.opening?.name || "this line"}.`,
        learn: { name: verdict.name, eco: verdict.eco, uci, san: played.san },
      };
    } else {
      state.wait = "Grading the move…";
      renderLesson();
      const grade = await gradePlayedMove(before, state.chess.fen(), color);
      setMoveMark(markTone(grade.id) ? grade.id : "");
      const bookName = expected?.san ? ` The main line was ${expected.san}.` : "";
      state.feedback = {
        kind: grade.id,
        title: grade.label,
        text: `${played.san} is not a known opening move.${grade.detail}${bookName}`,
      };
    }
  } finally {
    state.busy = false;
    state.wait = "";
    renderLesson();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function gradePlayedMove(beforeFen, afterFen, color) {
  try {
    const before = await withTimeout(chrome.runtime.sendMessage({ type: "evaluate", fen: beforeFen }), 12000);
    const after = await withTimeout(chrome.runtime.sendMessage({ type: "evaluate", fen: afterFen }), 12000);
    const loss = moverLoss(scoreCp(before), scoreCp(after), color);
    const grade = gradeLoss(loss);
    const pawn = loss == null ? "" : ` The position changed by about ${(Math.max(0, loss) / 100).toFixed(1)} pawns.`;
    const engine = before?.engineName ? ` ${before.engineName} graded it.` : "";
    return { ...grade, detail: pawn + engine };
  } catch {
    return { id: "unknown", label: "Not theory", detail: " The engine could not grade this move." };
  }
}

async function learnInstead(info) {
  await adoptLine(info);
  state.feedback = { kind: "book", title: info.name, text: "This variation is now the line. The next book move will load below." };
  state.analysis = null;
  renderLesson();
}

async function adoptLine(info) {
  const history = state.chess.history({ verbose: true });
  state.opening = {
    id: "variation",
    name: info.name,
    eco: info.eco || "",
    moves: history.map((m) => m.from + m.to + (m.promotion || "")),
  };
  state.line = history.map((m) => ({
    uci: m.from + m.to + (m.promotion || ""),
    san: m.san,
    masters: 0,
    lichess: 0,
    white: 0,
    draws: 0,
    black: 0,
    opening: { eco: info.eco || "", name: info.name },
  }));
  state.ply = state.line.length;
  $("title").textContent = info.name;
  $("eco").textContent = info.eco || "";
  await extendLine();
}

async function extendLine() {
  if (state.line.length >= 18) return;
  state.busy = true;
  state.wait = "Checking the opening books…";
  renderLesson();
  try {
    const book = await fetchBook(state.line.map((step) => step.uci));
    const next = book.moves[0];
    if (next && popularity(next) >= 40) {
      const probe = new Chess(state.chess.fen());
      const played = probe.move(parseUci(next.uci));
      if (played) {
        state.line.push({
          uci: next.uci,
          san: played.san,
          masters: next.masters,
          lichess: next.lichess,
          white: next.white,
          draws: next.draws,
          black: next.black,
          opening: next.opening || book.opening,
        });
      }
    }
  } catch {
    // The known moves still teach without the extra book data.
  } finally {
    state.busy = false;
    state.wait = "";
    renderLesson();
  }
}

async function attachStats(index) {
  const step = state.line[index];
  if (!step || step.masters || step.lichess) return;
  try {
    const book = await fetchBook(state.line.slice(0, index).map((row) => row.uci));
    const found = book.moves.find((row) => row.uci === step.uci);
    if (!found || state.line[index] !== step) return;
    Object.assign(step, {
      san: found.san || step.san,
      masters: found.masters,
      lichess: found.lichess,
      white: found.white,
      draws: found.draws,
      black: found.black,
      rank: found.rank || 0,
      score: found.score || 0,
      note: found.note || "",
      opening: found.opening || book.opening || step.opening,
    });
    if (state.ply === index) renderLesson();
  } catch {
    // Stats are optional; the move is still shown.
  }
}

let openingCatalog = null;

async function loadOpeningCatalog() {
  if (openingCatalog) return openingCatalog;
  const files = ["a", "b", "c", "d", "e"];
  const texts = await Promise.all(
    files.map(async (file) => {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/lichess-org/chess-openings/master/${file}.tsv`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return "";
        return res.text();
      } catch {
        return "";
      }
    })
  );
  openingCatalog = [];
  for (const text of texts) {
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const [eco, name, pgn] = line.split("\t");
      if (eco && name && pgn) openingCatalog.push({ eco, name, pgn });
    }
  }
  return openingCatalog;
}

async function fetchBook(moves) {
  const key = moves.join(",");
  if (state.bookCache.has(key)) return state.bookCache.get(key);
  const chess = new Chess();
  for (const uci of moves) chess.move(parseUci(uci));
  const fen = chess.fen();
  const play = moves.length ? `&play=${moves.join(",")}` : "";
  const [chessdb, masters, lichess, catalog] = await Promise.all([
    readJson(`https://www.chessdb.cn/cdb.php?action=queryall&json=1&board=${encodeURIComponent(fen)}`, fromChessDb),
    readJson(`https://explorer.lichess.org/masters?moves=12&topGames=0${play}`, (data) => mergeBooks(data, { moves: [] })),
    readJson(
      `https://explorer.lichess.org/lichess?variant=standard&speeds=blitz,rapid,classical&ratings=1800,2000,2200,2500&moves=12&topGames=0${play}`,
      (data) => mergeBooks({ moves: [] }, data)
    ),
    loadOpeningCatalog().catch(() => []),
  ]);
  const book = combineBooks([chessdb, masters, lichess].filter(Boolean));
  const sans = chess.history();
  const named = openingNameFor(catalog, sans);
  if (named) book.opening = named;
  for (const move of book.moves) {
    if (move.opening?.name) continue;
    if (!move.san) continue;
    const child = openingNameFor(catalog, [...sans, move.san]);
    if (child) move.opening = child;
  }
  state.bookCache.set(key, book);
  return book;
}

async function readJson(url, map) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return map(await res.json());
  } catch {
    return null;
  }
}

const MOVE_MARKS = {
  book: { tone: "good", label: "Book", icon: "book" },
  variation: { tone: "good", label: "Book variation", icon: "branch" },
  best: { tone: "good", label: "Best", icon: "star" },
  excellent: { tone: "good", label: "Excellent", icon: "bang" },
  good: { tone: "good", label: "Good", icon: "check" },
  inaccuracy: { tone: "warn", label: "Inaccuracy", icon: "inacc" },
  mistake: { tone: "warn", label: "Mistake", icon: "question" },
  blunder: { tone: "bad", label: "Blunder", icon: "blunder" },
};

const BADGE_ICONS = {
  book: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2.5 2.2h4.2A3.4 3.4 0 0 1 9.2 3v10.2A3.2 3.2 0 0 0 6.7 12.4H2.5V2.2zm11 0H9.3v9.2c.7.4 1.5.6 2.4.6h1.8V2.2z"/></svg>',
  branch: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.2a1.6 1.6 0 1 1-1.2 2.6v4.4a1.6 1.6 0 1 0 1.2 0V8.2c1.3.1 2.2.7 3 1.6.8.9 1.6 1.4 3.2 1.5V9.8a1.6 1.6 0 1 1 1.2 0v2.2a2.6 2.6 0 0 1-1.2.2c-1.3-.1-1.9-.6-2.6-1.4-.8-.9-1.8-1.6-3.6-1.7V5.8A1.6 1.6 0 0 1 5 3.2z"/></svg>',
  star: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m8 1.6 1.7 3.6 3.9.5-2.9 2.7.7 3.9L8 10.4 4.6 12.3l.7-3.9L2.4 5.7l3.9-.5L8 1.6z"/></svg>',
  bang: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.1 1.5h1.7l-.5 8H6.6l-.5-8zm.8 9.4a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zm3.2-9.4h1.7l-.5 8H10.6l-.5-8zm.8 9.4a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.3 11.4 2.8 7.9l1.2-1.2 2.3 2.3 5.7-5.7 1.2 1.2-6.9 6.9z"/></svg>',
  inacc: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.2 1.4h1.5L7.3 8H6.6L6.2 1.4zM6.9 9.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3.3-.7c.5-.7 1.3-1.1 2.3-1.1 1.6 0 2.6 1 2.6 2.5 0 1.2-.6 2-1.6 2.7l-.6.4v.2h-2.1v-.8h1.2c.5-.3.9-.7.9-1.3 0-.6-.4-1-1-1-.5 0-.8.2-1.1.6l-.6-.8z"/></svg>',
  question: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.2 4.4C5.5 3 6.6 2.1 8.2 2.1c1.8 0 3 1.1 3 2.6 0 1.2-.6 2-1.7 2.6l-.6.3v1.2H7.2V7.6c0-.2.1-.4.4-.5l.8-.4c.6-.3.9-.7.9-1.3 0-.7-.5-1.2-1.3-1.2-.8 0-1.3.4-1.4 1.2H5.2zm2.2 6.3a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z"/></svg>',
  blunder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.4 1.6h1.5L6 6.2 7.1 1.6h1.5L7.2 7.4h2.2v1.3H6.8l-.8 5.7H4.5l.8-5.7H3.2V7.4h2.4L3.4 1.6zm7.4 0h1.5L11.2 6h2.2v1.3h-2.6l-.7 5.1h-1.5l.8-5.1H7.8V6h2.2l1.2-4.4z"/></svg>',
};

function pieceImage(piece) {
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.src = `pieces/${PIECE[piece.type]}-${piece.color}.svg`;
  return img;
}

function moveBadge(id) {
  const meta = MOVE_MARKS[id];
  if (!meta) return document.createElement("span");
  const badge = document.createElement("span");
  badge.className = `move-badge tone-${meta.tone}`;
  badge.title = meta.label;
  badge.innerHTML = BADGE_ICONS[meta.icon] || "";
  return badge;
}

function markTone(id) {
  return MOVE_MARKS[id]?.tone || "";
}

function moveMark() {
  const index = state.chess.history().length - 1;
  return index >= 0 ? state.marks[index] || "" : "";
}

function setMoveMark(mark) {
  const index = state.chess.history().length - 1;
  if (index < 0) return;
  state.marks[index] = mark;
  state.marks.length = index + 1;
}

function playOnBoard(uci) {
  const played = state.chess.move(parseUci(uci));
  if (!played) return;
  state.last = { from: played.from, to: played.to };
}

function undo() {
  if (!state.chess.history().length) return;
  state.chess.undo();
  state.marks.length = state.chess.history().length;
  const prev = state.chess.history({ verbose: true }).at(-1);
  state.last = prev ? { from: prev.from, to: prev.to } : null;
  state.ply = Math.max(0, Math.min(state.ply, state.chess.history().length));
  if (state.ply > state.line.length) state.ply = state.line.length;
  // If the undone move was a deviation, ply stays at the book index.
  if (state.chess.history().length < state.ply) state.ply = state.chess.history().length;
  state.selected = "";
  state.feedback = null;
  state.analysis = null;
  renderLesson();
}

async function analyse() {
  $("analyseBtn").disabled = true;
  state.analysis = { title: "Analysing…", text: "Asking the engine selected in Settings." };
  renderAnalysis();
  try {
    const res = await chrome.runtime.sendMessage({ type: "evaluate", fen: state.chess.fen() });
    if (!res?.ok) throw new Error(res?.error || "no engine");
    const cp = scoreCp(res);
    const text = formatEval(res, cp);
    state.analysis = { title: res.engineName || "Engine", text };
  } catch {
    state.analysis = { title: "Engine unavailable", text: "Choose an engine in Settings, or try again when you are online." };
  }
  $("analyseBtn").disabled = false;
  renderAnalysis();
}

function formatEval(res, cp) {
  const who = res.fallback ? `${res.engineName} (cloud had no position, so the local engine answered)` : res.engineName || "Engine";
  let score = "an unclear score";
  if (res.mate != null) score = `mate in ${Math.abs(res.mate)}`;
  else if (cp != null) score = `${cp > 0 ? "+" : ""}${(cp / 100).toFixed(2)} for White`;
  const best = res.bestmove ? ` Best move ${uciToSan(state.chess.fen(), res.bestmove)}.` : "";
  return `${who}, depth ${res.depth || "?"}. Evaluation ${score}.${best}`;
}

function uciToSan(fen, uci) {
  try {
    const chess = new Chess(fen);
    const played = chess.move(parseUci(uci));
    return played?.san || uci;
  } catch {
    return uci;
  }
}
