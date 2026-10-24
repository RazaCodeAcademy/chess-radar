function pageRequest(msgType, resultType, payload, sendResponse) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let done = false;
  const finish = (users) => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMsg);
    sendResponse({ users });
  };
  const onMsg = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== resultType || data.id !== id) return;
    finish(Array.isArray(data.users) ? data.users : []);
  };
  window.addEventListener("message", onMsg);
  window.postMessage({ type: msgType, id, ...payload }, "*");
  setTimeout(() => finish([]), 4500);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "cfnPageSearch") {
    pageRequest("cfn-search", "cfn-search-result", { query: msg.query, me: msg.me || "" }, sendResponse);
    return true;
  }
  if (msg.type === "cfnPageFriends") {
    pageRequest("cfn-friends", "cfn-friends-result", { me: msg.me || "" }, sendResponse);
    return true;
  }
  return false;
});
