const loadErrors = new WeakSet<object>();
const recoveryKey = "mill:frontend-reload";

export function trackFrontendLoadErrors() {
  window.addEventListener("vite:preloadError", (event) => {
    const error = (event as Event & { payload?: unknown }).payload;
    if (
      error instanceof Error &&
      /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
        error.message,
      )
    )
      loadErrors.add(error);
  });
}

export function isFrontendLoadError(error: unknown) {
  return error !== null && typeof error === "object" && loadErrors.has(error);
}

export async function reloadOutdatedFrontend() {
  const entry = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  )?.src;
  if (!entry) return;

  try {
    if (sessionStorage.getItem(recoveryKey) === entry) return;
    const response = await fetch(window.location.href, {
      cache: "no-store",
      headers: { Accept: "text/html" },
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("text/html")
    )
      return;
    const page = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    const source = page
      .querySelector('script[type="module"][src]')
      ?.getAttribute("src");
    if (!source) return;
    const nextEntry = new URL(source, window.location.href);
    if (nextEntry.origin !== window.location.origin || nextEntry.href === entry)
      return;
    sessionStorage.setItem(recoveryKey, entry);
    window.location.reload();
  } catch {
    // The error screen remains available if recovery cannot reach the new build.
  }
}
