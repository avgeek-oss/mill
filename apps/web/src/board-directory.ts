import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "../../../packages/contracts/src/index.js";
import { api, ApiError, errorText, isResponseObject } from "./api.js";

type DirectoryPage = {
  items: Board[];
  hasMore: boolean;
  nextCursor: string | null;
};
export function compareBoardNames(a: Board, b: Board) {
  const first = a.name.toLowerCase();
  const second = b.name.toLowerCase();
  return (
    (first < second ? -1 : first > second ? 1 : 0) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    a.id.localeCompare(b.id)
  );
}
type DirectoryState = {
  key: string | null;
  boards: Board[];
  pending: boolean;
  error: string;
};
function validDirectoryPage(value: unknown) {
  return (
    isResponseObject(value) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        isResponseObject(item) &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.name === "string" &&
        typeof item.version === "number" &&
        Number.isInteger(item.version),
    ) &&
    typeof value.hasMore === "boolean" &&
    (value.hasMore
      ? typeof value.nextCursor === "string" && value.nextCursor.length > 0
      : value.nextCursor === null)
  );
}
export function useBoardDirectory(requestKey: string | null = "agents") {
  const generation = useRef(0);
  const [state, setState] = useState<DirectoryState>({
    key: requestKey,
    boards: [],
    pending: Boolean(requestKey),
    error: "",
  });
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setState({
      key: requestKey,
      boards: [],
      pending: Boolean(requestKey),
      error: "",
    });
    if (!requestKey) return;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const directory = new Map<string, Board>();
          const cursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const path: string = `/boards?directory=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
            const page: DirectoryPage = await api(path, undefined, "GET", {
              validateResponse: validDirectoryPage,
            });
            if (current !== generation.current) return;
            for (const board of page.items) {
              const existing = directory.get(board.id);
              if (!existing || board.version > existing.version)
                directory.set(board.id, board);
            }
            cursor = page.nextCursor;
            if (cursor) {
              if (cursors.has(cursor))
                throw new Error(
                  "The board directory could not be completed. Try again.",
                );
              cursors.add(cursor);
            }
          } while (cursor);
          if (current === generation.current)
            setState({
              key: requestKey,
              boards: [...directory.values()].sort(compareBoardNames),
              pending: false,
              error: "",
            });
          return;
        } catch (cause) {
          if (!(
            cause instanceof ApiError &&
            cause.status === 409 &&
            attempt < 2
          ))
            throw cause;
          if (current !== generation.current) return;
        }
      }
    } catch (cause) {
      if (current === generation.current)
        setState({
          key: requestKey,
          boards: [],
          pending: false,
          error: errorText(cause),
        });
    }
  }, [requestKey]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  const current =
    state.key === requestKey
      ? state
      : { boards: [], pending: Boolean(requestKey), error: "" };
  return {
    boards: current.boards,
    pending: current.pending,
    error: current.error,
    reload,
  };
}
