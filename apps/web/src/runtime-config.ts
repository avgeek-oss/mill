declare global {
  interface Window {
    __MILL_RUNTIME_CONFIG__?: { apiOrigin: string };
  }
}

export function apiOrigin() {
  const configured = window.__MILL_RUNTIME_CONFIG__?.apiOrigin;
  if (!configured) throw new Error("Mill API origin is unavailable");
  return configured;
}

export function apiUrl(path: string) {
  return `${apiOrigin()}${path === "/api" || path.startsWith("/api/") ? path : `/api${path}`}`;
}
