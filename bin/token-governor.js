#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  appendCompletion,
  decideCheck,
  initialState,
  planWait,
  updateSnapshot
} from '../src/governor.js';

const EXIT_INVALID = 20;

function statePath() {
  return (
    process.env.TOKEN_GOVERNOR_STATE ??
    process.env.CODEX_GOVERNOR_STATE ??
    join(process.cwd(), '.token-governor', 'state.json')
  );
}

function nowIso() {
  return process.env.TOKEN_GOVERNOR_NOW ?? new Date().toISOString();
}

function readState(path) {
  if (!existsSync(path)) {
    return initialState();
  }

  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function option(args, name, { required = false, fallback = null } = {}) {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) {
      throw new Error(`Missing required option: ${name}`);
    }
    return fallback;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for option: ${name}`);
  }
  return value;
}

function tokenCount(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function optionalTokenCount(value, label) {
  return value === null ? null : tokenCount(value, label);
}

function hasFlag(args, name) {
  return args.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function run(argv) {
  const [command, ...args] = argv;
  const path = statePath();

  if (command === 'init') {
    const state = existsSync(path) ? readState(path) : initialState();
    writeState(path, state);
    return { exitCode: 0, body: { status: 'OK', statePath: path } };
  }

  if (command === 'snapshot') {
    const remainingTokens = tokenCount(option(args, '--remaining', { required: true }), '--remaining');
    const limitTokens = optionalTokenCount(option(args, '--limit', { fallback: null }), '--limit');
    const reserveTokens = tokenCount(option(args, '--reserve', { fallback: '0' }), '--reserve');
    const resetAt = option(args, '--reset-at', { required: true });
    const state = updateSnapshot(readState(path), {
      remainingTokens,
      limitTokens,
      reserveTokens,
      resetAt,
      now: nowIso()
    });

    writeState(path, state);
    return { exitCode: 0, body: { status: 'OK', statePath: path, budget: state.budget } };
  }

  if (command === 'check') {
    const issueId = args[0];
    if (!issueId) {
      throw new Error('Missing issue id');
    }

    const result = decideCheck(readState(path), issueId, { now: nowIso() });
    if (!hasFlag(args, '--wait') || result.status !== 'HOLD') {
      return { exitCode: result.exitCode, body: result };
    }

    const maxWaitOption = option(args, '--max-wait-seconds', { fallback: null });
    const wait = planWait(result, {
      now: nowIso(),
      bufferSeconds: tokenCount(option(args, '--buffer-seconds', { fallback: '30' }), '--buffer-seconds'),
      maxWaitSeconds: optionalTokenCount(maxWaitOption, '--max-wait-seconds')
    });

    if (!wait.shouldWait) {
      return { exitCode: result.exitCode, body: { ...result, wait } };
    }

    await sleep(wait.waitMs);
    const finalResult = decideCheck(readState(path), issueId, { now: nowIso() });
    return { exitCode: finalResult.exitCode, body: { ...finalResult, wait } };
  }

  if (command === 'complete') {
    const issueId = args[0];
    if (!issueId) {
      throw new Error('Missing issue id');
    }

    const tokens = tokenCount(option(args, '--tokens', { required: true }), '--tokens');
    const completedAt = nowIso();
    const state = appendCompletion(readState(path), {
      issueId,
      tokens,
      completedAt
    });

    writeState(path, state);
    return {
      exitCode: 0,
      body: {
        status: 'OK',
        statePath: path,
        issueId,
        tokens,
        completedAt
      }
    };
  }

  throw new Error(`Unknown command: ${command ?? '(none)'}`);
}

try {
  const { exitCode, body } = await run(process.argv.slice(2));
  console.log(JSON.stringify(body, null, 2));
  process.exitCode = exitCode;
} catch (error) {
  console.error(JSON.stringify({ status: 'ERROR', message: error.message }, null, 2));
  process.exitCode = EXIT_INVALID;
}
