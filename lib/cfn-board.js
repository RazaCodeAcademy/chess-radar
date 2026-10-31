// Interactive training board for the extension puzzle page (vanilla DOM + chess.js).
// Piece art: SVG files in /pieces (pawn, knight, bishop, rook, queen, king × w/b).
import { Chess } from "./chess.js";

const FILES = "abcdefgh";
const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PIECE_SRC = (color, type) => `pieces/${PIECE_NAME[type] || "pawn"}-${color === "b" ? "b" : "w"}.svg`;

function sqToXY(square, orientation) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  const x = orientation === "b" ? 7 - file : file;
  const y = orientation === "b" ? rank : 7 - rank;
  return { x, y };
}

function xyToSq(x, y, orientation) {
  const file = orientation === "b" ? 7 - x : x;
  const rank = orientation === "b" ? y : 7 - y;
  return FILES[file] + (rank + 1);
}

export class CfnBoard {
  constructor(host, options = {}) {
    this.host = host;
    this.game = new Chess();
    this.orientation = options.orientation === "b" ? "b" : "w";
    this.onMove = options.onMove || (() => {});
    this.interactive = options.interactive !== false;
    this.selected = null;
    this.legal = [];
    this.lastMove = null;
    this.marks = { good: [], bad: [], hint: [], arrow: null };
    this.drag = null;
    this.root = document.createElement("div");
    this.root.className = "cfn-board";
    this.host.append(this.root);
    this.root.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.root.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.root.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.root.addEventListener("pointercancel", () => this.endDrag());
    this.render();
  }

  loadFen(fen, { lastMove = null } = {}) {
    this.game.load(fen);
    this.selected = null;
    this.legal = [];
    this.lastMove = lastMove;
    this.marks = { good: [], bad: [], hint: [], arrow: null };
    this.render();
  }

  setOrientation(color) {
    this.orientation = color === "b" ? "b" : "w";
    this.render();
  }

  setInteractive(on) {
    this.interactive = !!on;
  }

  setMarks(marks) {
    this.marks = { good: [], bad: [], hint: [], arrow: null, ...marks };
    this.render();
  }

  fen() {
    return this.game.fen();
  }

  turn() {
    return this.game.turn();
  }

  tryMove(from, to, promotion) {
    const moves = this.game.moves({ square: from, verbose: true });
    const needsPromo = moves.some((m) => m.to === to && m.promotion);
    let promo = promotion;
    if (needsPromo && !promo) promo = "q";
    const played = this.game.move({ from, to, promotion: promo || undefined });
    if (!played) return null;
    this.lastMove = { from: played.from, to: played.to };
    this.selected = null;
    this.legal = [];
    this.render();
    return played;
  }

  squareAtPoint(clientX, clientY) {
    const rect = this.root.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return xyToSq(x, y, this.orientation);
  }

  onPointerDown(e) {
    if (!this.interactive || e.button !== 0) return;
    const sq = this.squareAtPoint(e.clientX, e.clientY);
    if (!sq) return;
    const piece = this.game.get(sq);
    if (this.selected && this.legal.includes(sq)) {
      this.commitMove(this.selected, sq);
      return;
    }
    if (piece && piece.color === this.game.turn()) {
      this.selected = sq;
      this.legal = this.game.moves({ square: sq, verbose: true }).map((m) => m.to);
      this.drag = { from: sq, pointerId: e.pointerId };
      this.root.setPointerCapture?.(e.pointerId);
      this.render();
      return;
    }
    this.selected = null;
    this.legal = [];
    this.render();
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const ghost = this.root.querySelector(".cfn-piece.dragging");
    if (!ghost) return;
    const rect = this.root.getBoundingClientRect();
    ghost.style.left = `${((e.clientX - rect.left) / rect.width) * 100}%`;
    ghost.style.top = `${((e.clientY - rect.top) / rect.height) * 100}%`;
  }

  onPointerUp(e) {
    if (!this.drag) return;
    const from = this.drag.from;
    const to = this.squareAtPoint(e.clientX, e.clientY);
    this.endDrag();
    if (to && to !== from && this.legal.includes(to)) this.commitMove(from, to);
    else this.render();
  }

  endDrag() {
    this.drag = null;
  }

  commitMove(from, to) {
    const moves = this.game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!moves.length) return;
    let promotion;
    if (moves.some((m) => m.promotion)) {
      promotion = window.prompt("Promote to (q/r/b/n)", "q") || "q";
      if (!"qrbn".includes(promotion)) promotion = "q";
    }
    const before = this.game.fen();
    const played = this.tryMove(from, to, promotion);
    if (!played) {
      this.game.load(before);
      this.render();
      return;
    }
    this.onMove({
      from: played.from,
      to: played.to,
      promotion: played.promotion || "",
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion || ""}`.toLowerCase(),
      fen: this.game.fen(),
    });
  }

  render() {
    let checkSq = null;
    if (this.game.isCheck()) {
      for (const row of this.game.board()) {
        for (const piece of row) {
          if (piece && piece.type === "k" && piece.color === this.game.turn()) checkSq = piece.square;
        }
      }
    }
    const squares = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const sq = xyToSq(x, y, this.orientation);
        const light = (x + y) % 2 === 0;
        const classes = ["cfn-sq", light ? "light" : "dark"];
        if (this.selected === sq) classes.push("selected");
        if (this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) classes.push("last");
        if (checkSq === sq) classes.push("check");
        if (this.marks.good.includes(sq)) classes.push("good");
        if (this.marks.bad.includes(sq)) classes.push("bad");
        if (this.marks.hint.includes(sq)) classes.push("hint");
        if (this.legal.includes(sq)) classes.push(this.game.get(sq) ? "capture" : "move");
        const fileLabel = y === 7 ? (this.orientation === "w" ? FILES[x] : FILES[7 - x]) : "";
        const rankLabel = x === 0 ? (this.orientation === "w" ? String(8 - y) : String(y + 1)) : "";
        squares.push(
          `<div class="${classes.join(" ")}" data-sq="${sq}" style="grid-column:${x + 1};grid-row:${y + 1}">` +
            `${fileLabel ? `<span class="coord file">${fileLabel}</span>` : ""}` +
            `${rankLabel ? `<span class="coord rank">${rankLabel}</span>` : ""}` +
            `</div>`
        );
      }
    }
    const pieces = [];
    for (const row of this.game.board()) {
      for (const piece of row) {
        if (!piece) continue;
        const { x, y } = sqToXY(piece.square, this.orientation);
        const dragging = this.drag?.from === piece.square;
        const src = PIECE_SRC(piece.color, piece.type);
        pieces.push(
          `<div class="cfn-piece${dragging ? " dragging" : ""}" data-sq="${piece.square}" style="left:${(x + 0.5) * 12.5}%;top:${(y + 0.5) * 12.5}%"><img src="${src}" alt="" draggable="false" /></div>`
        );
      }
    }
    let arrow = "";
    if (this.marks.arrow?.from && this.marks.arrow?.to) {
      const a = sqToXY(this.marks.arrow.from, this.orientation);
      const b = sqToXY(this.marks.arrow.to, this.orientation);
      const x1 = (a.x + 0.5) * 12.5;
      const y1 = (a.y + 0.5) * 12.5;
      const x2 = (b.x + 0.5) * 12.5;
      const y2 = (b.y + 0.5) * 12.5;
      arrow = `<svg class="cfn-arrow" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><marker id="cfn-ah" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill="#c084fc"/></marker></defs><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#c084fc" stroke-width="2.2" marker-end="url(#cfn-ah)" opacity="0.9"/></svg>`;
    }
    this.root.innerHTML = `<div class="cfn-grid">${squares.join("")}</div>${arrow}<div class="cfn-pieces">${pieces.join("")}</div>`;
  }
}
