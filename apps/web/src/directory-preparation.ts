import { useLayoutEffect, useRef } from "react";
import { loadBoardSummaries } from "./board-directory.js";
import { loadMemberDirectory } from "./member-directory.js";
import { usePageRead } from "./page-navigation.js";

export function useDirectoryPreparation(
  scope: string,
  path: string,
  withMembers: boolean,
  enabled: boolean,
) {
  const committed = useRef<{ scope: string; path: string } | null>(null);
  const reuse =
    committed.current?.scope === scope &&
    committed.current.path === path &&
    /^\/boards\/[^/]+\/?$/.test(path);
  const prepared = usePageRead(
    enabled && !reuse ? `${scope}:directories:${withMembers}` : null,
    (signal) =>
      Promise.allSettled([
        loadBoardSummaries(signal),
        withMembers ? loadMemberDirectory(signal) : Promise.resolve(undefined),
      ]),
  );
  useLayoutEffect(() => {
    if (
      prepared?.status === "fulfilled" &&
      prepared.value.every((read) => read.status === "fulfilled")
    )
      committed.current = { scope, path };
  }, [prepared, scope, path]);
  return {
    boards: prepared?.status === "fulfilled" ? prepared.value[0] : prepared,
    members: withMembers
      ? prepared?.status === "fulfilled"
        ? prepared.value[1]
        : prepared
      : undefined,
  };
}
