const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let host = null;

export function hideCorrectMove() {
  host?.remove();
  host = null;
}

export function showCorrectMove({ move = "" } = {}) {
  hideCorrectMove();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const headline = move ? esc(move) : "Correct";
  const label = move ? `Correct. ${move}` : "Correct.";
  host = document.createElement("div");
  host.className = reduced ? "correct-pop is-still" : "correct-pop";
  host.innerHTML = `
    <div class="correct-card" role="status" aria-live="polite" aria-label="${esc(label)}">
      <div class="correct-mark" aria-hidden="true">
        <span class="correct-glow"></span>
        <svg class="correct-check" viewBox="0 0 52 52">
          <path class="correct-tick" d="M14 27.5 L22.5 36 L38 18" />
        </svg>
      </div>
      <p class="correct-kicker">Correct</p>
      <h2>${headline}</h2>
    </div>`;
  document.body.append(host);
}
