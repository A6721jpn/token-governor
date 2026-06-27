export function initialState() {
  return {
    version: 1,
    budget: {
      remainingTokens: null,
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

export function decideCheck(state, issueId) {
  const predictedTokens = predictTokens(state.history ?? []);

  if (predictedTokens === null) {
    return {
      status: 'UNKNOWN',
      exitCode: 12,
      issueId,
      reason: 'no_completion_history'
    };
  }

  const budget = state.budget ?? initialState().budget;
  const remainingTokens = Number(budget.remainingTokens ?? 0);
  const reserveTokens = Number(budget.reserveTokens ?? 0);
  const usableBudget = remainingTokens - reserveTokens;
  const base = {
    status: usableBudget >= predictedTokens ? 'ALLOW' : 'HOLD',
    exitCode: usableBudget >= predictedTokens ? 0 : 10,
    issueId,
    predictedTokens,
    usableBudget,
    remainingTokens,
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

export function updateSnapshot(state, snapshot) {
  return {
    ...state,
    budget: {
      remainingTokens: snapshot.remainingTokens,
      reserveTokens: snapshot.reserveTokens,
      resetAt: snapshot.resetAt,
      updatedAt: snapshot.now
    }
  };
}

export function appendCompletion(state, completion) {
  const budget = state.budget ?? initialState().budget;
  const remainingTokens = budget.remainingTokens === null
    ? null
    : Math.max(0, Number(budget.remainingTokens) - completion.tokens);

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
