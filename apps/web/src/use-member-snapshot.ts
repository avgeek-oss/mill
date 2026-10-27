import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Member } from "../../../packages/contracts/src/index.js";

export function useMemberSnapshot(
  prepared?: PromiseSettledResult<Member[] | undefined>,
) {
  const [members, updateMembers] = useState<Member[]>([]);
  const generation = useRef(0);
  const adopted = useRef<typeof prepared>(undefined);
  useLayoutEffect(() => {
    if (!prepared || adopted.current === prepared) return;
    adopted.current = prepared;
    ++generation.current;
    updateMembers(
      prepared.status === "fulfilled" ? (prepared.value ?? []) : [],
    );
  }, [prepared]);
  const setMembers = useCallback((next: Member[]) => {
    ++generation.current;
    updateMembers(next);
  }, []);
  const beginRefresh = useCallback(() => {
    const request = ++generation.current;
    return (next: Member[]) => {
      if (request !== generation.current) return false;
      updateMembers(next);
      return true;
    };
  }, []);
  return {
    members:
      prepared?.status === "fulfilled" && adopted.current !== prepared
        ? (prepared.value ?? [])
        : members,
    setMembers,
    beginRefresh,
  };
}
