import type { Plugin } from "@opencode-ai/plugin";

export const KanbanHooks: Plugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await $`/Users/vekomarnitskiy/.local/bin/kanban-hook-session-start`;
      }

      // ближайший аналог "Stop" зависит от того, что именно ты считаешь стопом
      if (event.type === "session.idle") {
        await $`/Users/vekomarnitskiy/.local/bin/kanban-hook-stop`;
      }
    },
  };
};
