import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendCompletion,
  decideCheck,
  initialState,
  predictTokens,
  updateSnapshot
} from '../src/governor.js';

test('predictTokens uses p75 from the last 10 completed issues', () => {
  const history = [
    10, 20, 30, 40, 50,
    60, 70, 80, 90, 100,
    1000
  ].map((tokens, index) => ({
    issueId: `PK6-${index + 1}`,
    tokens,
    completedAt: `2026-06-27T00:${String(index).padStart(2, '0')}:00.000Z`
  }));

  assert.equal(predictTokens(history), 90);
});

test('decideCheck allows an issue when usable budget covers predicted usage', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 1_000,
      reserveTokens: 100,
      resetAt: '2026-06-27T12:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z'
    },
    history: [
      { issueId: 'PK6-1', tokens: 300, completedAt: '2026-06-27T00:00:00.000Z' },
      { issueId: 'PK6-2', tokens: 400, completedAt: '2026-06-27T01:00:00.000Z' },
      { issueId: 'PK6-3', tokens: 500, completedAt: '2026-06-27T02:00:00.000Z' },
      { issueId: 'PK6-4', tokens: 600, completedAt: '2026-06-27T03:00:00.000Z' }
    ]
  };

  assert.deepEqual(decideCheck(state, 'PK6-5'), {
    status: 'ALLOW',
    exitCode: 0,
    issueId: 'PK6-5',
    predictedTokens: 500,
    usableBudget: 900,
    remainingTokens: 1_000,
    reserveTokens: 100,
    resetAt: '2026-06-27T12:00:00.000Z'
  });
});

test('decideCheck holds an issue when usable budget does not cover predicted usage', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 550,
      reserveTokens: 100,
      resetAt: '2026-06-27T12:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z'
    },
    history: [
      { issueId: 'PK6-1', tokens: 300, completedAt: '2026-06-27T00:00:00.000Z' },
      { issueId: 'PK6-2', tokens: 400, completedAt: '2026-06-27T01:00:00.000Z' },
      { issueId: 'PK6-3', tokens: 500, completedAt: '2026-06-27T02:00:00.000Z' },
      { issueId: 'PK6-4', tokens: 600, completedAt: '2026-06-27T03:00:00.000Z' }
    ]
  };

  assert.deepEqual(decideCheck(state, 'PK6-5'), {
    status: 'HOLD',
    exitCode: 10,
    issueId: 'PK6-5',
    predictedTokens: 500,
    usableBudget: 450,
    remainingTokens: 550,
    reserveTokens: 100,
    resetAt: '2026-06-27T12:00:00.000Z',
    reason: 'budget_insufficient'
  });
});

test('decideCheck returns UNKNOWN when there is no completion history', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 1_000,
      reserveTokens: 100,
      resetAt: '2026-06-27T12:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z'
    }
  };

  assert.deepEqual(decideCheck(state, 'PK6-1'), {
    status: 'UNKNOWN',
    exitCode: 12,
    issueId: 'PK6-1',
    reason: 'no_completion_history'
  });
});

test('updateSnapshot stores the current token budget', () => {
  const state = updateSnapshot(initialState(), {
    remainingTokens: 12_345,
    reserveTokens: 1_000,
    resetAt: '2026-06-27T12:00:00.000Z',
    now: '2026-06-27T01:00:00.000Z'
  });

  assert.deepEqual(state.budget, {
    remainingTokens: 12_345,
    reserveTokens: 1_000,
    resetAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T01:00:00.000Z'
  });
});

test('appendCompletion records completed issues and decrements known remaining tokens', () => {
  const state = updateSnapshot(initialState(), {
    remainingTokens: 12_345,
    reserveTokens: 1_000,
    resetAt: '2026-06-27T12:00:00.000Z',
    now: '2026-06-27T01:00:00.000Z'
  });

  const updated = appendCompletion(state, {
    issueId: 'PK6-1',
    tokens: 2_000,
    completedAt: '2026-06-27T02:00:00.000Z'
  });

  assert.equal(updated.budget.remainingTokens, 10_345);
  assert.deepEqual(updated.history, [
    {
      issueId: 'PK6-1',
      tokens: 2_000,
      completedAt: '2026-06-27T02:00:00.000Z'
    }
  ]);
});
