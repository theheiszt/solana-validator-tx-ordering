/**
 * Statistical & Rank-Order Metrics for Intra-Block Transaction Ordering Analysis
 * Computes:
 * 1. Global Spearman's rho and Kendall's tau-b (Priority Score vs early block placement)
 * 2. Windowed / Sub-Batch Monotonicity (capturing BankingStage multi-thread tick batching)
 * 3. Account-Contention-Conditioned Pairwise Concordance (transactions sharing >=1 writable account)
 * 4. Priority Score comparisons:
 *    - Explicit SetComputeUnitPrice (micro-lamports / CU)
 *    - Effective Priority Fee per Requested CU ((fee - baseFee) * 1e6 / cuLimit)
 *    - Effective Total Fee per Consumed CU (fee * 1e6 / cuConsumed)
 */

export function averageRanks(values) {
  const n = values.length;
  const indexed = values.map((v, idx) => ({ v, idx }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && indexed[j + 1].v === indexed[i].v) {
      j++;
    }
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].idx] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation between array X and array Y.
 */
export function spearmanRho(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += rx[i];
    meanY += ry[i];
  }
  meanX /= n;
  meanY /= n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

/**
 * Tie-adjusted Kendall's tau-b between priority values and block ordering.
 * Here a pair (i < j) in block order is CONCORDANT with descending priority rule
 * if priority[i] > priority[j], DISCORDANT if priority[i] < priority[j], and TIED if equal.
 */
export function kendallTauDescending(priorities) {
  const n = priorities.length;
  if (n < 2) {
    return { tauB: 0, concordant: 0, discordant: 0, tiedPriority: 0, strictConcordanceRate: 0 };
  }
  let concordant = 0;
  let discordant = 0;
  let tiedPriority = 0;

  for (let i = 0; i < n; i++) {
    const pi = priorities[i];
    for (let j = i + 1; j < n; j++) {
      const pj = priorities[j];
      if (pi > pj) concordant++;
      else if (pi < pj) discordant++;
      else tiedPriority++;
    }
  }

  const totalPairs = (n * (n - 1)) / 2;
  const nonTied = concordant + discordant;
  const denom = Math.sqrt(totalPairs * nonTied);
  const tauB = denom === 0 ? 0 : (concordant - discordant) / denom;
  const strictConcordanceRate = nonTied === 0 ? 0.5 : concordant / nonTied;

  return {
    tauB,
    concordant,
    discordant,
    tiedPriority,
    nonTiedPairs: nonTied,
    strictConcordanceRate
  };
}

/**
 * Computes windowed (local micro-batch) concordance for pairs (i < j) within `windowSize` positions.
 * Why this matters: Agave's BankingStage pops packets from local thread priority queues in micro-batches
 * (PoH entries), whereas transactions 500 indices apart arrived at different network ticks (e.g. t=20ms vs t=320ms).
 */
export function windowedConcordance(priorities, windowSize = 25) {
  const n = priorities.length;
  let concordant = 0;
  let discordant = 0;
  let tied = 0;

  for (let i = 0; i < n; i++) {
    const pi = priorities[i];
    const limit = Math.min(n, i + 1 + windowSize);
    for (let j = i + 1; j < limit; j++) {
      const pj = priorities[j];
      if (pi > pj) concordant++;
      else if (pi < pj) discordant++;
      else tied++;
    }
  }

  const nonTied = concordant + discordant;
  return {
    windowSize,
    concordant,
    discordant,
    tied,
    nonTiedPairs: nonTied,
    concordanceRate: nonTied === 0 ? 0.5 : concordant / nonTied,
    localTau: nonTied === 0 ? 0 : (concordant - discordant) / nonTied
  };
}

/**
 * Computes pairwise priority concordance specifically for pairs of transactions (i < j)
 * that contend on at least one common hot writable account (excluding fee-payer-only if different,
 * and excluding native stateless programs).
 */
export function contendedAccountConcordance(txs, maxIndexGap = 80) {
  let concordant = 0;
  let discordant = 0;
  let tied = 0;
  const contendedExamples = [];

  for (let i = 0; i < txs.length; i++) {
    const ti = txs[i];
    if (!ti.sharedWritableKeys || ti.sharedWritableKeys.length === 0) continue;
    const setI = new Set(ti.sharedWritableKeys);
    const limit = Math.min(txs.length, i + 1 + maxIndexGap);

    for (let j = i + 1; j < limit; j++) {
      const tj = txs[j];
      if (!tj.sharedWritableKeys || tj.sharedWritableKeys.length === 0) continue;

      let sharedAccount = null;
      for (const k of tj.sharedWritableKeys) {
        if (setI.has(k)) {
          sharedAccount = k;
          break;
        }
      }
      if (!sharedAccount) continue;

      const pi = ti.agavePriorityScore;
      const pj = tj.agavePriorityScore;
      if (pi > pj) {
        concordant++;
        if (contendedExamples.length < 5) {
          contendedExamples.push({
            type: "CONCORDANT",
            sharedWritableAccount: sharedAccount,
            earlierTx: {
              blockIndex: ti.blockIndex,
              signature: ti.signature,
              priorityScore: ti.agavePriorityScore,
              cuPriceMicroLamports: ti.computeUnitPriceMicroLamports
            },
            laterTx: {
              blockIndex: tj.blockIndex,
              signature: tj.signature,
              priorityScore: tj.agavePriorityScore,
              cuPriceMicroLamports: tj.computeUnitPriceMicroLamports
            }
          });
        }
      } else if (pi < pj) {
        discordant++;
        if (contendedExamples.length < 8) {
          contendedExamples.push({
            type: "INVERSION",
            sharedWritableAccount: sharedAccount,
            earlierTx: {
              blockIndex: ti.blockIndex,
              signature: ti.signature,
              priorityScore: ti.agavePriorityScore,
              cuPriceMicroLamports: ti.computeUnitPriceMicroLamports
            },
            laterTx: {
              blockIndex: tj.blockIndex,
              signature: tj.signature,
              priorityScore: tj.agavePriorityScore,
              cuPriceMicroLamports: tj.computeUnitPriceMicroLamports
            }
          });
        }
      } else {
        tied++;
      }
    }
  }

  const nonTied = concordant + discordant;
  return {
    maxIndexGap,
    concordant,
    discordant,
    tied,
    nonTiedPairs: nonTied,
    concordanceRate: nonTied === 0 ? 0.5 : concordant / nonTied,
    contendedTau: nonTied === 0 ? 0 : (concordant - discordant) / nonTied,
    examples: contendedExamples
  };
}

/**
 * Divides a block's non-vote scheduler transactions into quartiles (Q1=earliest 25%, Q4=latest 25%)
 * and computes median & mean priority scores per quartile to detect top-of-block front-loading vs sawtooth.
 */
export function blockQuartileProfile(txs) {
  if (txs.length < 4) return [];
  const qSize = Math.floor(txs.length / 4);
  const quartiles = [];
  for (let q = 0; q < 4; q++) {
    const start = q * qSize;
    const end = q === 3 ? txs.length : (q + 1) * qSize;
    const slice = txs.slice(start, end);
    const scores = slice.map(t => t.agavePriorityScore).sort((a, b) => a - b);
    const median = scores[Math.floor(scores.length / 2)] || 0;
    const p75 = scores[Math.floor(scores.length * 0.75)] || 0;
    const p90 = scores[Math.floor(scores.length * 0.9)] || 0;
    const mean = scores.reduce((acc, v) => acc + v, 0) / (scores.length || 1);
    quartiles.push({
      quartile: `Q${q + 1}`,
      indexRange: [slice[0]?.blockIndex ?? start, slice[slice.length - 1]?.blockIndex ?? end - 1],
      txCount: slice.length,
      medianPriorityScore: Math.round(median),
      p75PriorityScore: Math.round(p75),
      p90PriorityScore: Math.round(p90),
      meanPriorityScore: Math.round(mean)
    });
  }
  return quartiles;
}
