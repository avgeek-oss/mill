import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "**/dist/**",
      "node_modules/**",
      "tmp/**",
      "playwright-report/**",
      "test-results/**",
      "test-results-*/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@avgeek-oss/design-system",
              importNames: ["QueryError", "FieldError"],
              message:
                "Use Mill's toast-only QueryFeedback or FieldError, or report validation from the submit handler.",
            },
            {
              name: "@mill/web-design-system",
              importNames: ["QueryError"],
              message:
                "Use QueryFeedback to keep errors in toasts and retry actions in the page.",
            },
            {
              name: "@avgeek-oss/design-system/patterns/feedback/query-state",
              importNames: ["QueryError"],
              message:
                "Use QueryFeedback to keep errors in toasts and retry actions in the page.",
            },
            {
              name: "@avgeek-oss/design-system/forms/field",
              importNames: ["FieldError"],
              message:
                "Use Mill's toast-only FieldError or report validation from the submit handler.",
            },
          ],
        },
      ],
    },
  },
  {
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        FormData: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Event: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
