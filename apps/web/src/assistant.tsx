import { defineClientTool, useAgentChat } from "@avgeek-oss/agent-react";
import {
  AgentChat,
  type AgentConversationSummary,
} from "@avgeek-oss/design-system/patterns/agent-chat/agent-chat";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { toast } from "@mill/web-design-system";
import { navigate } from "./api.js";
import { apiOrigin } from "./runtime-config.js";

const assistantFetch: typeof fetch = (input, init) =>
  fetch(`${apiOrigin()}${String(input)}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
  });

function relativeTime(iso: string) {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.round(minutes / 1440)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function Assistant({
  onClose,
  onRefresh,
  boards,
}: {
  onClose: () => void;
  onRefresh: () => void;
  boards: readonly { id: string; name: string }[];
}) {
  const clientTools = useMemo(
    () => [
      defineClientTool({
        name: "open_board",
        description: "Show a board the user has access to.",
        input: z.object({ boardId: z.uuid() }),
        run: ({ boardId }) => {
          navigate(`/boards/${boardId}`);
          return "Board opened.";
        },
      }),
      defineClientTool({
        name: "open_task",
        description: "Show a task on its board.",
        input: z.object({ boardId: z.uuid(), taskId: z.uuid() }),
        run: ({ boardId, taskId }) => {
          navigate(`/boards/${boardId}/tasks/${taskId}`);
          return "Task opened.";
        },
      }),
      defineClientTool({
        name: "refresh_page_data",
        description:
          "Refresh the current board, task, member and notification data after a change.",
        input: z.object({}),
        run: () => {
          onRefresh();
          return "Page data refreshed.";
        },
      }),
    ],
    [onRefresh],
  );
  const chat = useAgentChat({
    endpoint: "/agent",
    fetch: assistantFetch,
    clientTools,
  });
  const displayedItems = useMemo(
    () =>
      chat.state.items.map((item) => {
        if (
          item.type !== "tool_call" ||
          !item.input ||
          typeof item.input !== "object" ||
          Array.isArray(item.input)
        )
          return item;
        const input = Object.fromEntries(
          Object.entries(item.input).flatMap(([key, value]) => {
            if (key === "idempotencyKey") return [];
            if (key === "boardId" && typeof value === "string") {
              const board = boards.find((candidate) => candidate.id === value);
              if (board) return [["board", board.name]];
            }
            return [[key, value]];
          }),
        );
        return { ...item, input };
      }),
    [chat.state.items, boards],
  );
  const approvedCalls = useRef(new Set<string>());
  useEffect(() => {
    for (const item of chat.state.items) {
      if (
        item.type !== "tool_call" ||
        item.status === "pending" ||
        !approvedCalls.current.delete(item.id)
      )
        continue;
      if (item.status === "succeeded") onRefresh();
    }
  }, [chat.state.items, onRefresh]);
  const [conversations, setConversations] = useState<
    AgentConversationSummary[]
  >([]);
  const historyErrorShown = useRef(false);
  const { listConversations } = chat;
  const refreshConversations = useCallback(() => {
    listConversations()
      .then((list) => {
        historyErrorShown.current = false;
        setConversations(
          list.map((item) => ({
            id: item.id,
            title: item.title,
            time: relativeTime(item.updatedAt),
            dateTime: item.updatedAt,
          })),
        );
      })
      .catch(() => {
        if (historyErrorShown.current) return;
        historyErrorShown.current = true;
        toast.danger("Could not load assistant conversations. Try again.");
      });
  }, [listConversations]);
  const { status } = chat.state;
  useEffect(() => {
    if (status === "idle") refreshConversations();
  }, [status, refreshConversations]);
  return (
    <AgentChat
      productName="Mill"
      items={displayedItems}
      pending={chat.state.pending}
      status={chat.state.status}
      error={chat.state.error}
      thinking={chat.state.thinking}
      onSend={(value) => void chat.send(value)}
      onDecide={(toolUseId, approved) => {
        if (approved) approvedCalls.current.add(toolUseId);
        chat.decide(toolUseId, approved);
      }}
      onStop={chat.stop}
      onNewConversation={() => {
        approvedCalls.current.clear();
        chat.reset();
      }}
      onClose={onClose}
      suggestions={[
        "What needs my attention?",
        "Find tasks due this week",
        "Show me the latest comments on this board",
      ]}
      emptyDescription="Ask about boards, tasks and comments, or make a change with your approval."
      conversations={conversations}
      activeConversationId={chat.state.conversationId}
      onSelectConversation={(id) => {
        approvedCalls.current.clear();
        void chat.load(id);
      }}
      onDeleteConversation={async (id) => {
        await chat.deleteConversation(id);
        refreshConversations();
      }}
    />
  );
}
