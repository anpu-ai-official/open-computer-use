#!/usr/bin/env node
import { createInterface } from "node:readline";

const rpc = createInterface({ input: process.stdin });
rpc.on("line", line => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-native", version: "1" } });
    return;
  }
  if (message.method !== "tools/call") {
    reply(message.id, {});
    return;
  }
  const { name, arguments: args } = message.params;
  if (name === "get_window_state") {
    reply(message.id, tool({
      pid: args.pid,
      window_id: args.window_id,
      snapshot_id: "s0000002a",
      element_count: 1,
      elements: [{ element_index: 7, element_token: "s0000002a:7", label: "Commit", role: "button", actions: ["click"] }],
      tree_markdown: "- [7] button Commit",
    }));
    return;
  }
  if (name === "click") {
    const exact = args.pid === 41 && args.window_id === 99 && args.snapshot_id === "s0000002a" && args.element_index === 7 && args.element_token == null;
    reply(message.id, exact ? tool({ status: "ok", route: "accessibility" }) : tool({ status: "refused", received: args }, true));
    return;
  }
  reply(message.id, tool({ status: "ok", name }));
});

function tool(structuredContent, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError };
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
