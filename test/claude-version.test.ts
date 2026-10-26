import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_VERSION, supportedClaudeVersion } from '../src/claude.ts';

test('Claude compatibility accepts the minimum and newer semantic versions', () => {
  assert.equal(supportedClaudeVersion(CLAUDE_VERSION), true);
  assert.equal(supportedClaudeVersion('2.1.302'), true);
  assert.equal(supportedClaudeVersion('2.2.0'), true);
  assert.equal(supportedClaudeVersion('3.0.0'), true);
});

test('Claude compatibility rejects older and malformed versions', () => {
  assert.equal(supportedClaudeVersion('2.1.295'), false);
  assert.equal(supportedClaudeVersion('2.0.999'), false);
  assert.equal(supportedClaudeVersion('1.999.999'), false);
  assert.equal(supportedClaudeVersion('2.1'), false);
  assert.equal(supportedClaudeVersion('latest'), false);
});
