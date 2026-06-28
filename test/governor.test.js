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

test('predictTokens uses an upper median for sparse completion history', () => {
  const history = [
    { issueId: 'PK6-140', tokens: 80_000, completedAt: '2026-06-27T16:35:42.361Z' },
    { issueId: 'PK6-141', tokens: 100_000, completedAt: '2026-06-27T17:44:43.699Z' },
    { issueId: 'PK6-144', tokens: 180_000, completedAt: '2026-06-27T18:39:13.581Z' }
  ];

  assert.equal(predictTokens(history), 100_000);
});

test('predictTokens excludes review bundle estimates from implementation predictions', () => {
  const history = [
    { issueId: 'PK6-140', tokens: 80_000, completedAt: '2026-06-27T16:35:42.361Z' },
    { issueId: 'PK6-141', tokens: 100_000, completedAt: '2026-06-27T17:44:43.699Z' },
    {
      issueId: 'PK6-144-review',
      kind: 'review',
      tokens: 180_000,
      tokensSource: 'review_bundle',
      completedAt: '2026-06-27T18:39:13.581Z'
    }
  ];

  assert.equal(predictTokens(history), 100_000);
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

test('decideCheck holds when five hour remaining is at or below 20 percent', () => {
  const state = {
    ...initialState(),
    budget: {
      windows: {
        fiveHour: {
          remainingTokens: 200,
          limitTokens: 1_000,
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
  assert.equal(result.reason, 'remaining_threshold_reached');
  assert.equal(result.windows[0].remainingRatio, 0.2);
  assert.equal(result.windows[0].minRemainingRatio, 0.2);
  assert.deepEqual(result.blockingWindows, ['fiveHour']);
  assert.equal(result.resetAt, '2026-06-27T05:00:00.000Z');
});

test('decideCheck allows when remaining ratio is above each window threshold even with a large prediction', () => {
  const state = {
    ...initialState(),
    budget: {
      windows: {
        fiveHour: {
          remainingTokens: 210,
          limitTokens: 1_000,
          resetAt: '2026-06-27T05:00:00.000Z'
        },
        weekly: {
          remainingTokens: 101,
          limitTokens: 1_000,
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

  assert.equal(result.status, 'ALLOW');
  assert.deepEqual(result.blockingWindows, []);
  assert.equal(result.resetAt, null);
});

test('decideCheck holds when weekly remaining is at or below 10 percent', () => {
  const state = {
    ...initialState(),
    budget: {
      windows: {
        fiveHour: {
          remainingTokens: 800,
          limitTokens: 1_000,
          resetAt: '2026-06-27T05:00:00.000Z'
        },
        weekly: {
          remainingTokens: 100,
          limitTokens: 1_000,
          resetAt: '2026-07-04T00:00:00.000Z'
        }
      },
      updatedAt: '2026-06-27T00:00:00.000Z'
    }
  };

  const result = decideCheck(state, 'PK6-5', { now: '2026-06-27T04:00:00.000Z' });

  assert.equal(result.status, 'HOLD');
  assert.equal(result.reason, 'remaining_threshold_reached');
  assert.equal(result.windows[1].remainingRatio, 0.1);
  assert.equal(result.windows[1].minRemainingRatio, 0.1);
  assert.deepEqual(result.blockingWindows, ['weekly']);
  assert.equal(result.resetAt, '2026-07-04T00:00:00.000Z');
});

test('decideCheck uses the default cold-start prediction when there is no completion history', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 100_000,
      limitTokens: null,
      reserveTokens: 100,
      resetAt: '2026-06-27T12:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z'
    }
  };

  assert.deepEqual(decideCheck(state, 'PK6-1'), {
    status: 'ALLOW',
    exitCode: 0,
    issueId: 'PK6-1',
    predictedTokens: 60_000,
    predictionSource: 'cold_start',
    usableBudget: 99_900,
    remainingTokens: 100_000,
    limitTokens: null,
    reserveTokens: 100,
    resetAt: '2026-06-27T12:00:00.000Z'
  });
});

test('decideCheck bootstraps default budget windows when no budget snapshot exists', () => {
  const result = decideCheck(initialState(), 'PK6-140', {
    now: '2026-06-27T00:00:00.000Z'
  });

  assert.equal(result.status, 'ALLOW');
  assert.equal(result.exitCode, 0);
  assert.equal(result.issueId, 'PK6-140');
  assert.equal(result.budgetSource, 'default_unconfigured');
  assert.deepEqual(result.blockingWindows, []);
  assert.equal(result.windows[0].name, 'fiveHour');
  assert.equal(result.windows[0].minRemainingRatio, 0.2);
  assert.equal(result.windows[0].resetAt, '2026-06-27T05:00:00.000Z');
  assert.equal(result.windows[1].name, 'weekly');
  assert.equal(result.windows[1].minRemainingRatio, 0.1);
  assert.equal(result.windows[1].resetAt, '2026-07-04T00:00:00.000Z');
});

test('decideCheck uses the default cold-start prediction for legacy null config', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 100_000,
      limitTokens: null,
      reserveTokens: 100,
      resetAt: '2026-06-27T12:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z'
    },
    prediction: {
      coldStartTokens: null
    }
  };

  const result = decideCheck(state, 'PK6-1');

  assert.equal(result.status, 'ALLOW');
  assert.equal(result.predictedTokens, 60_000);
  assert.equal(result.predictionSource, 'cold_start');
});

test('decideCheck uses cold-start tokens when there is no completion history', () => {
  const state = {
    ...initialState(),
    budget: {
      remainingTokens: 1_000,
      limitTokens: null,
      reserveTokens: 100,
      resetAt: '2026-06-27T12:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z'
    },
    prediction: {
      coldStartTokens: 700
    }
  };

  assert.deepEqual(decideCheck(state, 'PK6-1'), {
    status: 'ALLOW',
    exitCode: 0,
    issueId: 'PK6-1',
    predictedTokens: 700,
    predictionSource: 'cold_start',
    usableBudget: 900,
    remainingTokens: 1_000,
    limitTokens: null,
    reserveTokens: 100,
    resetAt: '2026-06-27T12:00:00.000Z'
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

test('appendCompletion records completion metadata separately from charged tokens', () => {
  const state = updateSnapshot(initialState(), {
    remainingTokens: 12_345,
    reserveTokens: 1_000,
    resetAt: '2026-06-27T12:00:00.000Z',
    now: '2026-06-27T01:00:00.000Z'
  });

  const updated = appendCompletion(state, {
    issueId: 'PK6-144',
    tokens: 2_000,
    kind: 'implementation',
    reviewBundleTokens: 180_000,
    elapsedMinutes: 72,
    startedAt: '2026-06-27T00:48:00.000Z',
    completedAt: '2026-06-27T02:00:00.000Z'
  });

  assert.equal(updated.budget.remainingTokens, 10_345);
  assert.deepEqual(updated.history, [
    {
      issueId: 'PK6-144',
      tokens: 2_000,
      kind: 'implementation',
      reviewBundleTokens: 180_000,
      elapsedMinutes: 72,
      startedAt: '2026-06-27T00:48:00.000Z',
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
