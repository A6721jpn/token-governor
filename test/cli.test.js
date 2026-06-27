import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../bin/token-governor.js', import.meta.url));

function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), 'token-governor-')), 'state.json');
}

function run(args, statePath, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_GOVERNOR_STATE: statePath,
      TOKEN_GOVERNOR_NOW: '2026-06-27T00:00:00.000Z',
      ...env
    }
  });

  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null
  };
}

test('init creates a state file', () => {
  const statePath = tempStatePath();
  const result = run(['init'], statePath);

  assert.equal(result.status, 0);
  assert.equal(result.json.status, 'OK');
  assert.equal(result.json.statePath, statePath);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).version, 1);
});

test('snapshot records the current budget', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  const result = run([
    'snapshot',
    '--remaining',
    '1200',
    '--reserve',
    '200',
    '--reset-at',
    '2026-06-28T00:00:00.000Z'
  ], statePath);

  assert.equal(result.status, 0);
  assert.equal(result.json.status, 'OK');
  assert.equal(result.json.budget.remainingTokens, 1200);
  assert.equal(result.json.budget.limitTokens, null);
  assert.equal(result.json.budget.reserveTokens, 200);
});

test('snapshot can record the reset limit for wait mode', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  const result = run([
    'snapshot',
    '--remaining',
    '1200',
    '--limit',
    '5000',
    '--reserve',
    '200',
    '--reset-at',
    '2026-06-28T00:00:00.000Z'
  ], statePath);

  assert.equal(result.status, 0);
  assert.equal(result.json.budget.limitTokens, 5000);
});

test('check exits ALLOW when predicted burn fits the usable budget', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  run(['complete', 'LIN-1', '--tokens', '300'], statePath);
  run(['complete', 'LIN-2', '--tokens', '400'], statePath);
  run(['complete', 'LIN-3', '--tokens', '500'], statePath);
  run(['complete', 'LIN-4', '--tokens', '600'], statePath);
  run(['snapshot', '--remaining', '1000', '--reserve', '100', '--reset-at', '2026-06-28T00:00:00.000Z'], statePath);

  const result = run(['check', 'LIN-5'], statePath);

  assert.equal(result.status, 0);
  assert.equal(result.json.status, 'ALLOW');
  assert.equal(result.json.predictedTokens, 500);
});

test('check exits HOLD when predicted burn exceeds the usable budget', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  run(['complete', 'LIN-1', '--tokens', '300'], statePath);
  run(['complete', 'LIN-2', '--tokens', '400'], statePath);
  run(['complete', 'LIN-3', '--tokens', '500'], statePath);
  run(['complete', 'LIN-4', '--tokens', '600'], statePath);
  run(['snapshot', '--remaining', '550', '--reserve', '100', '--reset-at', '2026-06-28T00:00:00.000Z'], statePath);

  const result = run(['check', 'LIN-5'], statePath);

  assert.equal(result.status, 10);
  assert.equal(result.json.status, 'HOLD');
  assert.equal(result.json.reason, 'budget_insufficient');
});

test('check exits UNKNOWN when there is no completion history', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  run(['snapshot', '--remaining', '1000', '--reserve', '100', '--reset-at', '2026-06-28T00:00:00.000Z'], statePath);

  const result = run(['check', 'LIN-1'], statePath);

  assert.equal(result.status, 12);
  assert.equal(result.json.status, 'UNKNOWN');
  assert.equal(result.json.reason, 'no_completion_history');
});

test('check --wait holds instead of sleeping past max wait', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  run(['complete', 'LIN-1', '--tokens', '300'], statePath);
  run(['complete', 'LIN-2', '--tokens', '400'], statePath);
  run(['complete', 'LIN-3', '--tokens', '500'], statePath);
  run(['complete', 'LIN-4', '--tokens', '600'], statePath);
  run(['snapshot', '--remaining', '550', '--limit', '1000', '--reserve', '100', '--reset-at', '2026-06-28T00:00:00.000Z'], statePath);

  const result = run(['check', 'LIN-5', '--wait', '--max-wait-seconds', '60'], statePath);

  assert.equal(result.status, 10);
  assert.equal(result.json.status, 'HOLD');
  assert.equal(result.json.wait.reason, 'max_wait_exceeded');
});

test('check uses the reset limit once resetAt has passed', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  run(['complete', 'LIN-1', '--tokens', '300'], statePath);
  run(['complete', 'LIN-2', '--tokens', '400'], statePath);
  run(['complete', 'LIN-3', '--tokens', '500'], statePath);
  run(['complete', 'LIN-4', '--tokens', '600'], statePath);
  run(['snapshot', '--remaining', '100', '--limit', '1000', '--reserve', '100', '--reset-at', '2026-06-28T00:00:00.000Z'], statePath);

  const result = run(['check', 'LIN-5'], statePath, {
    TOKEN_GOVERNOR_NOW: '2026-06-28T00:00:01.000Z'
  });

  assert.equal(result.status, 0);
  assert.equal(result.json.status, 'ALLOW');
  assert.equal(result.json.remainingTokens, 1000);
});
