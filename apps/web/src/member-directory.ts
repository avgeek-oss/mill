import type { Member } from "../../../packages/contracts/src/index.js";
import { ApiError, api, isResponseObject } from "./api.js";

export async function loadMemberDirectory() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const members = new Map<string, Member>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const query = new URLSearchParams({ limit: "1000" });
        if (cursor) query.set("cursor", cursor);
        const page = await api<{
          items: Member[];
          hasMore: boolean;
          nextCursor: string | null;
        }>(`/auth/members?${query}`, undefined, "GET", {
          validateResponse: (value) =>
            isResponseObject(value) &&
            Array.isArray(value.items) &&
            typeof value.hasMore === "boolean" &&
            (value.hasMore
              ? typeof value.nextCursor === "string" && !!value.nextCursor
              : value.nextCursor === null),
        });
        for (const member of page.items) members.set(member.id, member);
        cursor = page.nextCursor;
        if (cursor) {
          if (cursors.has(cursor))
            throw new Error(
              "The people list could not be completed. Try again.",
            );
          cursors.add(cursor);
        }
      } while (cursor);
      return [...members.values()];
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409 && attempt < 2))
        throw cause;
    }
  }
  throw new Error("The people list could not be completed. Try again.");
}
