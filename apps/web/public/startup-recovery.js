// This runs before the application entry, so a failed module can still show recovery.
(() => {
  const reloadKey = "mill:entry-reload";
  let recovering = false;

  function entryScript(document) {
    return document.querySelector('script[type="module"][src]');
  }

  function showRecovery() {
    const root = document.getElementById("root");
    if (!root || root.dataset.millEntryStarted || root.hasChildNodes()) return;

    const main = document.createElement("main");
    main.className = "startup-recovery";
    const mark = document.createElement("img");
    mark.src = "/brand/mill-favicon.png";
    mark.alt = "";
    mark.width = 64;
    mark.height = 64;
    const heading = document.createElement("h1");
    heading.textContent = "Mill could not start";
    const message = document.createElement("p");
    message.textContent = "Reload Mill to continue.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Reload Mill";
    retry.addEventListener("click", () => window.location.reload());
    main.append(mark, heading, message, retry);
    // The entry failed, so the shared React toast provider is not available yet.
    const notification = document.createElement("aside");
    notification.setAttribute("role", "alert");
    notification.setAttribute("data-slot", "toast");
    notification.className = "startup-toast";
    Object.assign(notification.style, {
      position: "fixed",
      left: "50%",
      transform: "translateX(-50%)",
      bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
      maxWidth: "calc(100vw - 32px)",
      width: "460px",
      boxSizing: "border-box",
      padding: "16px",
      display: "flex",
      alignItems: "start",
      gap: "12px",
      borderRadius: "16px",
      background: "var(--surface, #fff)",
      color: "var(--foreground, #29221d)",
      border: "1px solid var(--danger, #c62f35)",
      boxShadow: "0 4px 20px #0002",
      font: "14px/20px system-ui, sans-serif",
      zIndex: "2147483647",
    });
    const failure = document.createElement("span");
    failure.textContent =
      "The application did not load. Check your connection and reload this page.";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.setAttribute("data-slot", "toast-close");
    Object.assign(dismiss.style, {
      flexShrink: "0",
      width: "32px",
      height: "32px",
      border: "0",
      borderRadius: "8px",
      background: "transparent",
      color: "inherit",
      fontSize: "24px",
      cursor: "pointer",
    });
    dismiss.addEventListener("click", () => notification.remove());
    notification.append(failure, dismiss);
    root.replaceChildren(main, notification);
    document.title = "Mill could not start · Mill";
  }

  async function recover() {
    if (recovering || document.getElementById("root")?.dataset.millEntryStarted)
      return;
    recovering = true;
    showRecovery();

    const entry = entryScript(document)?.src;
    if (!entry) return;
    try {
      if (window.sessionStorage.getItem(reloadKey) === entry) return;
      const response = await fetch(window.location.href, {
        cache: "no-store",
        headers: { Accept: "text/html" },
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/html")
      )
        return;
      const page = new window.DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      const source = entryScript(page)?.getAttribute("src");
      if (!source) return;
      const nextEntry = new URL(source, window.location.href);
      if (
        nextEntry.origin !== window.location.origin ||
        nextEntry.href === entry
      )
        return;
      window.sessionStorage.setItem(reloadKey, entry);
      window.location.reload();
    } catch {
      // The recovery view remains available when the network is unavailable.
    }
  }

  window.addEventListener(
    "error",
    (event) => {
      if (event.target === entryScript(document)) void recover();
    },
    true,
  );
  window.setTimeout(() => {
    const root = document.getElementById("root");
    if (root && !root.dataset.millEntryStarted && !root.hasChildNodes())
      void recover();
  }, 15000);
})();
