// Decoder for chess.com's compact "TCN" move list (two characters per move).
const TCN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=";
const PROMO_PIECES = "qnrbkp";

function square(index) {
  return TCN_CHARS[index % 8] + (Math.floor(index / 8) + 1);
}

export function decodeTcn(tcn) {
  const moves = [];
  for (let i = 0; i + 1 < tcn.length; i += 2) {
    const from = TCN_CHARS.indexOf(tcn[i]);
    let to = TCN_CHARS.indexOf(tcn[i + 1]);
    let promotion;
    if (to > 63) {
      promotion = PROMO_PIECES[Math.floor((to - 64) / 3)];
      to = from + (from < 16 ? -8 : 8) + ((to - 1) % 3) - 1;
    }
    if (from > 75) continue; // piece drops (variants) are not supported
    moves.push({ from: square(from), to: square(to), ...(promotion ? { promotion } : {}) });
  }
  return moves;
}
