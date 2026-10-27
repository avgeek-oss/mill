import React, { Component, type ReactNode } from "react";
import { ErrorPage } from "./error-page.js";
import {
  isFrontendLoadError,
  reloadOutdatedFrontend,
} from "./frontend-load.js";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; loadFailed: boolean }
> {
  state = { failed: false, loadFailed: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, loadFailed: isFrontendLoadError(error) };
  }
  componentDidCatch(error: unknown) {
    if (isFrontendLoadError(error)) void reloadOutdatedFrontend();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return this.state.loadFailed ? (
      <ErrorPage
        documentNavigation
        code="Load error"
        title="Unable to open this page"
        description="This page could not finish loading. Reload to try again. If you had an unfinished edit, check it before continuing."
      />
    ) : (
      <ErrorPage documentNavigation />
    );
  }
}
