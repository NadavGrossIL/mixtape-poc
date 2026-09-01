import test from 'node:test'
import assert from 'node:assert/strict'
import { WRITE_ORIGINS, checkWriteRequest } from './writeGuard'

// The CSRF fence on POST /api/file. The cases that matter are the two shapes a
// hostile page can actually produce — its own Origin, and a text/plain body
// that needs no preflight — plus the shape the console's own page produces, so
// a tightening here cannot silently break Save.

const OK = { origin: 'http://127.0.0.1:5174', 'content-type': 'application/json' }

test('the console page may write', () => {
  assert.deepEqual(checkWriteRequest(OK), { ok: true })
})

test('both names for this dev server are accepted, and only those two', () => {
  assert.deepEqual(WRITE_ORIGINS, ['http://127.0.0.1:5174', 'http://localhost:5174'])
  for (const origin of WRITE_ORIGINS) assert.deepEqual(checkWriteRequest({ ...OK, origin }), { ok: true }, origin)
})

test('a fetch content-type with a charset passes', () => {
  // What the browser actually sends for `headers: { 'content-type': 'application/json' }`
  // once it has been through a form or a charset-adding proxy; and the casing is not ours to assume.
  for (const type of ['application/json; charset=utf-8', 'application/json;charset=UTF-8', 'Application/JSON', ' application/json '])
    assert.deepEqual(checkWriteRequest({ ...OK, 'content-type': type }), { ok: true }, type)
})

test('another origin is 403', () => {
  for (const origin of [
    'http://evil.example',
    'https://evil.example',
    'http://127.0.0.1:5173', // the product client's dev port — a different app on the same loopback
    'http://127.0.0.1:8888', // the Mixtape server
    'http://127.0.0.1:5174.evil.example',
    'http://localhost:5174/', // a trailing slash is not an origin
    'null', // a sandboxed iframe
  ]) {
    const v = checkWriteRequest({ ...OK, origin })
    assert.deepEqual(v, { ok: false, status: 403, error: 'origin not allowed' }, origin)
  }
})

test('a missing or empty Origin is 403, before the body is even read', () => {
  // A browser sets Origin on every POST, same-origin included, so a request
  // without one is not the attack we are defending against — but it is also not
  // the console, and the console is the only client this endpoint has.
  for (const headers of [{ 'content-type': 'application/json' }, { origin: '', 'content-type': 'application/json' }, { origin: '   ', 'content-type': 'application/json' }, {}]) {
    const v = checkWriteRequest(headers)
    assert.equal(v.ok, false)
    assert.equal((v as { status: number }).status, 403)
  }
})

test('a non-JSON content-type is 415 — that is the CORS-simple path', () => {
  for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonish', undefined]) {
    const v = checkWriteRequest(type === undefined ? { origin: OK.origin } : { ...OK, 'content-type': type })
    assert.deepEqual(v, { ok: false, status: 415, error: 'expected content-type: application/json' }, String(type))
  }
})

test('header names are matched case-insensitively and a repeated header takes its first value', () => {
  assert.deepEqual(checkWriteRequest({ Origin: OK.origin, 'Content-Type': 'application/json' }), { ok: true })
  assert.deepEqual(checkWriteRequest({ origin: [OK.origin, 'http://evil.example'], 'content-type': ['application/json'] }), { ok: true })
})
