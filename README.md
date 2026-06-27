# token-governor

Deterministic token-budget gate for Codex app workflows where an LLM selects a Linear issue and a CLI decides whether work may start.

The CLI does not choose Linear issues. It only gates the issue that was already selected.

## Requirements

- Node.js 20+

## Usage

Run from a project repository:

```sh
node bin/token-governor.js init
node bin/token-governor.js snapshot --remaining 120000 --reserve 20000 --reset-at 2026-06-28T00:00:00.000Z
node bin/token-governor.js check LIN-123
node bin/token-governor.js complete LIN-123 --tokens 18000
```

By default, state is stored at `.token-governor/state.json`.

To store state elsewhere:

```sh
TOKEN_GOVERNOR_STATE=/path/to/state.json node bin/token-governor.js check LIN-123
```

`CODEX_GOVERNOR_STATE` is also accepted as an alias.

## Codex App Workflow

1. Let Codex and the Linear plugin select the next issue.
2. Run `token-governor check <issue-id>` before starting implementation.
3. If the result is `ALLOW`, start the selected issue.
4. If the result is `HOLD`, stop and wait for the Codex rate-limit reset. Do not search for another issue.
5. If the result is `UNKNOWN`, add completion history or stop until a human sets the policy.
6. After finishing an issue, record actual usage with `complete`.

## Decision Rule

- Use the last 10 completed issues.
- Predict the next issue with the p75 token usage from that history.
- Compute usable budget as `remainingTokens - reserveTokens`.
- Allow work only when usable budget covers predicted usage.

## Exit Codes

- `0`: success or `ALLOW`
- `10`: `HOLD`
- `12`: `UNKNOWN`
- `20`: invalid command, invalid arguments, or state-file error

## Test

```sh
node --test
```
