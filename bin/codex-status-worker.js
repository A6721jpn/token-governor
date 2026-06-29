#!/usr/bin/env node
import { captureCodexStatusTextInProcess } from '../src/codex-status.js';

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function readOptions() {
  const raw = process.env.TOKEN_GOVERNOR_CODEX_STATUS_WORKER_OPTIONS;
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

try {
  const options = readOptions();
  const output = await captureCodexStatusTextInProcess({
    codexCommand: options.codexCommand ?? 'codex',
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 60_000,
    settleMs: options.settleMs ?? 500,
    env: process.env
  });

  writeMessage({ ok: true, output });
} catch (error) {
  writeMessage({
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }
  });
  process.exitCode = 1;
}
