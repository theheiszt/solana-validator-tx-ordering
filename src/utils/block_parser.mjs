import { parseComputeBudgetInstructions } from "./base58.mjs";
import {
  spearmanRho,
  kendallTauDescending,
  windowedConcordance,
  contendedAccountConcordance,
  blockQuartileProfile
} from "./stats.mjs";

export const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

export const JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
]);

/**
 * Resolves full static + lookup-table account key list and identifies writable accounts
 * (excluding each tx's own fee payer at index 0 so we measure true shared state contention).
 */
export function extractAccountMetadata(txEntry) {
  const msg = txEntry.transaction?.message || {};
  const meta = txEntry.meta || {};
  const rawKeys = msg.accountKeys || [];
  const staticKeys = rawKeys.map(k => (typeof k === "string" ? k : k.pubkey));
  const loadedWritable = meta.loadedAddresses?.writable || [];
  const loadedReadonly = meta.loadedAddresses?.readonly || [];
  const allKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

  const writableSet = new Set();
  if (rawKeys.length > 0 && typeof rawKeys[0] === "object" && "writable" in rawKeys[0]) {
    rawKeys.forEach((k, idx) => {
      if (k.writable && idx > 0) writableSet.add(k.pubkey);
    });
  } else if (msg.header) {
    const {
      numRequiredSignatures = 1,
      numReadonlySignedAccounts = 0,
      numReadonlyUnsignedAccounts = 0
    } = msg.header;
    const numWritableSigned = Math.max(0, numRequiredSignatures - numReadonlySignedAccounts);
    const numUnsigned = Math.max(0, staticKeys.length - numRequiredSignatures);
    const numWritableUnsigned = Math.max(0, numUnsigned - numReadonlyUnsignedAccounts);

    // Signed writable (skip index 0 = fee payer so we only track shared state accounts)
    for (let i = 1; i < numWritableSigned; i++) {
      if (staticKeys[i]) writableSet.add(staticKeys[i]);
    }
    // Unsigned writable
    for (let i = numRequiredSignatures; i < numRequiredSignatures + numWritableUnsigned; i++) {
      if (staticKeys[i]) writableSet.add(staticKeys[i]);
    }
  }

  for (const w of loadedWritable) {
    writableSet.add(w);
  }

  return {
    allKeys,
    feePayer: staticKeys[0] || null,
    sharedWritableKeys: Array.from(writableSet)
  };
}

/**
 * Parses a full Solana Mainnet `getBlock` response and computes intra-block ordering metrics.
 */
export function analyzeMainnetBlock(slot, block, validatorMeta = {}) {
  const rawTxs = block?.transactions || [];
  let voteCount = 0;
  let jitoTipTxCount = 0;
  let failedSchedulerTxCount = 0;
  const schedulerTxs = [];
  const jitoTipIndices = [];

  for (let idx = 0; idx < rawTxs.length; idx++) {
    const txEntry = rawTxs[idx];
    const sig = txEntry.transaction?.signatures?.[0] || `slot_${slot}_idx_${idx}`;
    const numSignatures = txEntry.transaction?.signatures?.length || 1;
    const msg = txEntry.transaction?.message || {};
    const meta = txEntry.meta || {};
    const { allKeys, feePayer, sharedWritableKeys } = extractAccountMetadata(txEntry);

    // 1. Filter out Vote transactions
    if (allKeys.includes(VOTE_PROGRAM_ID)) {
      voteCount++;
      continue;
    }

    // 2. Identify and isolate Jito Tip / Bundle transactions per specification
    const touchesJitoTip = allKeys.some(k => JITO_TIP_ACCOUNTS.has(k));
    if (touchesJitoTip) {
      jitoTipTxCount++;
      jitoTipIndices.push(idx);
      continue;
    }

    const cb = parseComputeBudgetInstructions(msg.instructions || [], allKeys);
    const totalFeeLamports = Number(meta.fee ?? 5000 * numSignatures);
    const baseFeeLamports = 5000 * numSignatures;
    const priorityFeeLamports = Math.max(0, totalFeeLamports - baseFeeLamports);
    const cuConsumed = Number(meta.computeUnitsConsumed ?? cb.computeUnitLimit);
    const cuRequested = Math.max(1, cb.computeUnitLimit);

    // Agave's scheduler priority score (micro-lamports of validator reward per requested CU)
    // In Agave central/greedy scheduler: priority = SetComputeUnitPrice (micro-lamports/CU)
    // Fallback to effective priority fee / requested CU if SetComputeUnitPrice was not parsed
    const effectivePriorityMicroLamports = Math.round(
      (priorityFeeLamports * 1_000_000) / cuRequested
    );
    const agavePriorityScore =
      cb.computeUnitPriceMicroLamports > 0
        ? cb.computeUnitPriceMicroLamports
        : effectivePriorityMicroLamports;

    const effectiveFeePerConsumedCu = Math.round(
      (totalFeeLamports * 1_000_000) / Math.max(1, cuConsumed)
    );

    if (meta.err !== null && meta.err !== undefined) {
      failedSchedulerTxCount++;
    }

    schedulerTxs.push({
      slot,
      blockIndex: idx,
      schedulerOrderIndex: schedulerTxs.length,
      signature: sig,
      feePayer,
      numSignatures,
      totalFeeLamports,
      priorityFeeLamports,
      computeUnitLimit: cuRequested,
      explicitComputeUnitLimit: cb.explicitComputeUnitLimit,
      computeUnitsConsumed: cuConsumed,
      computeUnitPriceMicroLamports: cb.computeUnitPriceMicroLamports,
      agavePriorityScore,
      effectiveFeePerConsumedCu,
      succeeded: meta.err === null || meta.err === undefined,
      sharedWritableKeys
    });
  }

  // Filter out hotspots used by >1 tx in this block to keep sharedWritableKeys focused on true contended accounts
  const writableCounts = new Map();
  for (const tx of schedulerTxs) {
    for (const k of tx.sharedWritableKeys) {
      writableCounts.set(k, (writableCounts.get(k) || 0) + 1);
    }
  }
  for (const tx of schedulerTxs) {
    tx.sharedWritableKeys = tx.sharedWritableKeys.filter(k => (writableCounts.get(k) || 0) >= 2);
  }

  // Compute ordering correlations against (-schedulerOrderIndex) so positive = higher priority lands earlier
  const negIndices = schedulerTxs.map(t => -t.schedulerOrderIndex);
  const agaveScores = schedulerTxs.map(t => t.agavePriorityScore);
  const totalFeeScores = schedulerTxs.map(t => t.totalFeeLamports);
  const consumedCuScores = schedulerTxs.map(t => t.effectiveFeePerConsumedCu);

  const rhoAgavePriority = spearmanRho(agaveScores, negIndices);
  const rhoTotalFee = spearmanRho(totalFeeScores, negIndices);
  const rhoConsumedCu = spearmanRho(consumedCuScores, negIndices);

  const globalKendall = kendallTauDescending(agaveScores);
  const window15 = windowedConcordance(agaveScores, 15);
  const window40 = windowedConcordance(agaveScores, 40);
  const contentionStats = contendedAccountConcordance(schedulerTxs, 100);
  const quartiles = blockQuartileProfile(schedulerTxs);

  // Top hot writable accounts in this block
  const hotWritableAccounts = Array.from(writableCounts.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([account, txCount]) => ({ account, txCount }));

  // Sampled verifiable transactions across block positions (top, Q1, median, Q3, tail)
  const sampleIndices = [
    0,
    1,
    2,
    Math.floor(schedulerTxs.length * 0.1),
    Math.floor(schedulerTxs.length * 0.25),
    Math.floor(schedulerTxs.length * 0.5),
    Math.floor(schedulerTxs.length * 0.75),
    Math.floor(schedulerTxs.length * 0.9),
    Math.max(0, schedulerTxs.length - 2),
    Math.max(0, schedulerTxs.length - 1)
  ];
  const uniqueSampleIdx = Array.from(new Set(sampleIndices)).filter(
    i => i >= 0 && i < schedulerTxs.length
  );
  const verifiableTxSamples = uniqueSampleIdx.map(i => {
    const t = schedulerTxs[i];
    return {
      blockIndex: t.blockIndex,
      schedulerOrderIndex: t.schedulerOrderIndex,
      signature: t.signature,
      totalFeeLamports: t.totalFeeLamports,
      computeUnitLimit: t.computeUnitLimit,
      computeUnitsConsumed: t.computeUnitsConsumed,
      computeUnitPriceMicroLamports: t.computeUnitPriceMicroLamports,
      agavePriorityScore: t.agavePriorityScore,
      effectiveFeePerConsumedCu: t.effectiveFeePerConsumedCu,
      contendedWritableCount: t.sharedWritableKeys.length
    };
  });

  return {
    slot,
    blockTime: block?.blockTime
      ? new Date(block.blockTime * 1000).toISOString()
      : new Date().toISOString(),
    blockHeight: block?.blockHeight ?? null,
    parentSlot: block?.parentSlot ?? null,
    validator: validatorMeta,
    counts: {
      totalTransactions: rawTxs.length,
      voteTransactions: voteCount,
      jitoTipTransactions: jitoTipTxCount,
      schedulerTransactions: schedulerTxs.length,
      failedSchedulerTransactions: failedSchedulerTxCount
    },
    jitoBundlePlacementSummary: {
      jitoTxCount: jitoTipTxCount,
      medianBlockIndex:
        jitoTipIndices.length > 0
          ? jitoTipIndices[Math.floor(jitoTipIndices.length / 2)]
          : null,
      firstJitoBlockIndex: jitoTipIndices[0] ?? null,
      lastJitoBlockIndex: jitoTipIndices[jitoTipIndices.length - 1] ?? null
    },
    metrics: {
      spearmanRhoAgavePriority: Number(rhoAgavePriority.toFixed(4)),
      spearmanRhoTotalFee: Number(rhoTotalFee.toFixed(4)),
      spearmanRhoConsumedCuFee: Number(rhoConsumedCu.toFixed(4)),
      globalKendallTauB: Number(globalKendall.tauB.toFixed(4)),
      globalPairwiseConcordanceRate: Number(globalKendall.strictConcordanceRate.toFixed(4)),
      window15ConcordanceRate: Number(window15.concordanceRate.toFixed(4)),
      window15LocalTau: Number(window15.localTau.toFixed(4)),
      window40ConcordanceRate: Number(window40.concordanceRate.toFixed(4)),
      contendedAccountConcordanceRate: Number(contentionStats.concordanceRate.toFixed(4)),
      contendedAccountTau: Number(contentionStats.contendedTau.toFixed(4)),
      contendedNonTiedPairs: contentionStats.nonTiedPairs
    },
    quartiles,
    hotWritableAccounts,
    contendedPairExamples: contentionStats.examples,
    verifiableTxSamples
  };
}
