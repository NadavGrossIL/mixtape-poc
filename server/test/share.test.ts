// Dismissing the share sheet is not a copy; a share that can't happen
// becomes a copy; nothing here ever throws at the button.

import test from "node:test";
import assert from "node:assert";
import { shareOrCopy } from "../../client/src/share.ts";

const URL = "https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd";
const TITLE = "late-night drive";

// A clipboard is what it holds; a copy pushes to it.
function fakeClipboard() {
  const clipboard = { written: [] as string[] };
  const copy = async (text: string) => {
    clipboard.written.push(text);
  };
  return { clipboard, copy };
}

test("without a native share sheet the link is copied", async () => {
  const { clipboard, copy } = fakeClipboard();
  const outcome = await shareOrCopy({ title: TITLE, url: URL }, { copy });
  assert.strictEqual(outcome, "copied");
  assert.deepStrictEqual(clipboard.written, [URL]);
});

test("with a native share sheet the link is shared, not copied", async () => {
  const { clipboard, copy } = fakeClipboard();
  const share = async () => {};
  const outcome = await shareOrCopy({ title: TITLE, url: URL }, { share, copy });
  assert.strictEqual(outcome, "shared");
  assert.deepStrictEqual(clipboard.written, []);
});

// A share sheet that rejects the way the browser does: a named DOMException-like error.
function refusingShare(name: string) {
  return async () => {
    const err = new Error(`share refused: ${name}`);
    err.name = name;
    throw err;
  };
}

test("closing the share sheet is not a copy", async () => {
  const { clipboard, copy } = fakeClipboard();
  const share = refusingShare("AbortError");
  const outcome = await shareOrCopy({ title: TITLE, url: URL }, { share, copy });
  assert.strictEqual(outcome, "dismissed");
  assert.deepStrictEqual(clipboard.written, []);
});

test("a share sheet that refuses the payload falls back to copying the link", async () => {
  const { clipboard, copy } = fakeClipboard();
  const share = async () => {
    throw new TypeError("payload not shareable");
  };
  const outcome = await shareOrCopy({ title: TITLE, url: URL }, { share, copy });
  assert.strictEqual(outcome, "copied");
  assert.deepStrictEqual(clipboard.written, [URL]);
});

const refusingCopy = async () => {
  throw new Error("clipboard refused");
};

test("without a share sheet a refused clipboard reports failure instead of throwing", async () => {
  await assert.doesNotReject(async () => {
    const outcome = await shareOrCopy({ title: TITLE, url: URL }, { copy: refusingCopy });
    assert.strictEqual(outcome, "failed");
  });
});

test("when both the share sheet and the clipboard refuse, the outcome is failed", async () => {
  const share = async () => {
    throw new TypeError("payload not shareable");
  };
  await assert.doesNotReject(async () => {
    const outcome = await shareOrCopy({ title: TITLE, url: URL }, { share, copy: refusingCopy });
    assert.strictEqual(outcome, "failed");
  });
});

test("the share sheet receives exactly the title and the url", async () => {
  const { copy } = fakeClipboard();
  let received: unknown = null;
  const share = async (d: { title: string; url: string }) => {
    received = d;
  };
  await shareOrCopy({ title: TITLE, url: URL }, { share, copy });
  assert.deepStrictEqual(received, { title: TITLE, url: URL });
});
