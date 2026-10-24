// Runs on chess.com/friends and reports friend usernames to the background worker.
// Used as a fallback when the friends API can't be reached.
(() => {
  const EXCLUDE = "header, nav, footer, [class*='nav-bar'], [class*='navbar']";
  const MEMBER_RE = /\/member\/([A-Za-z0-9_-]+)/i;
  const SKIP = new Set(["help", "membership", "settings", "login", "blogs", "stats", "games", "friends", "home"]);

  function collect() {
    const names = new Set();
    for (const a of document.querySelectorAll("a[href*='/member/']")) {
      if (a.closest(EXCLUDE)) continue;
      try {
        const m = new URL(a.href, location.origin).pathname.match(MEMBER_RE);
        const name = m?.[1];
        if (name && !SKIP.has(name.toLowerCase())) names.add(name);
      } catch {
        // bad href
      }
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
