import { createRoot } from "react-dom/client";
import { RouterProvider, Toast } from "@mill/web-design-system";
import "@mill/web-design-system/styles/globals.css";
import "./styles.css";
import { App, ErrorBoundary } from "./app.js";
import { navigate } from "./api.js";
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <RouterProvider navigate={navigate}>
      <App />
      <Toast.Provider placement="bottom end" />
    </RouterProvider>
  </ErrorBoundary>,
);
