export function loadTaskPage() {
  return import("./task-page.js").then((module) => ({
    default: module.TaskPage,
  }));
}

export function preloadTaskPage() {
  // Navigation owns error recovery if this optional preload fails.
  void loadTaskPage().catch(() => undefined);
}
