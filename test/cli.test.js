import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../bin/token-governor.js', import.meta.url));

function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), 'token-governor-')), 'state.json');
}

function run(args, statePath, env = {}) {
  const mergedEnv = {
    ...process.env,
    TOKEN_GOVERNOR_NOW: '2026-06-27T00:00:00.000Z',
    ...env
  };

  if (statePath !== null) {
    mergedEnv.TOKEN_GOVERNOR_STATE = statePath;
  }

  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: mergedEnv
  });

  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null
  };
}

function tempProjectDir() {
  return mkdtempSync(join(tmpdir(), 'token-governor-project-'));
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

test('snapshot records cold-start tokens for first issue prediction', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  const result = run([
    'snapshot',
    '--remaining',
    '1200',
    '--reserve',
    '200',
    '--reset-at',
    '2026-06-28T00:00:00.000Z',
    '--cold-start-tokens',
    '700'
  ], statePath);

  assert.equal(result.status, 0);
  assert.equal(result.json.prediction.coldStartTokens, 700);

  const check = run(['check', 'LIN-1'], statePath);
  assert.equal(check.status, 0);
  assert.equal(check.json.status, 'ALLOW');
  assert.equal(check.json.predictedTokens, 700);
  assert.equal(check.json.predictionSource, 'cold_start');
});

test('global --project-dir stores state under the target project', () => {
  const projectDir = tempProjectDir();
  const result = run(['--project-dir', projectDir, 'init'], null);
  const expectedPath = join(projectDir, '.token-governor', 'state.json');

  assert.equal(result.status, 0);
  assert.equal(result.json.statePath, expectedPath);
  assert.equal(existsSync(expectedPath), true);
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

test('snapshot records five hour and weekly budget windows', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  const result = run([
    'snapshot',
    '--5h-remaining',
    '150',
    '--5h-limit',
    '1000',
    '--5h-reset-at',
    '2026-06-27T05:00:00.000Z',
    '--weekly-remaining',
    '4500',
    '--weekly-limit',
    '5000',
    '--weekly-reset-at',
    '2026-07-04T00:00:00.000Z'
  ], statePath);

  assert.equal(result.status, 0);
  assert.equal(result.json.budget.windows.fiveHour.maxUsageRatio, 0.9);
  assert.equal(result.json.budget.windows.weekly.maxUsageRatio, 0.95);
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

test('check exits HOLD when predicted burn would cross a window usage cap', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  run(['complete', 'LIN-1', '--tokens', '60'], statePath);
  run(['complete', 'LIN-2', '--tokens', '60'], statePath);
  run(['complete', 'LIN-3', '--tokens', '60'], statePath);
  run(['complete', 'LIN-4', '--tokens', '60'], statePath);
  run([
    'snapshot',
    '--5h-remaining',
    '150',
    '--5h-limit',
    '1000',
    '--5h-reset-at',
    '2026-06-27T05:00:00.000Z',
    '--weekly-remaining',
    '4500',
    '--weekly-limit',
    '5000',
    '--weekly-reset-at',
    '2026-07-04T00:00:00.000Z'
  ], statePath);

  const result = run(['check', 'LIN-5'], statePath);

  assert.equal(result.status, 10);
  assert.equal(result.json.status, 'HOLD');
  assert.deepEqual(result.json.blockingWindows, ['fiveHour']);
});

test('check uses the default cold-start prediction when there is no completion history', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);
  const snapshot = run([
    'snapshot',
    '--remaining',
    '100000',
    '--reserve',
    '100',
    '--reset-at',
    '2026-06-28T00:00:00.000Z'
  ], statePath);

  const result = run(['check', 'LIN-1'], statePath);

  assert.equal(snapshot.json.prediction.coldStartTokens, 60000);
  assert.equal(result.status, 0);
  assert.equal(result.json.status, 'ALLOW');
  assert.equal(result.json.predictedTokens, 60000);
  assert.equal(result.json.predictionSource, 'cold_start');
});

test('check --wait allows a cold start when no budget snapshot exists', () => {
  const statePath = tempStatePath();
  run(['init'], statePath);

  const result = run(['check', 'PK6-140', '--wait', '--max-wait-seconds', '14400'], statePath);

  assert.equal(result.status, 0);
  assert.equal(result.json.status, 'ALLOW');
  assert.equal(result.json.issueId, 'PK6-140');
  assert.equal(result.json.predictedTokens, 60000);
  assert.equal(result.json.predictionSource, 'cold_start');
  assert.equal(result.json.budgetSource, 'default_unconfigured');
  assert.equal(result.json.usableBudget, 180000);
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
