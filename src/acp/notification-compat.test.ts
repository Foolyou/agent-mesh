import { expect, test } from "bun:test";
import "./notification-compat";
import { sessionNotificationSchema } from "@zed-industries/agent-client-protocol";

test("ACP session/update parser accepts codex tool_call_update rawOutput strings", () => {
  const parsed = sessionNotificationSchema.parse({
    sessionId: "s1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: "plain command output\n",
    },
  });

  expect(parsed.update).toMatchObject({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    rawOutput: "plain command output\n",
  });
});

test("ACP session/update parser accepts newer usage and config-option notifications", () => {
  expect(
    sessionNotificationSchema.parse({
      sessionId: "s1",
      update: {
        sessionUpdate: "usage_update",
        inputTokens: 10,
        outputTokens: 4,
      },
    }).update,
  ).toMatchObject({ sessionUpdate: "usage_update", inputTokens: 10, outputTokens: 4 });

  expect(
    sessionNotificationSchema.parse({
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        option: {
          category: "model",
          currentValue: "gpt-5.4",
          options: [{ value: "gpt-5.4", name: "GPT 5.4" }],
        },
      },
    }).update,
  ).toMatchObject({ sessionUpdate: "config_option_update" });
});
