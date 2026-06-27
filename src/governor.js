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
    prediction: {
      coldStartTokens: null
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

const DEFAULT_WINDOW_USAGE_RATIOS = {
  fiveHour: 0.9,
  weekly: 0.95
};

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

function normalizePrediction(prediction) {
  return {
    ...initialState().prediction,
    ...(prediction ?? {})
  };
}

function predictForState(state) {
  const historyPrediction = predictTokens(state.history ?? []);
  if (historyPrediction !== null) {
    return {
      tokens: historyPrediction,
      source: 'history'
    };
  }

  const coldStartTokens = normalizePrediction(state.prediction).coldStartTokens;
  if (coldStartTokens === null || coldStartTokens === undefined) {
    return null;
  }

  return {
    tokens: Number(coldStartTokens),
    source: 'cold_start'
  };
}

function hasBudgetWindows(budget) {
  const windows = budget?.windows;
  return Boolean(windows) && Object.keys(windows).length > 0;
}

function normalizeWindow(name, window) {
  return {
    remainingTokens: window.remainingTokens ?? null,
    limitTokens: window.limitTokens ?? null,
    reserveTokens: Number(window.reserveTokens ?? 0),
    maxUsageRatio: Number(window.maxUsageRatio ?? DEFAULT_WINDOW_USAGE_RATIOS[name] ?? 1),
    resetAt: window.resetAt ?? null
  };
}

function normalizeWindows(windows) {
  return Object.fromEntries(
    Object.entries(windows ?? {}).map(([name, window]) => [name, normalizeWindow(name, window)])
  );
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

function effectiveWindowRemainingTokens(window, now) {
  const limitTokens = window.limitTokens ?? null;
  if (limitTokens !== null && hasResetReached(window.resetAt, now)) {
    return Number(limitTokens);
  }

  return window.remainingTokens === null
    ? null
    : Number(window.remainingTokens);
}

function windowStatus(name, window, now) {
  const normalized = normalizeWindow(name, window);
  const remainingTokens = effectiveWindowRemainingTokens(normalized, now) ?? 0;
  const limitTokens = normalized.limitTokens ?? null;
  const reserveTokens = Number(normalized.reserveTokens ?? 0);
  const maxUsageRatio = Number(normalized.maxUsageRatio ?? 1);
  const usableBudget = limitTokens === null
    ? remainingTokens - reserveTokens
    : Math.floor(Number(limitTokens) * maxUsageRatio)
      - (Number(limitTokens) - remainingTokens)
      - reserveTokens;

  return {
    name,
    remainingTokens,
    limitTokens,
    reserveTokens,
    maxUsageRatio,
    usableBudget,
    resetAt: normalized.resetAt
  };
}

function latestResetAt(windows) {
  const validTimes = windows
    .map((window) => Date.parse(window.resetAt))
    .filter(Number.isFinite);

  if (validTimes.length === 0) {
    return null;
  }

  return new Date(Math.max(...validTimes)).toISOString();
}

export function decideCheck(state, issueId, { now = new Date().toISOString() } = {}) {
  const prediction = predictForState(state);

  if (prediction === null) {
    return {
      status: 'UNKNOWN',
      exitCode: 12,
      issueId,
      reason: 'no_completion_history'
    };
  }

  const predictedTokens = prediction.tokens;
  const predictionFields = prediction.source === 'cold_start'
    ? { predictionSource: 'cold_start' }
    : {};
  const budget = normalizeBudget(state.budget);
  if (hasBudgetWindows(budget)) {
    const windows = Object.entries(normalizeWindows(budget.windows)).map(([name, window]) => (
      windowStatus(name, window, now)
    ));
    const usableBudget = Math.min(...windows.map((window) => window.usableBudget));
    const blocking = windows.filter((window) => window.usableBudget < predictedTokens);
    const base = {
      status: blocking.length === 0 ? 'ALLOW' : 'HOLD',
      exitCode: blocking.length === 0 ? 0 : 10,
      issueId,
      predictedTokens,
      ...predictionFields,
      usableBudget,
      windows,
      blockingWindows: blocking.map((window) => window.name),
      resetAt: blocking.length === 0 ? null : latestResetAt(blocking)
    };

    if (base.status === 'HOLD') {
      return {
        ...base,
        reason: 'budget_insufficient'
      };
    }

    return base;
  }

  const limitTokens = budget.limitTokens ?? null;
  const remainingTokens = effectiveRemainingTokens(budget, now) ?? 0;
  const reserveTokens = Number(budget.reserveTokens ?? 0);
  const usableBudget = remainingTokens - reserveTokens;
  const base = {
    status: usableBudget >= predictedTokens ? 'ALLOW' : 'HOLD',
    exitCode: usableBudget >= predictedTokens ? 0 : 10,
    issueId,
    predictedTokens,
    ...predictionFields,
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

function applyPredictionSnapshot(state, snapshot) {
  if (snapshot.coldStartTokens === undefined) {
    return state;
  }

  return {
    ...state,
    prediction: {
      ...normalizePrediction(state.prediction),
      coldStartTokens: snapshot.coldStartTokens
    }
  };
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
  if (snapshot.windows) {
    return applyPredictionSnapshot({
      ...state,
      budget: {
        windows: normalizeWindows(snapshot.windows),
        updatedAt: snapshot.now
      }
    }, snapshot);
  }

  return applyPredictionSnapshot({
    ...state,
    budget: {
      remainingTokens: snapshot.remainingTokens,
      limitTokens: snapshot.limitTokens ?? null,
      reserveTokens: snapshot.reserveTokens,
      resetAt: snapshot.resetAt,
      updatedAt: snapshot.now
    }
  }, snapshot);
}

export function appendCompletion(state, completion) {
  const budget = normalizeBudget(state.budget);
  if (hasBudgetWindows(budget)) {
    const windows = Object.fromEntries(
      Object.entries(normalizeWindows(budget.windows)).map(([name, window]) => {
        const effectiveRemaining = effectiveWindowRemainingTokens(window, completion.completedAt);
        const remainingTokens = effectiveRemaining === null
          ? null
          : Math.max(0, effectiveRemaining - completion.tokens);

        return [
          name,
          {
            ...window,
            remainingTokens
          }
        ];
      })
    );

    return {
      ...state,
      budget: {
        ...budget,
        windows
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
