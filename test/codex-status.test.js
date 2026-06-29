import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexStatusFailureMessage,
  codexStatusInput,
  captureCodexStatusText,
  parseCodexStatusSnapshot,
  resolveCodexSpawn,
  shouldAttemptCodexStatus
} from '../src/codex-status.js';

test('shouldAttemptCodexStatus starts when the bare prompt is visible', () => {
  assert.equal(shouldAttemptCodexStatus('\n\u203a '), true);
});

test('captureCodexStatusText returns after worker output even if the worker keeps handles alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-governor-codex-status-worker-'));
  const workerPath = join(dir, 'worker.mjs');
  const statusOutput = [
    '5h limit:     [xxxxxxxxxxxxxxxxxxx-] 97% left (resets 03:34)',
    'Weekly limit: [xxxxxxxxxxxxxxxx----] 78% left (resets 14:23 on 5 Jul)'
  ].join('\n');

  writeFileSync(workerPath, [
    `process.stdout.write(JSON.stringify({ ok: true, output: ${JSON.stringify(statusOutput)} }) + '\\n');`,
    'setInterval(() => {}, 1000);'
  ].join('\n'));

  const startedAt = Date.now();
  const output = await captureCodexStatusText({
    workerCommand: process.execPath,
    workerArgs: [workerPath],
    workerShutdownGraceMs: 50,
    timeoutMs: 1000
  });

  assert.equal(output, statusOutput);
  assert.ok(Date.now() - startedAt < 900);
});

test('codexStatusFailureMessage includes captured output tail', () => {
  const message = codexStatusFailureMessage(1, '\nfirst line\nlast useful line');

  assert.match(message, /exit 1/);
  assert.match(message, /last useful line/);
});

test('resolveCodexSpawn overrides invalid inherited service_tier values', () => {
  assert.deepEqual(resolveCodexSpawn('custom-codex', {}).args, ['-c', 'service_tier="flex"']);
});

const STATUS_OUTPUT = `
/status

╭────────────────────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.130.0)                                                            │
│                                                                                        │
│ Visit https://chatgpt.com/codex/settings/usage for up-to-date                          │
│ information on rate limits and credits                                                 │
│                                                                                        │
│  Model:                       gpt-5.5 (reasoning high, summaries auto)                 │
│  Directory:                   D:\\github\\codex-remote                                   │
│  Permissions:                 Workspace (auto-review)                                  │
│  Agents.md:                   <none>                                                   │
│  Account:                     user@example.com (Plus)                                  │
│  Collaboration mode:          Default                                                  │
│  Session:                     019f09a1-8d3f-7171-81de-5c24c195dbc9                     │
│                                                                                        │
│  5h limit:                    [█████████████████░░░] 87% left (resets 03:02)           │
│  Weekly limit:                [████████████████░░░░] 82% left (resets 14:23 on 4 Jul)  │
│  GPT-5.3-Codex-Spark limit:                                                            │
│  5h limit:                    [████████████████████] 100% left (resets 05:10)          │
│  Weekly limit:                [████████████████████] 100% left (resets 00:10 on 5 Jul) │
╰────────────────────────────────────────────────────────────────────────────────────────╯
`;

test('parseCodexStatusSnapshot reads the primary model rate windows from /status', () => {
  const snapshot = parseCodexStatusSnapshot(STATUS_OUTPUT, {
    now: '2026-06-28T01:00:00.000+09:00',
    limits: {
      fiveHour: 200_000,
      weekly: 1_000_000
    }
  });

  assert.deepEqual(snapshot.windows.fiveHour, {
    remainingTokens: 174_000,
    limitTokens: 200_000,
    resetAt: '2026-06-27T18:02:00.000Z'
  });
  assert.deepEqual(snapshot.windows.weekly, {
    remainingTokens: 820_000,
    limitTokens: 1_000_000,
    resetAt: '2026-07-04T05:23:00.000Z'
  });
});

test('parseCodexStatusSnapshot rolls same-day reset times forward when already passed', () => {
  const snapshot = parseCodexStatusSnapshot('5h limit: [x] 25% left (resets 00:10)', {
    now: '2026-06-28T01:00:00.000+09:00',
    limits: {
      fiveHour: 100_000
    }
  });

  assert.equal(snapshot.windows.fiveHour.remainingTokens, 25_000);
  assert.equal(snapshot.windows.fiveHour.resetAt, '2026-06-28T15:10:00.000Z');
});

test('shouldAttemptCodexStatus ignores startup example prompts', () => {
  assert.equal(shouldAttemptCodexStatus('\n› Find and fix a bug in @filename'), false);
});

test('shouldAttemptCodexStatus waits until Codex startup settles', () => {
  assert.equal(shouldAttemptCodexStatus('\n⚠ MCP startup incomplete (failed: github, linear)\n\n› '), true);
});

test('codexStatusInput presses enter when /status is already typed', () => {
  assert.equal(codexStatusInput('\n⚠ MCP startup incomplete (failed: github, linear)\n\n› /status'), '\r');
});

test('codexStatusInput types /status when prompt is empty', () => {
  assert.equal(codexStatusInput('\n⚠ MCP startup incomplete (failed: github, linear)\n\n› '), '/status\r');
});
