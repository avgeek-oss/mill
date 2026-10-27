import { createRoot } from "react-dom/client";
import { RouterProvider, Toast, Providers } from "@mill/web-design-system";
import "./styles.css";
import { App } from "./app.js";
import { ErrorBoundary } from "./error-boundary.js";
import { navigate } from "./api.js";
import { trackFrontendLoadErrors } from "./frontend-load.js";
import { FormFeedback } from "./form-feedback.js";
trackFrontendLoadErrors();
const root = document.getElementById("root")!;
root.dataset.millEntryStarted = "true";
createRoot(root).render(
  <Providers>
    <RouterProvider navigate={navigate}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      <FormFeedback />
      <Toast.Provider placement="bottom" />
    </RouterProvider>
  </Providers>,
);
