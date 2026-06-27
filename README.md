# token-governor

Deterministic token-budget gate for Codex app workflows where an LLM selects a Linear issue and a CLI decides whether work may start.

The CLI does not choose Linear issues. It only gates the issue that was already selected.

## Requirements

- Node.js 20+

## Usage

Run from a project repository:

```sh
node bin/token-governor.js init
node bin/token-governor.js codex-status
node bin/token-governor.js check LIN-123 --refresh --codex-status
node bin/token-governor.js refresh --usage-file usage.json
node bin/token-governor.js check LIN-123 --refresh --usage-command "node scripts/codex-usage.js"
node bin/token-governor.js check LIN-123 --wait
node bin/token-governor.js complete LIN-123 --tokens 18000
```

By default, state is stored at `.token-governor/state.json` under the current working directory. Run the CLI from the project repository you are governing.

A first `snapshot` is recommended but not required. If no budget snapshot exists yet, `check` starts with built-in bootstrap windows so a new project does not stop at `remainingTokens: 0`:

- `fiveHour`: 200000 token limit, 90% cap, reset at now + 5 hours.
- `weekly`: 1000000 token limit, 95% cap, reset at now + 7 days.

If the CLI is launched from another directory, pass the governed project explicitly:

```sh
node /path/to/token-governor/bin/token-governor.js --project-dir /path/to/project check LIN-123
```

`TOKEN_GOVERNOR_PROJECT_DIR` can also set the governed project directory.

To store state elsewhere:

```sh
TOKEN_GOVERNOR_STATE=/path/to/state.json node bin/token-governor.js check LIN-123
```

`TOKEN_GOVERNOR_STATE` and `CODEX_GOVERNOR_STATE` override the project-local state path. Use them only when you intentionally want a custom state file.

## Usage Refresh

Use `refresh` to record the latest token budget before a check:

```sh
node bin/token-governor.js refresh --codex-status
node bin/token-governor.js refresh --usage-file usage.json
node bin/token-governor.js refresh --usage-command "node scripts/codex-usage.js"
```

Use `check --refresh --codex-status` in normal Codex workflows. It starts Codex CLI in a PTY, sends `/status`, parses the 5-hour and weekly reset windows, refreshes state, and then decides. If `--wait` sleeps until a reset, it refreshes again before the retry:

```sh
node bin/token-governor.js check LIN-123 --refresh --codex-status --wait --max-wait-seconds 14400
```

`codex-status` prints only the parsed usage snapshot:

```sh
node bin/token-governor.js codex-status
```

The parser reads the primary Codex model windows from output like:

```text
5h limit:     [█████████████████░░░] 87% left (resets 03:02)
Weekly limit: [████████████████░░░░] 82% left (resets 14:23 on 4 Jul)
```

The usage provider must print JSON:

```json
{
  "windows": {
    "fiveHour": {
      "remainingTokens": 150000,
      "limitTokens": 200000,
      "resetAt": "2026-06-27T05:00:00.000Z"
    },
    "weekly": {
      "remainingTokens": 950000,
      "limitTokens": 1000000,
      "resetAt": "2026-07-04T00:00:00.000Z"
    }
  }
}
```

`TOKEN_GOVERNOR_CODEX_STATUS=1` enables Codex CLI `/status` refresh without repeating `--codex-status`. `TOKEN_GOVERNOR_USAGE_FILE` and `TOKEN_GOVERNOR_USAGE_COMMAND` can set custom JSON providers when you do not want to launch Codex CLI.

## Codex App Workflow

1. Let Codex and the Linear plugin select the next issue.
2. Run `token-governor check <issue-id> --refresh --codex-status` before starting implementation.
3. If the result is `ALLOW`, start the selected issue.
4. If the result is `HOLD`, stop and wait for the Codex rate-limit reset. Do not search for another issue.
5. If the result is `UNKNOWN`, fix the missing or malformed state, then retry.
6. After finishing an issue, record actual usage with `complete`.

Use `check <issue-id> --wait` when Codex should park before the limit is exhausted. The CLI sleeps silently until the blocking window reset plus a small buffer, then checks the same issue again.

The default usage caps are:

- `fiveHour`: stop before crossing 90% of the 5-hour limit.
- `weekly`: stop before crossing 95% of the weekly limit.

To override them:

```sh
node bin/token-governor.js snapshot \
  --5h-remaining 150000 --5h-limit 200000 --5h-reset-at 2026-06-27T05:00:00.000Z --5h-max-usage-ratio 0.88 \
  --weekly-remaining 950000 --weekly-limit 1000000 --weekly-reset-at 2026-07-04T00:00:00.000Z --weekly-max-usage-ratio 0.93
```

The legacy single-budget form is still available:

```sh
node bin/token-governor.js snapshot --remaining 120000 --limit 200000 --reserve 20000 --reset-at 2026-06-28T00:00:00.000Z
```

## Decision Rule

- Use the last 10 completed issues.
- Predict the next issue with the p75 token usage from that history.
- If there is no completion history, use `coldStartTokens`. The default is `60000`.
- If no budget snapshot exists, bootstrap default 5-hour and weekly windows until a real snapshot is recorded.
- For each configured budget window, compute `usedTokens = limitTokens - remainingTokens`.
- Compute window usable budget as `floor(limitTokens * maxUsageRatio) - usedTokens`.
- Hold when the predicted next issue would cross any configured window cap.
- Report the blocking windows as `blockingWindows`.
- With the legacy single-budget form, compute usable budget as `remainingTokens - reserveTokens`.
- After `resetAt`, use `limitTokens - reserveTokens` when `--limit` was recorded.
- Allow work only when usable budget covers predicted usage.

Override the first-issue prediction only when the default is too high or too low for your project:

```sh
node bin/token-governor.js snapshot \
  --5h-remaining 150000 --5h-limit 200000 --5h-reset-at 2026-06-27T05:00:00.000Z \
  --weekly-remaining 950000 --weekly-limit 1000000 --weekly-reset-at 2026-07-04T00:00:00.000Z \
  --cold-start-tokens 45000
```

`check --wait` also accepts:

- `--buffer-seconds <seconds>`: extra time after `resetAt` before resuming. Defaults to `30`.
- `--max-wait-seconds <seconds>`: refuse long waits and return `HOLD` instead.

## Exit Codes

- `0`: success or `ALLOW`
- `10`: `HOLD`
- `12`: `UNKNOWN`
- `20`: invalid command, invalid arguments, or state-file error

## Test

```sh
node --test
```
