import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safePath } from '../plugins/mythos-vibe/shared/bridge.mjs';

test('safePath accepts plain workspace-relative paths', () => {
  assert.equal(safePath('src/Catalog.java'), 'src/Catalog.java');
  assert.equal(safePath('a/b/c.txt'), 'a/b/c.txt');
  assert.equal(safePath('README.md'), 'README.md');
});

test('safePath rejects non-string, empty and over-long paths', () => {
  for (const bad of [null, undefined, 42, {}, '', 'x'.repeat(1501)]) {
    assert.throws(() => safePath(bad), /Only workspace-relative paths are allowed/, String(bad).slice(0, 20));
  }
  assert.equal(safePath('x'.repeat(1500)), 'x'.repeat(1500));
});

test('safePath rejects backslashes and control characters', () => {
  assert.throws(() => safePath('a\\b\\c.txt'));
  for (const ch of ['\n', '\r', '\t', '\x00', '\x1f']) assert.throws(() => safePath('a' + ch + 'b'));
});

test('safePath rejects absolute paths and windows drive syntax', () => {
  for (const bad of ['/etc/passwd', '/src/A.java']) assert.throws(() => safePath(bad));
});

test('safePath rejects dot, dot-dot and empty segments at any depth', () => {
  for (const bad of ['.', '..', '../secret', 'a/../b', './a', 'a//b', 'a/./b', '..']) assert.throws(() => safePath(bad));
});

test('safePath checks whole segments, so lookalike dot names stay inside the workspace', () => {
  assert.equal(safePath('...x/y'), '...x/y');
  assert.equal(safePath('.../x'), '.../x');
  assert.equal(safePath('a/...'), 'a/...');
  assert.throws(() => safePath('..x/../y'));
});
