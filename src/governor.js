export const DEFAULT_COLD_START_TOKENS = 60_000;
export const DEFAULT_PREDICTION_KIND = 'implementation';

const REVIEW_KINDS = new Set([
  'review',
  'closure_review',
  'blocker_review',
  'post_ticket_review',
  'design_review'
]);

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
      coldStartTokens: DEFAULT_COLD_START_TOKENS
    },
    history: []
  };
}

function normalizeKind(kind) {
  if (kind === null || kind === undefined || kind === '') {
    return null;
  }

  return String(kind);
}

function normalizeRequestedKind(kind) {
  return normalizeKind(kind) ?? DEFAULT_PREDICTION_KIND;
}

function isReviewKind(kind) {
  const normalized = normalizeKind(kind);
  return normalized !== null && (REVIEW_KINDS.has(normalized) || normalized.endsWith('_review'));
}

function isPredictionEligibleEntry(entry, requestedKind) {
  const tokens = Number(entry.tokens);
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    return false;
  }

  if (entry.predictionEligible === false) {
    return false;
  }

  if (entry.tokensSource === 'review_bundle') {
    return false;
  }

  return !(normalizeRequestedKind(requestedKind) === DEFAULT_PREDICTION_KIND && isReviewKind(entry.kind));
}

function selectPredictionHistory(history, requestedKind) {
  const kind = normalizeRequestedKind(requestedKind);
  const eligible = [...history].filter((entry) => isPredictionEligibleEntry(entry, kind));
  const sameKind = eligible.filter((entry) => (normalizeKind(entry.kind) ?? DEFAULT_PREDICTION_KIND) === kind);

  return sameKind.length > 0 ? sameKind : eligible;
}

function sparseUpperMedian(sortedValues) {
  return sortedValues[Math.floor(sortedValues.length / 2)];
}

export function predictTokens(history, sampleSize = 10, { kind = DEFAULT_PREDICTION_KIND } = {}) {
  const recent = selectPredictionHistory(history, kind)
    .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)))
    .slice(-sampleSize)
    .map((entry) => Number(entry.tokens))
    .sort((a, b) => a - b);

  if (recent.length === 0) {
    return null;
  }

  if (recent.length < 5) {
    return sparseUpperMedian(recent);
  }

  const index = Math.ceil(recent.length * 0.75) - 1;
  return recent[index];
}

const DEFAULT_WINDOW_MIN_REMAINING_RATIOS = {
  fiveHour: 0.2,
  weekly: 0.1
};

const DEFAULT_BOOTSTRAP_BUDGET_WINDOWS = {
  fiveHour: {
    limitTokens: 200_000,
    durationMs: 5 * 60 * 60 * 1000
  },
  weekly: {
    limitTokens: 1_000_000,
    durationMs: 7 * 24 * 60 * 60 * 1000
  }
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
  const normalized = {
    ...initialState().prediction,
    ...(prediction ?? {})
  };

  return {
    ...normalized,
    coldStartTokens: normalized.coldStartTokens ?? DEFAULT_COLD_START_TOKENS
  };
}

function predictForState(state, { kind = DEFAULT_PREDICTION_KIND } = {}) {
  const historyPrediction = predictTokens(state.history ?? [], 10, { kind });
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

function addDuration(now, durationMs) {
  const parsed = Date.parse(now);
  const baseTime = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(baseTime + durationMs).toISOString();
}

function defaultBootstrapWindows(now) {
  return Object.fromEntries(
    Object.entries(DEFAULT_BOOTSTRAP_BUDGET_WINDOWS).map(([name, config]) => [
      name,
      {
        remainingTokens: config.limitTokens,
        limitTokens: config.limitTokens,
        reserveTokens: 0,
        minRemainingRatio: DEFAULT_WINDOW_MIN_REMAINING_RATIOS[name],
        resetAt: addDuration(now, config.durationMs)
      }
    ])
  );
}

function isBudgetUnconfigured(budget) {
  return !hasBudgetWindows(budget)
    && budget.remainingTokens === null
    && budget.limitTokens === null
    && Number(budget.reserveTokens ?? 0) === 0
    && budget.resetAt === null
    && budget.updatedAt === null;
}

function normalizeWindow(name, window) {
  return {
    remainingTokens: window.remainingTokens ?? null,
    limitTokens: window.limitTokens ?? null,
    reserveTokens: Number(window.reserveTokens ?? 0),
    minRemainingRatio: Number(window.minRemainingRatio ?? DEFAULT_WINDOW_MIN_REMAINING_RATIOS[name] ?? 0),
    ...(window.maxUsageRatio === undefined ? {} : { maxUsageRatio: Number(window.maxUsageRatio) }),
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
  const minRemainingRatio = Number(normalized.minRemainingRatio ?? 0);
  const thresholdTokens = limitTokens === null ? null : Math.floor(Number(limitTokens) * minRemainingRatio);
  const usableBudget = thresholdTokens === null
    ? remainingTokens - reserveTokens
    : remainingTokens - thresholdTokens - reserveTokens;
  const remainingRatio = limitTokens === null || Number(limitTokens) === 0
    ? null
    : remainingTokens / Number(limitTokens);

  return {
    name,
    remainingTokens,
    limitTokens,
    reserveTokens,
    minRemainingRatio,
    ...(normalized.maxUsageRatio === undefined ? {} : { maxUsageRatio: normalized.maxUsageRatio }),
    remainingRatio,
    thresholdTokens,
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

export function decideCheck(state, issueId, { now = new Date().toISOString(), kind = DEFAULT_PREDICTION_KIND } = {}) {
  const prediction = predictForState(state, { kind });

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
  const normalizedBudget = normalizeBudget(state.budget);
  const budgetIsUnconfigured = isBudgetUnconfigured(normalizedBudget);
  const budget = budgetIsUnconfigured
    ? {
      ...normalizedBudget,
      windows: defaultBootstrapWindows(now)
    }
    : normalizedBudget;
  const budgetFields = budgetIsUnconfigured
    ? { budgetSource: 'default_unconfigured' }
    : {};

  if (hasBudgetWindows(budget)) {
    const windows = Object.entries(normalizeWindows(budget.windows)).map(([name, window]) => (
      windowStatus(name, window, now)
    ));
    const usableBudget = Math.min(...windows.map((window) => window.usableBudget));
    const blocking = windows.filter((window) => (
      window.remainingRatio !== null && window.remainingRatio <= window.minRemainingRatio
    ));
    const base = {
      status: blocking.length === 0 ? 'ALLOW' : 'HOLD',
      exitCode: blocking.length === 0 ? 0 : 10,
      issueId,
      predictedTokens,
      ...predictionFields,
      ...budgetFields,
      usableBudget,
      windows,
      blockingWindows: blocking.map((window) => window.name),
      resetAt: blocking.length === 0 ? null : latestResetAt(blocking)
    };

    if (base.status === 'HOLD') {
      return {
        ...base,
        reason: 'remaining_threshold_reached'
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
    ...budgetFields,
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
  const prediction = normalizePrediction(state.prediction);
  if (snapshot.coldStartTokens === undefined) {
    return {
      ...state,
      prediction
    };
  }

  return {
    ...state,
    prediction: {
      ...prediction,
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
  const completionTokens = Number(completion.tokens);
  const historyEntry = {
    issueId: completion.issueId,
    tokens: completionTokens,
    completedAt: completion.completedAt
  };
  if (completion.kind !== undefined && completion.kind !== null) {
    historyEntry.kind = normalizeRequestedKind(completion.kind);
  }
  if (completion.reviewBundleTokens !== undefined && completion.reviewBundleTokens !== null) {
    historyEntry.reviewBundleTokens = Number(completion.reviewBundleTokens);
  }
  if (completion.tokensSource !== undefined && completion.tokensSource !== null) {
    historyEntry.tokensSource = String(completion.tokensSource);
  }
  if (completion.elapsedMinutes !== undefined && completion.elapsedMinutes !== null) {
    historyEntry.elapsedMinutes = Number(completion.elapsedMinutes);
  }
  if (completion.startedAt !== undefined && completion.startedAt !== null) {
    historyEntry.startedAt = completion.startedAt;
  }
  if (completion.predictionEligible === false) {
    historyEntry.predictionEligible = false;
  }

  const budget = normalizeBudget(state.budget);
  if (hasBudgetWindows(budget)) {
    const windows = Object.fromEntries(
      Object.entries(normalizeWindows(budget.windows)).map(([name, window]) => {
        const effectiveRemaining = effectiveWindowRemainingTokens(window, completion.completedAt);
        const remainingTokens = effectiveRemaining === null
          ? null
          : Math.max(0, effectiveRemaining - completionTokens);

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
        historyEntry
      ]
    };
  }

  const effectiveRemaining = effectiveRemainingTokens(budget, completion.completedAt);
  const remainingTokens = effectiveRemaining === null
    ? null
    : Math.max(0, effectiveRemaining - completionTokens);

  return {
    ...state,
    budget: {
      ...budget,
      remainingTokens
    },
    history: [
      ...(state.history ?? []),
      historyEntry
    ]
  };
}
