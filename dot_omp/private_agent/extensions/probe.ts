import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("probe", {
    description: "test newSession",
    async handler(args, ctx) {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
        },
      });
    },
  });
}
