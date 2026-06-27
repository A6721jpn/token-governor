import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendCompletion,
  decideCheck,
  initialState,
  planWait,
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
      limitTokens: null,
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
    limitTokens: null,
    reserveTokens: 100,
    resetAt: '2026-06-27T12:00:00.000Z'
  });
});

test('decideCheck holds an issue when usable budget does not cover predicted usage', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 550,
      limitTokens: null,
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
    limitTokens: null,
    reserveTokens: 100,
    resetAt: '2026-06-27T12:00:00.000Z',
    reason: 'budget_insufficient'
  });
});

test('decideCheck holds before crossing the five hour usage cap', () => {
  const state = {
    ...initialState(),
    budget: {
      windows: {
        fiveHour: {
          remainingTokens: 150,
          limitTokens: 1_000,
          maxUsageRatio: 0.9,
          resetAt: '2026-06-27T05:00:00.000Z'
        }
      },
      updatedAt: '2026-06-27T00:00:00.000Z'
    },
    history: [
      { issueId: 'PK6-1', tokens: 60, completedAt: '2026-06-27T00:00:00.000Z' },
      { issueId: 'PK6-2', tokens: 60, completedAt: '2026-06-27T01:00:00.000Z' },
      { issueId: 'PK6-3', tokens: 60, completedAt: '2026-06-27T02:00:00.000Z' },
      { issueId: 'PK6-4', tokens: 60, completedAt: '2026-06-27T03:00:00.000Z' }
    ]
  };

  const result = decideCheck(state, 'PK6-5', { now: '2026-06-27T04:00:00.000Z' });

  assert.equal(result.status, 'HOLD');
  assert.equal(result.reason, 'budget_insufficient');
  assert.equal(result.usableBudget, 50);
  assert.deepEqual(result.blockingWindows, ['fiveHour']);
  assert.equal(result.resetAt, '2026-06-27T05:00:00.000Z');
});

test('decideCheck holds before crossing the weekly usage cap', () => {
  const state = {
    ...initialState(),
    budget: {
      windows: {
        fiveHour: {
          remainingTokens: 800,
          limitTokens: 1_000,
          maxUsageRatio: 0.9,
          resetAt: '2026-06-27T05:00:00.000Z'
        },
        weekly: {
          remainingTokens: 80,
          limitTokens: 1_000,
          maxUsageRatio: 0.95,
          resetAt: '2026-07-04T00:00:00.000Z'
        }
      },
      updatedAt: '2026-06-27T00:00:00.000Z'
    },
    history: [
      { issueId: 'PK6-1', tokens: 60, completedAt: '2026-06-27T00:00:00.000Z' },
      { issueId: 'PK6-2', tokens: 60, completedAt: '2026-06-27T01:00:00.000Z' },
      { issueId: 'PK6-3', tokens: 60, completedAt: '2026-06-27T02:00:00.000Z' },
      { issueId: 'PK6-4', tokens: 60, completedAt: '2026-06-27T03:00:00.000Z' }
    ]
  };

  const result = decideCheck(state, 'PK6-5', { now: '2026-06-27T04:00:00.000Z' });

  assert.equal(result.status, 'HOLD');
  assert.equal(result.usableBudget, 30);
  assert.deepEqual(result.blockingWindows, ['weekly']);
  assert.equal(result.resetAt, '2026-07-04T00:00:00.000Z');
});

test('decideCheck returns UNKNOWN when there is no completion history', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 1_000,
      limitTokens: null,
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
    limitTokens: 20_000,
    reserveTokens: 1_000,
    resetAt: '2026-06-27T12:00:00.000Z',
    now: '2026-06-27T01:00:00.000Z'
  });

  assert.deepEqual(state.budget, {
    remainingTokens: 12_345,
    limitTokens: 20_000,
    reserveTokens: 1_000,
    resetAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T01:00:00.000Z'
  });
});

test('decideCheck uses limitTokens after the reset time has passed', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 100,
      limitTokens: 1_000,
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

  assert.equal(
    decideCheck(state, 'PK6-5', { now: '2026-06-27T12:00:01.000Z' }).status,
    'ALLOW'
  );
});

test('planWait waits quietly until reset time plus buffer', () => {
  const plan = planWait(
    {
      status: 'HOLD',
      resetAt: '2026-06-27T12:00:00.000Z'
    },
    {
      now: '2026-06-27T11:59:00.000Z',
      bufferSeconds: 5
    }
  );

  assert.deepEqual(plan, {
    shouldWait: true,
    waitUntil: '2026-06-27T12:00:05.000Z',
    waitMs: 65_000
  });
});

test('planWait refuses waits beyond maxWaitSeconds', () => {
  const plan = planWait(
    {
      status: 'HOLD',
      resetAt: '2026-06-27T12:00:00.000Z'
    },
    {
      now: '2026-06-27T11:00:00.000Z',
      maxWaitSeconds: 60
    }
  );

  assert.equal(plan.shouldWait, false);
  assert.equal(plan.reason, 'max_wait_exceeded');
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

test('appendCompletion decrements from limitTokens after reset time has passed', () => {
  const state = updateSnapshot(initialState(), {
    remainingTokens: 100,
    limitTokens: 1_000,
    reserveTokens: 100,
    resetAt: '2026-06-27T12:00:00.000Z',
    now: '2026-06-27T01:00:00.000Z'
  });

  const updated = appendCompletion(state, {
    issueId: 'PK6-1',
    tokens: 300,
    completedAt: '2026-06-27T12:01:00.000Z'
  });

  assert.equal(updated.budget.remainingTokens, 700);
});

test('appendCompletion decrements every configured budget window', () => {
  const state = updateSnapshot(initialState(), {
    windows: {
      fiveHour: {
        remainingTokens: 900,
        limitTokens: 1_000,
        maxUsageRatio: 0.9,
        resetAt: '2026-06-27T05:00:00.000Z'
      },
      weekly: {
        remainingTokens: 4_000,
        limitTokens: 5_000,
        maxUsageRatio: 0.95,
        resetAt: '2026-07-04T00:00:00.000Z'
      }
    },
    now: '2026-06-27T01:00:00.000Z'
  });

  const updated = appendCompletion(state, {
    issueId: 'PK6-1',
    tokens: 300,
    completedAt: '2026-06-27T02:00:00.000Z'
  });

  assert.equal(updated.budget.windows.fiveHour.remainingTokens, 600);
  assert.equal(updated.budget.windows.weekly.remainingTokens, 3_700);
});
