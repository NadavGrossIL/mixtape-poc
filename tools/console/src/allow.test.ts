import test from 'node:test'
import assert from 'node:assert/strict'
import { READ_ONLY, WRITABLE, allowed, isWritable, normalizePath } from './allow'

// The point of these: the read side grew in slice 4 and the write side must not
// have. Everything the panel can save, and everything the context row can open,
// with the traversals that have to stay out of both.

test('the write list is the five definition files and nothing else', () => {
  assert.equal(WRITABLE.length, 5)
  for (const p of [
    '.claude/workflows/implement-from-spec.js',
    '.claude/skills/implement/SKILL.md',
    '.claude/agents/reviewer.md',
    '.archon/workflows/line.yaml',
    '.archon/workflows/line.yml',
    'factory.config.json',
  ]) assert.equal(allowed(p, 'write'), p, p)
})

test('the read-only additions are readable and NOT writable', () => {
  for (const p of [
    'specs/0002-album-position-gate-blind-spots.md',
    'docs/factory/RUNS.md',
    'docs/factory/runs/2026-08-29-0002-attempt3.json',
    'docs/factory/runs/2026-08-29-0002-attempt3.diff',
    'docs/factory/runs/2026-08-29-0002-attempt3.pr.md',
  ]) {
    assert.equal(allowed(p, 'read'), p, `read ${p}`)
    assert.equal(allowed(p, 'write'), undefined, `write ${p}`)
    assert.equal(isWritable(p), false, `isWritable ${p}`)
  }
})

test('a writable path is readable too', () => {
  assert.equal(allowed('.claude/agents/reviewer.md', 'read'), '.claude/agents/reviewer.md')
})

test('nothing else is on either list', () => {
  for (const p of [
    'server/curator.ts',
    'server/.env',
    'CLAUDE.md',
    'docs/factory/plan.md',
    'specs/_template.md/../../server/.env',
    'specs/nested/0001.md',
    'docs/factory/runs/2026-08-29-0002-attempt3.txt',
    '.github/workflows/ci.yml',
  ]) {
    assert.equal(allowed(p, 'read'), undefined, `read ${p}`)
    assert.equal(allowed(p, 'write'), undefined, `write ${p}`)
  }
})

test('traversals, absolutes and empty segments are not paths', () => {
  for (const p of ['../server/.env', 'specs/../../etc/passwd', '/etc/passwd', 'specs//0001.md', 'specs/./0001.md', '..', '', null, undefined, 42]) {
    assert.equal(normalizePath(p), undefined, String(p))
    assert.equal(allowed(p, 'read'), undefined, String(p))
  }
})

test('normalizePath canonicalises what it accepts', () => {
  assert.equal(normalizePath('./specs/0001-x.md'), 'specs/0001-x.md')
  assert.equal(normalizePath('.claude\\agents\\reviewer.md'), '.claude/agents/reviewer.md')
})

test('the read-only list stays inside specs/ and docs/factory/', () => {
  for (const re of READ_ONLY) assert.match(re.source, /^\^(specs|docs\\\/factory)/)
})
