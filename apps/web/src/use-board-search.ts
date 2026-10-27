import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { boardUrl, parseBoardUrl } from "./board-url.js";

export function publishBoardSearch(boardId: string, query: string) {
  if (window.location.pathname !== `/boards/${boardId}`) return;
  const current = `${window.location.pathname}${window.location.search}`;
  const next = boardUrl(
    boardId,
    { ...parseBoardUrl(current), q: query, page: 1 },
    window.location.search,
  );
  if (next === current) return;
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new Event("mill:navigate"));
}

export function useBoardSearch({
  path,
  urlQuery,
  onSearch,
}: {
  path: string;
  urlQuery: string;
  onSearch: (query: string) => void;
}) {
  const [draft, setDraft] = useState({ value: urlQuery, generation: 0 });
  const editGeneration = useRef(0);
  const publishedGeneration = useRef(0);
  const preparations = useRef(new Map<string, number>());
  const latestPreparation = useRef<{ path: string; generation: number } | null>(
    null,
  );
  const publishing = useRef(false);
  const setQuery = useCallback((value: string) => {
    const generation = ++editGeneration.current;
    setDraft({ value, generation });
  }, []);
  const prepare = useCallback((destination: string) => {
    preparations.current.set(destination, editGeneration.current);
    latestPreparation.current = {
      path: destination,
      generation: editGeneration.current,
    };
  }, []);

  useLayoutEffect(() => {
    const preparedGeneration =
      preparations.current.get(path) ?? editGeneration.current;
    preparations.current.clear();
    if (latestPreparation.current?.path === path)
      latestPreparation.current = null;
    if (editGeneration.current !== preparedGeneration) return;
    publishedGeneration.current = editGeneration.current;
    setDraft((current) =>
      current.value === urlQuery ? current : { ...current, value: urlQuery },
    );
  }, [path, urlQuery]);

  const restoreHistory = useEffectEvent(() => {
    if (
      window.location.pathname !==
      new URL(path, window.location.origin).pathname
    )
      return;
    const requested = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const generation = ++editGeneration.current;
    publishedGeneration.current = generation;
    latestPreparation.current = { path: requested, generation };
    setDraft({
      value: parseBoardUrl(
        `${window.location.pathname}${window.location.search}`,
      ).q,
      generation,
    });
  });
  useEffect(() => {
    window.addEventListener("popstate", restoreHistory);
    return () => window.removeEventListener("popstate", restoreHistory);
  }, []);

  const restoreClientNavigation = useEffectEvent(() => {
    if (publishing.current) return;
    const requested = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (requested !== path) return;
    latestPreparation.current = null;
    const generation = ++editGeneration.current;
    publishedGeneration.current = generation;
    setDraft({ value: urlQuery, generation });
  });
  useEffect(() => {
    window.addEventListener("mill:navigate", restoreClientNavigation);
    return () =>
      window.removeEventListener("mill:navigate", restoreClientNavigation);
  }, []);

  const publish = useEffectEvent((value: string) => {
    publishing.current = true;
    try {
      onSearch(value);
    } finally {
      publishing.current = false;
    }
  });
  useEffect(() => {
    if (
      draft.value === urlQuery &&
      draft.generation === publishedGeneration.current
    )
      return;
    const timer = setTimeout(() => {
      if (draft.generation !== editGeneration.current) return;
      if (
        latestPreparation.current &&
        latestPreparation.current.path !== path &&
        latestPreparation.current.generation === draft.generation
      )
        return;
      publishedGeneration.current = draft.generation;
      publish(draft.value);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, path, urlQuery]);

  return { query: draft.value, setQuery, prepare };
}
