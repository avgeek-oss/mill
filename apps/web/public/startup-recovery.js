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
    message.textContent =
      "The application did not load. Check your connection and reload this page.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Reload Mill";
    retry.addEventListener("click", () => window.location.reload());
    main.append(mark, heading, message, retry);
    root.replaceChildren(main);
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
