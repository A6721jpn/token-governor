import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  captureCodexStatusText,
  DEFAULT_CODEX_STATUS_LIMITS,
  parseCodexStatusSnapshot
} from './codex-status.js';

function numberField(value, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`Missing usage field: ${label}`);
    }
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function ratioField(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${label} must be a number greater than 0 and at most 1`);
  }
  return parsed;
}

function stringField(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new Error(`Missing usage field: ${label}`);
    }
    return null;
  }
  return String(value);
}

function valueOf(object, ...names) {
  for (const name of names) {
    if (object[name] !== undefined) {
      return object[name];
    }
  }
  return undefined;
}

function canonicalWindowName(name) {
  if (['5h', 'five_hour', 'five-hour', 'fiveHour'].includes(name)) {
    return 'fiveHour';
  }
  if (['week', 'weekly'].includes(name)) {
    return 'weekly';
  }
  return name;
}

function normalizeUsageWindow(name, window) {
  const normalized = {
    remainingTokens: numberField(
      valueOf(window, 'remainingTokens', 'remaining', 'remaining_tokens'),
      `windows.${name}.remainingTokens`
    ),
    limitTokens: numberField(
      valueOf(window, 'limitTokens', 'limit', 'limit_tokens'),
      `windows.${name}.limitTokens`
    ),
    resetAt: stringField(valueOf(window, 'resetAt', 'reset_at'), `windows.${name}.resetAt`)
  };
  const reserveTokens = numberField(
    valueOf(window, 'reserveTokens', 'reserve', 'reserve_tokens'),
    `windows.${name}.reserveTokens`,
    { required: false }
  );
  const maxUsageRatio = ratioField(
    valueOf(window, 'maxUsageRatio', 'max_usage_ratio'),
    `windows.${name}.maxUsageRatio`
  );
  const minRemainingRatio = ratioField(
    valueOf(window, 'minRemainingRatio', 'min_remaining_ratio'),
    `windows.${name}.minRemainingRatio`
  );

  if (reserveTokens !== null) {
    normalized.reserveTokens = reserveTokens;
  }
  if (minRemainingRatio !== undefined) {
    normalized.minRemainingRatio = minRemainingRatio;
  } else if (maxUsageRatio !== undefined) {
    normalized.minRemainingRatio = 1 - maxUsageRatio;
    normalized.maxUsageRatio = maxUsageRatio;
  }

  return normalized;
}

export function parseUsageSnapshot(raw, { now }) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`Usage provider did not return valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Usage provider must return a JSON object');
  }

  const snapshot = { now };
  const coldStartTokens = numberField(
    valueOf(parsed, 'coldStartTokens', 'cold_start_tokens'),
    'coldStartTokens',
    { required: false }
  );
  if (coldStartTokens !== null) {
    snapshot.coldStartTokens = coldStartTokens;
  }

  if (parsed.windows && typeof parsed.windows === 'object' && !Array.isArray(parsed.windows)) {
    snapshot.windows = Object.fromEntries(
      Object.entries(parsed.windows).map(([name, window]) => [
        canonicalWindowName(name),
        normalizeUsageWindow(name, window)
      ])
    );
    return snapshot;
  }

  snapshot.remainingTokens = numberField(
    valueOf(parsed, 'remainingTokens', 'remaining', 'remaining_tokens'),
    'remainingTokens'
  );
  snapshot.limitTokens = numberField(
    valueOf(parsed, 'limitTokens', 'limit', 'limit_tokens'),
    'limitTokens',
    { required: false }
  );
  snapshot.reserveTokens = numberField(
    valueOf(parsed, 'reserveTokens', 'reserve', 'reserve_tokens'),
    'reserveTokens',
    { required: false }
  ) ?? 0;
  snapshot.resetAt = stringField(valueOf(parsed, 'resetAt', 'reset_at'), 'resetAt');
  return snapshot;
}

function codexStatusSnapshot(text, { now, limits }) {
  return parseUsageSnapshot({
    ...parseCodexStatusSnapshot(text, { now, limits }),
    now
  }, { now });
}

export async function readUsageSnapshot({
  usageFile = null,
  usageCommand = null,
  codexStatus = false,
  codexStatusFile = null,
  codexCommand = 'codex',
  codexCwd = process.cwd(),
  codexStatusTimeoutMs = 60_000,
  codexStatusLimits = DEFAULT_CODEX_STATUS_LIMITS,
  now
}) {
  if (codexStatusFile) {
    return codexStatusSnapshot(readFileSync(codexStatusFile, 'utf8'), {
      now,
      limits: codexStatusLimits
    });
  }

  if (codexStatus) {
    const output = await captureCodexStatusText({
      codexCommand,
      cwd: codexCwd,
      timeoutMs: codexStatusTimeoutMs
    });
    return codexStatusSnapshot(output, {
      now,
      limits: codexStatusLimits
    });
  }

  if (usageFile) {
    return parseUsageSnapshot(readFileSync(usageFile, 'utf8'), { now });
  }

  if (usageCommand) {
    const output = execSync(usageCommand, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return parseUsageSnapshot(output, { now });
  }

  throw new Error(
    'Missing usage provider. Use --codex-status, --usage-file, --usage-command, TOKEN_GOVERNOR_CODEX_STATUS, TOKEN_GOVERNOR_USAGE_FILE, or TOKEN_GOVERNOR_USAGE_COMMAND.'
  );
}
