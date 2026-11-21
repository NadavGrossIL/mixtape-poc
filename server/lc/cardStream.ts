// Tracks appear one by one: read the delivery tool's arguments WHILE the
// model is still writing them.
//
// With streamMode "messages" LangChain hands over each small piece the model
// writes. For a tool call the pieces are `tool_call_chunks`:
//   - the first one carries the tool's `name` and its `index` (its position in
//     the model's message), with empty args;
//   - every later one carries only the same `index` and the next few
//     characters of the arguments (JSON text).
// So: when a chunk names our tool, start a buffer for that index; glue each
// later piece with that index onto it; after every piece ask curator.ts's
// brace matcher (extractCompleteTracks, 83 test cases) which track objects are
// complete now, and report the new ones. Same reader the hand-written loop
// uses on the raw Anthropic stream — only the source of the pieces differs.

import { extractCompleteTracks } from "../curator.ts";

type ToolCallChunk = { name?: string; args?: string; index?: number };

function makeCardStream(
  toolName: string,
  onItem: (index: number, item: any) => void,
  containerKey = "tracks"
) {
  let slot: number | undefined; // the index our tool call is being written at
  let open = false;
  let buf = "";
  let emitted = 0;
  return {
    push(chunks: ToolCallChunk[] | undefined | null) {
      for (const c of chunks ?? []) {
        if (c.name) {
          // A new tool call starts. Ours → fresh buffer (a card sent back by
          // the check is written again from track 1). Someone else's at our
          // index (a later message reuses indexes) → stop listening.
          if (c.name === toolName) {
            slot = c.index;
            open = true;
            buf = "";
            emitted = 0;
          } else if (c.index === slot) {
            open = false;
          }
        }
        if (!open || c.index !== slot || !c.args) continue;
        buf += c.args;
        const items = extractCompleteTracks(buf, containerKey);
        while (emitted < items.length) {
          onItem(emitted, items[emitted]);
          emitted++;
        }
      }
    },
  };
}

export type { ToolCallChunk };
export { makeCardStream };
