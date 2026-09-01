// The cross-site guard on the paid POSTs: a request with somebody else's
// Origin must be refused, and a request with no Origin at all (curl, the
// hermes client, a same-origin navigation) must still get through — those two
// properties pull in opposite directions, and both have to hold.

import test from "node:test";
import assert from "node:assert";
import {
  originAllowed,
  normalizeOrigin,
  allowedOriginsFromUrls,
  isRemoteUrl,
} from "../httpOrigin.ts";

const DEPLOYED = { host: "mixtape.up.railway.app", proto: "https" };

test("a matching Origin is allowed", () => {
  assert.equal(
    originAllowed({ ...DEPLOYED, origin: "https://mixtape.up.railway.app" }),
    true
  );
});

test("someone else's Origin is refused", () => {
  for (const origin of [
    "https://evil.example",
    "http://mixtape.up.railway.app", // same host, wrong scheme
    "https://mixtape.up.railway.app.evil.example", // suffix trick
    "https://evil.example?https://mixtape.up.railway.app",
    "null", // a sandboxed iframe or a data: URL form
  ]) {
    assert.equal(
      originAllowed({ ...DEPLOYED, origin }),
      false,
      `${origin} must be refused`
    );
  }
});

test("a missing Origin is allowed — curl, hermes, a plain navigation", () => {
  for (const origin of [undefined, null, "", "   "]) {
    assert.equal(originAllowed({ ...DEPLOYED, origin }), true);
  }
});

test("Sec-Fetch-Site is believed before our reconstructed origin", () => {
  // A reverse proxy that rewrites Host makes `${proto}://${host}` wrong; the
  // browser's own same-origin verdict is not forgeable from page script, so it
  // is the better answer when the two disagree.
  assert.equal(
    originAllowed({
      host: "127.0.0.1:8888",
      proto: "http",
      origin: "https://mixtape.example",
      secFetchSite: "same-origin",
    }),
    true
  );
  assert.equal(
    originAllowed({ ...DEPLOYED, origin: "https://cdn.example", secFetchSite: "same-site" }),
    true
  );
});

test("cross-site with a foreign Origin is the rejection case", () => {
  assert.equal(
    originAllowed({ ...DEPLOYED, origin: "https://evil.example", secFetchSite: "cross-site" }),
    false
  );
});

test("Sec-Fetch-Site: none with no Origin is a typed-in URL, allowed", () => {
  assert.equal(originAllowed({ ...DEPLOYED, secFetchSite: "none" }), true);
});

test("the dev server counts as ours in both loopback spellings", () => {
  const dev = { host: "127.0.0.1:8888", proto: "http", extraAllowed: ["http://localhost:5173"] };
  assert.equal(originAllowed({ ...dev, origin: "http://localhost:5173" }), true);
  assert.equal(originAllowed({ ...dev, origin: "http://127.0.0.1:5173" }), true, "same server");
  assert.equal(originAllowed({ ...dev, origin: "http://127.0.0.1:8888" }), true, "same origin");
  assert.equal(originAllowed({ ...dev, origin: "http://localhost:8888" }), true);
  assert.equal(originAllowed({ ...dev, origin: "http://127.0.0.1:5174" }), false, "wrong port");
});

test("the proxied scheme decides, not the internal hop", () => {
  // `trust proxy` is on, so callers pass req.protocol: https on a TLS-
  // terminated deploy even though the container itself speaks http.
  assert.equal(
    originAllowed({ host: "mixtape.example", proto: "https", origin: "https://mixtape.example" }),
    true
  );
  assert.equal(
    originAllowed({ host: "mixtape.example", proto: "http", origin: "https://mixtape.example" }),
    false
  );
});

test("a missing Host does not accidentally allow everything", () => {
  assert.equal(originAllowed({ origin: "https://evil.example" }), false);
});

test("normalizeOrigin keeps only real http(s) origins", () => {
  assert.equal(normalizeOrigin("https://Example.com:443/some/path"), "https://example.com");
  assert.equal(normalizeOrigin("http://example.com:8888"), "http://example.com:8888");
  for (const bad of ["", "  ", "null", "example.com", "javascript:alert(1)", "file:///x", null]) {
    assert.equal(normalizeOrigin(bad), null, `${bad} is not an origin`);
  }
});

test("allowedOriginsFromUrls drops junk and pairs the loopback spellings", () => {
  assert.deepEqual(allowedOriginsFromUrls(["http://localhost:5173"]).sort(), [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  assert.deepEqual(allowedOriginsFromUrls([null, "", "nonsense"]), []);
});

test("isRemoteUrl separates a real deployment from local dev", () => {
  assert.equal(isRemoteUrl("https://mixtape.up.railway.app"), true);
  for (const local of [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
    "http://0.0.0.0:8888",
    "http://app.localhost:5173",
    "",
    null,
    "not a url",
  ]) {
    assert.equal(isRemoteUrl(local), false, `${local} is not a remote client`);
  }
});
