import { createRoot } from "react-dom/client";
import "@mill/web-design-system/styles/globals.css";
import "./styles.css";
import { App, ErrorBoundary } from "./app.js";
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
