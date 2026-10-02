import { createRoot } from "react-dom/client";
import { RouterProvider, Toast } from "@mill/web-design-system";
import "@mill/web-design-system/styles/globals.css";
import "./styles.css";
import { App, ErrorBoundary } from "./app.js";
import { navigate } from "./api.js";
import { trackFrontendLoadErrors } from "./frontend-load.js";
trackFrontendLoadErrors();
const root = document.getElementById("root")!;
root.dataset.millEntryStarted = "true";
createRoot(root).render(
  <ErrorBoundary>
    <RouterProvider navigate={navigate}>
      <App />
      <Toast.Provider placement="bottom end" />
    </RouterProvider>
  </ErrorBoundary>,
);
