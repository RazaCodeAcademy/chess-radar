// Runs on chess.com/friends and reports friend usernames to the background worker.
// Used as a fallback when the friends API can't be reached.
(() => {
  const EXCLUDE = "header, nav, footer, [class*='sidebar'], [class*='nav-'], [id*='sidebar']";
  const MEMBER_RE = /\/member\/([A-Za-z0-9_-]+)\/?$/;

  function collect() {
    const names = new Set();
    for (const a of document.querySelectorAll("a[href*='/member/']")) {
      if (a.closest(EXCLUDE)) continue;
      const m = new URL(a.href, location.origin).pathname.match(MEMBER_RE);
      if (m) names.add(m[1]);
    }
    if (names.size) {
      chrome.runtime.sendMessage({ type: "scrapedFriends", usernames: [...names] });
    }
  }

  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(collect, 1000);
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
