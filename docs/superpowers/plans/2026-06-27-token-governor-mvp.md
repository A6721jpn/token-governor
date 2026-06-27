# Token Governor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal deterministic CLI gate that lets Codex choose the next Linear issue, then allows or holds that issue based on recent token burn and the current budget.

**Architecture:** Keep Linear issue selection outside the CLI. The CLI treats issue identifiers as opaque strings, persists local JSON state, predicts the next issue cost from recent completed issues, and exits with deterministic status codes.

**Tech Stack:** Node.js 20+ standard library, `node:test`, no runtime dependencies.

---

## File Structure

- `package.json`: package metadata, `bin` entry, test script.
- `src/governor.js`: pure decision logic and state helpers.
- `bin/token-governor.js`: command parsing and process exit codes.
- `test/governor.test.js`: behavior tests for prediction, budget decisions, and state updates.
- `README.md`: minimal install, command, and Codex app usage notes.

## Tasks

### Task 1: Bootstrap Metadata

- [x] Create this plan document.
- [x] Create `package.json`.
- [x] Commit and push the initial project metadata.

### Task 2: Decision Core By TDD

- [x] Write failing tests for p75 prediction, ALLOW, HOLD, and no-history handling.
- [x] Implement `src/governor.js` with pure functions only.
- [x] Run `node --test`.
- [ ] Commit and push the decision core.

### Task 3: CLI By TDD

- [x] Write failing CLI tests for `init`, `snapshot`, `check`, and `complete`.
- [x] Implement `bin/token-governor.js`.
- [x] Run `node --test` and smoke-test local CLI commands.
- [ ] Commit and push the CLI.

### Task 4: Minimal Docs

- [ ] Write `README.md` with the Codex app workflow and exit codes.
- [ ] Run final tests.
- [ ] Commit and push documentation.

## MVP Behavior

- `token-governor init`
- `token-governor snapshot --remaining <tokens> --reset-at <iso-time> [--reserve <tokens>]`
- `token-governor check <LINEAR-123>`
- `token-governor complete <LINEAR-123> --tokens <tokens>`

Decision rule:

- Use the last 10 completed issues.
- Predict with p75 of their token usage.
- Compute usable budget as `remainingTokens - reserveTokens`.
- Exit `0` with `ALLOW` when usable budget covers predicted usage.
- Exit `10` with `HOLD` when it does not.
- Exit `12` with `UNKNOWN` when there is no completion history.

Linear plugin policy:

- The official Linear plugin is not modified.
- The LLM still chooses the next Linear issue.
- The CLI only gates the selected issue.
- On HOLD, the correct next action is to stop and wait for the Codex limit reset, not search for another issue.
