import { existsSync } from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';

const MONTHS = new Map([
  ['jan', 0],
  ['feb', 1],
  ['mar', 2],
  ['apr', 3],
  ['may', 4],
  ['jun', 5],
  ['jul', 6],
  ['aug', 7],
  ['sep', 8],
  ['oct', 9],
  ['nov', 10],
  ['dec', 11]
]);

export const DEFAULT_CODEX_STATUS_LIMITS = {
  fiveHour: 200_000,
  weekly: 1_000_000
};

const STATUS_READY_PATTERN = /\b5h\s+limit:.*?\b\d{1,3}%\s+left[\s\S]*?\bWeekly\s+limit:.*?\b\d{1,3}%\s+left/i;
const TRUST_PROMPT_PATTERN = /Do you trust the contents of this directory\?|Press enter to continue/i;
const STARTUP_SETTLED_PATTERN = /\bMCP startup (?:complete|incomplete)\b/i;
const STATUS_TYPED_PATTERN = /(?:^|[\n\r])\s*\u203a\s*\/status\b/i;

function silenceConptyConsoleListAgent(callback) {
  if (process.platform !== 'win32') {
    callback();
    return;
  }

  const originalFork = childProcess.fork;
  childProcess.fork = function forkWithQuietConptyAgent(modulePath, args, options) {
    if (String(modulePath).includes('conpty_console_list_agent')) {
      return originalFork.call(childProcess, modulePath, args, {
        ...(options ?? {}),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
    }
    return originalFork.apply(childProcess, arguments);
  };

  try {
    callback();
  } finally {
    childProcess.fork = originalFork;
  }
}

function stripTerminalControl(value) {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function tail(value, length = 4000) {
  return value.slice(Math.max(0, value.length - length));
}

export function shouldAttemptCodexStatus(text) {
  const plainTail = tail(stripTerminalControl(text));
  return STARTUP_SETTLED_PATTERN.test(plainTail) || STATUS_TYPED_PATTERN.test(plainTail);
}

export function codexStatusInput(text) {
  return STATUS_TYPED_PATTERN.test(tail(stripTerminalControl(text))) ? '\r' : '/status\r';
}

function defaultWindowsCodexPath(env) {
  if (process.platform !== 'win32' || !env.APPDATA) {
    return null;
  }

  const candidate = path.join(
    env.APPDATA,
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'codex',
    'codex.exe'
  );
  return existsSync(candidate) ? candidate : null;
}

function resolveCodexSpawn(codexCommand, env) {
  if (codexCommand === 'codex') {
    const windowsNativePath = defaultWindowsCodexPath(env);
    if (windowsNativePath) {
      return { file: windowsNativePath, args: [] };
    }
  }

  return { file: codexCommand, args: [] };
}

function offsetMinutesFromNow(now) {
  if (typeof now === 'string') {
    const match = now.match(/([+-])(\d{2}):?(\d{2})$/);
    if (match) {
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3]));
    }
  }

  return -new Date(now).getTimezoneOffset();
}

function localParts(nowDate, offsetMinutes) {
  const local = new Date(nowDate.getTime() + offsetMinutes * 60_000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    localTimeMs: local.getTime()
  };
}

function parseClock(value) {
  const match = value.match(/^(\d{1,2}):(\d{2})(?:\s+on\s+(\d{1,2})\s+([A-Za-z]{3}))?$/);
  if (!match) {
    throw new Error(`Unsupported Codex status reset time: ${value}`);
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    day: match[3] === undefined ? null : Number(match[3]),
    month: match[4] === undefined ? null : MONTHS.get(match[4].toLowerCase())
  };
}

function resetAtIso(resetText, { now, offsetMinutes }) {
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error(`Invalid now value: ${now}`);
  }

  const clock = parseClock(resetText.trim());
  const parts = localParts(nowDate, offsetMinutes);
  let candidateLocalMs;

  if (clock.day === null) {
    candidateLocalMs = Date.UTC(parts.year, parts.month, parts.day, clock.hour, clock.minute);
    if (candidateLocalMs <= parts.localTimeMs) {
      candidateLocalMs += 24 * 60 * 60 * 1000;
    }
  } else {
    if (clock.month === undefined) {
      throw new Error(`Unsupported Codex status reset month: ${resetText}`);
    }
    candidateLocalMs = Date.UTC(parts.year, clock.month, clock.day, clock.hour, clock.minute);
    if (candidateLocalMs <= parts.localTimeMs) {
      candidateLocalMs = Date.UTC(parts.year + 1, clock.month, clock.day, clock.hour, clock.minute);
    }
  }

  return new Date(candidateLocalMs - offsetMinutes * 60_000).toISOString();
}

function parseLimitLine(line) {
  const match = line.match(/\b(5h|Weekly)\s+limit:\s*\[[^\]]*\]\s*(\d{1,3})%\s+left\s+\(resets\s+([^)]+)\)/i);
  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase() === '5h' ? 'fiveHour' : 'weekly',
    percentLeft: Number(match[2]),
    resetText: match[3].trim()
  };
}

export function parseCodexStatusSnapshot(text, {
  now = new Date().toISOString(),
  limits = DEFAULT_CODEX_STATUS_LIMITS
} = {}) {
  const offsetMinutes = offsetMinutesFromNow(now);
  const windows = {};

  for (const line of stripTerminalControl(text).split(/\r?\n/)) {
    const parsed = parseLimitLine(line);
    if (!parsed || windows[parsed.name]) {
      continue;
    }

    const limitTokens = limits[parsed.name];
    if (!Number.isSafeInteger(limitTokens) || limitTokens <= 0) {
      throw new Error(`Missing Codex status token limit for ${parsed.name}`);
    }

    windows[parsed.name] = {
      remainingTokens: Math.floor((limitTokens * parsed.percentLeft) / 100),
      limitTokens,
      resetAt: resetAtIso(parsed.resetText, { now, offsetMinutes })
    };
  }

  if (Object.keys(windows).length === 0) {
    throw new Error('Codex status output did not include rate limit windows');
  }

  return { windows };
}

export async function captureCodexStatusText({
  codexCommand = 'codex',
  cwd = process.cwd(),
  timeoutMs = 60_000,
  settleMs = 500,
  env = process.env
} = {}) {
  const imported = await import('@homebridge/node-pty-prebuilt-multiarch');
  const pty = imported.default ?? imported;

  return await new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let shutdownStarted = false;
    let settleTimer = null;
    let timeoutTimer = null;
    let shutdownTimer = null;
    let statusAttempts = 0;
    let trustPromptAnswered = false;
    const startupTimers = new Set();

    const schedule = (callback, delayMs) => {
      const timer = setTimeout(() => {
        startupTimers.delete(timer);
        callback();
      }, delayMs);
      startupTimers.add(timer);
      return timer;
    };

    const hasStatus = () => STATUS_READY_PATTERN.test(stripTerminalControl(output));

    const safeWrite = (value) => {
      if (settled) {
        return;
      }
      try {
        terminal.write(value);
      } catch (error) {
        finish(error);
      }
    };

    const sendStatus = () => {
      if (settled || hasStatus()) {
        return;
      }
      statusAttempts += 1;
      safeWrite(codexStatusInput(output));
      if (statusAttempts < 12) {
        schedule(sendStatus, 5_000);
      }
    };

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(settleTimer);
      for (const timer of startupTimers) {
        clearTimeout(timer);
      }
      startupTimers.clear();
    };

    const forceKill = () => {
      try {
        silenceConptyConsoleListAgent(() => terminal.kill());
      } catch {
        // The process may already have exited.
      }
    };

    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();

      if (error) {
        forceKill();
        reject(error);
        return;
      }

      shutdownStarted = true;
      const capturedOutput = output;
      try {
        terminal.write('\x1b');
        setTimeout(() => {
          try {
            terminal.write('/quit\r');
          } catch {
            // The process may have exited after Escape.
          }
        }, 100);
      } catch {
        // Fall through to the shutdown timeout.
      }

      shutdownTimer = setTimeout(() => {
        forceKill();
        resolve(capturedOutput);
      }, 3_000);
    };

    const spawn = resolveCodexSpawn(codexCommand, env);
    const terminal = pty.spawn(spawn.file, spawn.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env
    });

    terminal.onData((chunk) => {
      output += chunk;
      const plainOutput = stripTerminalControl(output);

      if (!trustPromptAnswered && TRUST_PROMPT_PATTERN.test(plainOutput)) {
        trustPromptAnswered = true;
        schedule(() => safeWrite('\r'), 100);
      }

      if (statusAttempts === 0 && shouldAttemptCodexStatus(plainOutput)) {
        schedule(sendStatus, 100);
      }

      if (STATUS_READY_PATTERN.test(plainOutput) && settleTimer === null) {
        settleTimer = setTimeout(() => finish(), settleMs);
      }
    });

    terminal.onExit(({ exitCode }) => {
      if (shutdownStarted) {
        clearTimeout(shutdownTimer);
        resolve(output);
        return;
      }

      if (!hasStatus()) {
        finish(new Error(`Codex CLI exited before /status was captured (exit ${exitCode})`));
      }
    });

    timeoutTimer = setTimeout(() => {
      finish(new Error(`Timed out waiting for Codex CLI /status after ${timeoutMs}ms`));
    }, timeoutMs);

    schedule(sendStatus, 15_000);
  });
}
