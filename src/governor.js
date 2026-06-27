export function initialState() {
  return {
    version: 1,
    budget: {
      remainingTokens: null,
      limitTokens: null,
      reserveTokens: 0,
      resetAt: null,
      updatedAt: null
    },
    history: []
  };
}

export function predictTokens(history, sampleSize = 10) {
  const recent = [...history]
    .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)))
    .slice(-sampleSize)
    .map((entry) => entry.tokens)
    .sort((a, b) => a - b);

  if (recent.length === 0) {
    return null;
  }

  const index = Math.ceil(recent.length * 0.75) - 1;
  return recent[index];
}

function hasResetReached(resetAt, now) {
  if (!resetAt) {
    return false;
  }

  const resetTime = Date.parse(resetAt);
  const nowTime = Date.parse(now);
  return Number.isFinite(resetTime) && Number.isFinite(nowTime) && nowTime >= resetTime;
}

function normalizeBudget(budget) {
  return {
    ...initialState().budget,
    ...(budget ?? {})
  };
}

function effectiveRemainingTokens(budget, now) {
  const normalized = normalizeBudget(budget);
  const limitTokens = normalized.limitTokens ?? null;
  if (limitTokens !== null && hasResetReached(normalized.resetAt, now)) {
    return Number(limitTokens);
  }

  return normalized.remainingTokens === null
    ? null
    : Number(normalized.remainingTokens);
}

export function decideCheck(state, issueId, { now = new Date().toISOString() } = {}) {
  const predictedTokens = predictTokens(state.history ?? []);

  if (predictedTokens === null) {
    return {
      status: 'UNKNOWN',
      exitCode: 12,
      issueId,
      reason: 'no_completion_history'
    };
  }

  const budget = normalizeBudget(state.budget);
  const limitTokens = budget.limitTokens ?? null;
  const remainingTokens = effectiveRemainingTokens(budget, now) ?? 0;
  const reserveTokens = Number(budget.reserveTokens ?? 0);
  const usableBudget = remainingTokens - reserveTokens;
  const base = {
    status: usableBudget >= predictedTokens ? 'ALLOW' : 'HOLD',
    exitCode: usableBudget >= predictedTokens ? 0 : 10,
    issueId,
    predictedTokens,
    usableBudget,
    remainingTokens,
    limitTokens,
    reserveTokens,
    resetAt: budget.resetAt ?? null
  };

  if (base.status === 'HOLD') {
    return {
      ...base,
      reason: 'budget_insufficient'
    };
  }

  return base;
}

export function planWait(
  decision,
  { now = new Date().toISOString(), bufferSeconds = 30, maxWaitSeconds = null } = {}
) {
  if (decision.status !== 'HOLD') {
    return { shouldWait: false, reason: 'not_hold' };
  }

  if (!decision.resetAt) {
    return { shouldWait: false, reason: 'missing_reset_at' };
  }

  const resetTime = Date.parse(decision.resetAt);
  const nowTime = Date.parse(now);
  if (!Number.isFinite(resetTime) || !Number.isFinite(nowTime)) {
    return { shouldWait: false, reason: 'invalid_time' };
  }

  const waitUntilTime = resetTime + bufferSeconds * 1000;
  const waitMs = Math.max(0, waitUntilTime - nowTime);
  if (maxWaitSeconds !== null && waitMs > maxWaitSeconds * 1000) {
    return {
      shouldWait: false,
      reason: 'max_wait_exceeded',
      waitUntil: new Date(waitUntilTime).toISOString(),
      waitMs
    };
  }

  return {
    shouldWait: true,
    waitUntil: new Date(waitUntilTime).toISOString(),
    waitMs
  };
}

export function updateSnapshot(state, snapshot) {
  return {
    ...state,
    budget: {
      remainingTokens: snapshot.remainingTokens,
      limitTokens: snapshot.limitTokens ?? null,
      reserveTokens: snapshot.reserveTokens,
      resetAt: snapshot.resetAt,
      updatedAt: snapshot.now
    }
  };
}

export function appendCompletion(state, completion) {
  const budget = normalizeBudget(state.budget);
  const effectiveRemaining = effectiveRemainingTokens(budget, completion.completedAt);
  const remainingTokens = effectiveRemaining === null
    ? null
    : Math.max(0, effectiveRemaining - completion.tokens);

  return {
    ...state,
    budget: {
      ...budget,
      remainingTokens
    },
    history: [
      ...(state.history ?? []),
      {
        issueId: completion.issueId,
        tokens: completion.tokens,
        completedAt: completion.completedAt
      }
    ]
  };
}
