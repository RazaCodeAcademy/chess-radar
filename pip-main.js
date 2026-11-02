// MAIN-world helper: receive PiP drag events from the extension bridge and
// re-dispatch them on the page document where Chess.com listens.
(() => {
  if (window.__cfnPipMain) return;
  window.__cfnPipMain = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== "cfn-pip-drag") return;

    const {
      eventType,
      clientX,
      clientY,
      screenX,
      screenY,
      button,
      buttons,
      ctrlKey,
      shiftKey,
      altKey,
      metaKey,
      pointerId,
      pointerType,
      isPrimary,
    } = data;

    try {
      let evt;
      if (String(eventType).startsWith("pointer")) {
        evt = new PointerEvent(eventType, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          screenX,
          screenY,
          button,
          buttons,
          ctrlKey,
          shiftKey,
          altKey,
          metaKey,
          pointerId: pointerId || 1,
          pointerType: pointerType || "mouse",
          isPrimary: isPrimary !== false,
        });
      } else {
        evt = new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          screenX,
          screenY,
          button,
          buttons,
          ctrlKey,
          shiftKey,
          altKey,
          metaKey,
        });
      }
      Object.defineProperty(evt, "__cfnPipBridge", { value: true });
      document.dispatchEvent(evt);
    } catch {
      // ignore
    }
  });
})();
