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
import { DEFAULT_CODEX_STATUS_LIMITS } from '../src/codex-status.js';
import { readUsageSnapshot } from '../src/usage.js';

const EXIT_INVALID = 20;

function parseGlobalOptions(argv) {
  const args = [...argv];
  let projectDir = process.env.TOKEN_GOVERNOR_PROJECT_DIR ?? process.cwd();

  for (let index = 0; index < args.length;) {
    if (args[index] !== '--project-dir') {
      index += 1;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for option: --project-dir');
    }

    projectDir = value;
    args.splice(index, 2);
  }

  return { args, projectDir };
}

function statePath(projectDir) {
  return (
    process.env.TOKEN_GOVERNOR_STATE ??
    process.env.CODEX_GOVERNOR_STATE ??
    join(projectDir, '.token-governor', 'state.json')
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

function ratio(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${label} must be a number greater than 0 and at most 1`);
  }
  return parsed;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function hasOption(args, name) {
  return args.includes(name);
}

function envFlag(name) {
  return ['1', 'true', 'yes'].includes(String(process.env[name] ?? '').toLowerCase());
}

function usageProviderOptions(args, projectDir) {
  return {
    codexStatus: hasFlag(args, '--codex-status') || envFlag('TOKEN_GOVERNOR_CODEX_STATUS'),
    codexStatusFile: option(args, '--codex-status-file', {
      fallback: process.env.TOKEN_GOVERNOR_CODEX_STATUS_FILE ?? null
    }),
    codexCommand: option(args, '--codex-command', {
      fallback: process.env.TOKEN_GOVERNOR_CODEX_COMMAND ?? 'codex'
    }),
    codexCwd: projectDir,
    codexStatusTimeoutMs: tokenCount(
      option(args, '--codex-status-timeout-ms', {
        fallback: process.env.TOKEN_GOVERNOR_CODEX_STATUS_TIMEOUT_MS ?? '60000'
      }),
      '--codex-status-timeout-ms'
    ),
    codexStatusLimits: {
      fiveHour: tokenCount(
        option(args, '--codex-5h-limit', {
          fallback: process.env.TOKEN_GOVERNOR_CODEX_5H_LIMIT ?? String(DEFAULT_CODEX_STATUS_LIMITS.fiveHour)
        }),
        '--codex-5h-limit'
      ),
      weekly: tokenCount(
        option(args, '--codex-weekly-limit', {
          fallback: process.env.TOKEN_GOVERNOR_CODEX_WEEKLY_LIMIT ?? String(DEFAULT_CODEX_STATUS_LIMITS.weekly)
        }),
        '--codex-weekly-limit'
      )
    },
    usageFile: option(args, '--usage-file', {
      fallback: process.env.TOKEN_GOVERNOR_USAGE_FILE ?? null
    }),
    usageCommand: option(args, '--usage-command', {
      fallback: process.env.TOKEN_GOVERNOR_USAGE_COMMAND ?? null
    })
  };
}

async function refreshState(path, args, projectDir) {
  const snapshot = await readUsageSnapshot({
    ...usageProviderOptions(args, projectDir),
    now: nowIso()
  });
  const state = updateSnapshot(readState(path), snapshot);
  writeState(path, state);
  return state;
}

function parseWindow(args, prefix, name, defaultMaxUsageRatio) {
  const optionNames = [
    `--${prefix}-remaining`,
    `--${prefix}-limit`,
    `--${prefix}-reset-at`,
    `--${prefix}-max-usage-ratio`
  ];

  if (!optionNames.some((optionName) => hasOption(args, optionName))) {
    return null;
  }

  return [
    name,
    {
      remainingTokens: tokenCount(
        option(args, `--${prefix}-remaining`, { required: true }),
        `--${prefix}-remaining`
      ),
      limitTokens: tokenCount(option(args, `--${prefix}-limit`, { required: true }), `--${prefix}-limit`),
      maxUsageRatio: ratio(
        option(args, `--${prefix}-max-usage-ratio`, { fallback: String(defaultMaxUsageRatio) }),
        `--${prefix}-max-usage-ratio`
      ),
      resetAt: option(args, `--${prefix}-reset-at`, { required: true })
    }
  ];
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function run(argv) {
  const { args: commandArgs, projectDir } = parseGlobalOptions(argv);
  const [command, ...args] = commandArgs;
  const path = statePath(projectDir);

  if (command === 'init') {
    const state = existsSync(path) ? readState(path) : initialState();
    writeState(path, state);
    return { exitCode: 0, body: { status: 'OK', statePath: path } };
  }

  if (command === 'snapshot') {
    const coldStartTokens = optionalTokenCount(
      option(args, '--cold-start-tokens', { fallback: null }),
      '--cold-start-tokens'
    );
    const windowEntries = [
      parseWindow(args, '5h', 'fiveHour', 0.9),
      parseWindow(args, 'weekly', 'weekly', 0.95)
    ].filter(Boolean);

    if (windowEntries.length > 0) {
      const snapshot = {
        windows: Object.fromEntries(windowEntries),
        now: nowIso()
      };
      if (coldStartTokens !== null) {
        snapshot.coldStartTokens = coldStartTokens;
      }

      const state = updateSnapshot(readState(path), snapshot);

      writeState(path, state);
      return {
        exitCode: 0,
        body: {
          status: 'OK',
          statePath: path,
          budget: state.budget,
          prediction: state.prediction
        }
      };
    }

    const remainingTokens = tokenCount(option(args, '--remaining', { required: true }), '--remaining');
    const limitTokens = optionalTokenCount(option(args, '--limit', { fallback: null }), '--limit');
    const reserveTokens = tokenCount(option(args, '--reserve', { fallback: '0' }), '--reserve');
    const resetAt = option(args, '--reset-at', { required: true });
    const snapshot = {
      remainingTokens,
      limitTokens,
      reserveTokens,
      resetAt,
      now: nowIso()
    };
    if (coldStartTokens !== null) {
      snapshot.coldStartTokens = coldStartTokens;
    }

    const state = updateSnapshot(readState(path), snapshot);

    writeState(path, state);
    return {
      exitCode: 0,
      body: {
        status: 'OK',
        statePath: path,
        budget: state.budget,
        prediction: state.prediction
      }
    };
  }

  if (command === 'refresh') {
    const state = await refreshState(path, args, projectDir);
    return {
      exitCode: 0,
      body: {
        status: 'OK',
        statePath: path,
        budget: state.budget,
        prediction: state.prediction
      }
    };
  }

  if (command === 'codex-status') {
    const snapshot = await readUsageSnapshot({
      ...usageProviderOptions(['--codex-status', ...args], projectDir),
      now: nowIso()
    });
    return {
      exitCode: 0,
      body: {
        status: 'OK',
        snapshot
      }
    };
  }

  if (command === 'check') {
    const issueId = args[0];
    if (!issueId) {
      throw new Error('Missing issue id');
    }

    const refreshed = hasFlag(args, '--refresh');
    const result = decideCheck(refreshed ? await refreshState(path, args, projectDir) : readState(path), issueId, { now: nowIso() });
    const body = refreshed ? { ...result, budgetSource: 'refreshed' } : result;
    if (!hasFlag(args, '--wait') || result.status !== 'HOLD') {
      return { exitCode: result.exitCode, body };
    }

    const maxWaitOption = option(args, '--max-wait-seconds', { fallback: null });
    const wait = planWait(result, {
      now: nowIso(),
      bufferSeconds: tokenCount(option(args, '--buffer-seconds', { fallback: '30' }), '--buffer-seconds'),
      maxWaitSeconds: optionalTokenCount(maxWaitOption, '--max-wait-seconds')
    });

    if (!wait.shouldWait) {
      return { exitCode: result.exitCode, body: { ...body, wait } };
    }

    await sleep(wait.waitMs);
    const finalResult = decideCheck(refreshed ? await refreshState(path, args, projectDir) : readState(path), issueId, { now: nowIso() });
    return {
      exitCode: finalResult.exitCode,
      body: {
        ...finalResult,
        ...(refreshed ? { budgetSource: 'refreshed' } : {}),
        wait
      }
    };
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
