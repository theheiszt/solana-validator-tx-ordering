import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import { analyzeMainnetBlock } from "./utils/block_parser.mjs";

const MAINNET_RPC = process.env.SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com";

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function rpcCall(method, params = [], rpcUrl = MAINNET_RPC, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      if (res.status === 429) {
        await sleep(1500 * attempt);
        continue;
      }
      const json = await res.json();
      if (json.error) {
        if (attempt < retries && (json.error.code === -32005 || json.error.code === 429)) {
          await sleep(1200 * attempt);
          continue;
        }
        throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
      }
      return json.result;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1200 * attempt);
    }
  }
}

export function classifyClientFamily(version) {
  if (!version) return "Unknown";
  if (version.startsWith("26.10.")) return `CalVer-Fork (${version}) [Harmonic/BAM/Custom]`;
  if (version.startsWith("0.")) return `Firedancer/Frankendancer (${version})`;
  if (version.startsWith("4.5.")) return `Agave-Alpha (${version})`;
  if (version.startsWith("4.4.")) return `Agave-4.4 (${version}) [Next-Gen Scheduler]`;
  if (version === "4.3.2") return `Agave-4.3.2 (${version}) [Post-Alpenglow Baseline]`;
  if (version.startsWith("4.3.")) return `Agave-4.3.x (${version})`;
  if (version.startsWith("4.1.") || version.startsWith("4.2.")) return `Agave-4.1/4.2 (${version})`;
  if (version.startsWith("2.")) return `Agave-Legacy-2.x (${version})`;
  return `Solana-Fork (${version})`;
}

async function main() {
  console.log("[1/5] Querying Solana Mainnet Epoch Info & Cluster Nodes...");
  const epochInfo = await rpcCall("getEpochInfo", [{ commitment: "finalized" }]);
  console.log(
    `  Mainnet Epoch: ${epochInfo.epoch} | Finalized Slot: ${epochInfo.absoluteSlot} (Post-Alpenglow Upgrade)`
  );

  const clusterNodes = await rpcCall("getClusterNodes");
  const nodeMap = new Map();
  for (const n of clusterNodes) {
    if (n.pubkey && n.version) {
      nodeMap.set(n.pubkey, {
        identity: n.pubkey,
        version: n.version,
        clientFamily: classifyClientFamily(n.version),
        featureSet: n.featureSet ?? null,
        tpuQuic: n.tpuQuic ?? null,
        gossip: n.gossip ?? null
      });
    }
  }
  console.log(`  Indexed ${nodeMap.size} Mainnet nodes with version strings.`);

  // Scan back 600 slots from finalized tip to discover leaders across distinct client versions
  const windowSize = 450;
  const startSlot = epochInfo.absoluteSlot - windowSize;
  console.log(`[2/5] Fetching slot leaders for Mainnet slots ${startSlot}..${startSlot + windowSize}...`);
  const leaders = await rpcCall("getSlotLeaders", [startSlot, windowSize]);

  // Group candidate slots by validator identity and version
  const byVersionBucket = new Map();
  for (let offset = 0; offset < leaders.length; offset++) {
    const slot = startSlot + offset;
    const leaderPubkey = leaders[offset];
    const nodeInfo = nodeMap.get(leaderPubkey);
    if (!nodeInfo) continue;

    // Prefer middle slots of a 4-slot leader window (offset % 4 === 1 or 2) where block is full
    const v = nodeInfo.version;
    if (!byVersionBucket.has(v)) byVersionBucket.set(v, new Map());
    const valMap = byVersionBucket.get(v);
    if (!valMap.has(leaderPubkey)) {
      valMap.set(leaderPubkey, { nodeInfo, slots: [] });
    }
    valMap.get(leaderPubkey).slots.push(slot);
  }

  console.log(
    "  Discovered active leader versions in window:",
    Array.from(byVersionBucket.entries()).map(([v, m]) => `${v} (${m.size} validators)`)
  );

  // Target at least 8 validators across >= 4 distinct versions
  // Priority order of versions to ensure rich diversity across client forks:
  const preferredVersions = [
    "26.10.5",
    "26.10.4",
    "0.1.1",
    "4.5.0-alpha.4",
    "4.4.0",
    "4.4.0-rc.1",
    "4.3.2",
    "4.3.0",
    "2.3.8",
    "4.1.2",
    "4.2.2"
  ];

  const availableVersions = Array.from(byVersionBucket.keys());
  const orderedVersions = [
    ...preferredVersions.filter(v => byVersionBucket.has(v)),
    ...availableVersions.filter(v => !preferredVersions.includes(v))
  ];

  const selectedValidators = [];
  const usedPubkeys = new Set();

  // Pass 1: Pick up to 2 validators from each distinct version first
  for (const v of orderedVersions) {
    if (selectedValidators.length >= 8) break;
    const candidates = Array.from(byVersionBucket.get(v).values()).filter(
      c => c.slots.length >= 2 && !usedPubkeys.has(c.nodeInfo.identity)
    );
    for (const cand of candidates.slice(0, 2)) {
      if (selectedValidators.length >= 8) break;
      selectedValidators.push(cand);
      usedPubkeys.add(cand.nodeInfo.identity);
    }
  }

  // Pass 2: Top up to 8 validators if needed
  for (const v of orderedVersions) {
    if (selectedValidators.length >= 8) break;
    const candidates = Array.from(byVersionBucket.get(v).values()).filter(
      c => c.slots.length >= 1 && !usedPubkeys.has(c.nodeInfo.identity)
    );
    for (const cand of candidates) {
      if (selectedValidators.length >= 8) break;
      selectedValidators.push(cand);
      usedPubkeys.add(cand.nodeInfo.identity);
    }
  }

  console.log(
    `[3/5] Selected ${selectedValidators.length} Mainnet validators across ${
      new Set(selectedValidators.map(v => v.nodeInfo.version)).size
    } distinct client versions:`
  );
  for (const sv of selectedValidators) {
    console.log(
      `  - ${sv.nodeInfo.identity} | version=${sv.nodeInfo.version} (${sv.nodeInfo.clientFamily}) | candidate slots=${sv.slots.slice(0, 4).join(", ")}`
    );
  }

  console.log("[4/5] Fetching and analyzing real Mainnet blocks via getBlock...");
  const validatorAnalyses = [];
  const allSignatureRows = [];

  for (const sv of selectedValidators) {
    const analyzedBlocks = [];
    for (const candidateSlot of sv.slots) {
      if (analyzedBlocks.length >= 2) break;
      try {
        await sleep(650); // Polite rate-limiting for public Mainnet RPC
        const block = await rpcCall("getBlock", [
          candidateSlot,
          {
            encoding: "json",
            transactionDetails: "full",
            maxSupportedTransactionVersion: 1,
            rewards: false
          }
        ]);
        if (!block || !block.transactions || block.transactions.length < 30) {
          continue;
        }
        const parsed = analyzeMainnetBlock(candidateSlot, block, sv.nodeInfo);
        if (parsed.counts.schedulerTransactions < 15) continue;

        analyzedBlocks.push(parsed);
        console.log(
          `  [OK] Slot ${candidateSlot} | Leader ${sv.nodeInfo.identity.slice(0, 8)}.. (${
            sv.nodeInfo.version
          }) | Total=${parsed.counts.totalTransactions} Scheduler=${
            parsed.counts.schedulerTransactions
          } JitoTip=${parsed.counts.jitoTipTransactions} | rho=${
            parsed.metrics.spearmanRhoAgavePriority
          } win15=${parsed.metrics.window15ConcordanceRate} contended=${
            parsed.metrics.contendedAccountConcordanceRate
          }`
        );

        for (const s of parsed.verifiableTxSamples) {
          allSignatureRows.push({
            slot: candidateSlot,
            validatorIdentity: sv.nodeInfo.identity,
            clientVersion: sv.nodeInfo.version,
            clientFamily: sv.nodeInfo.clientFamily,
            blockIndex: s.blockIndex,
            schedulerOrderIndex: s.schedulerOrderIndex,
            signature: s.signature,
            totalFeeLamports: s.totalFeeLamports,
            computeUnitLimit: s.computeUnitLimit,
            computeUnitsConsumed: s.computeUnitsConsumed,
            computeUnitPriceMicroLamports: s.computeUnitPriceMicroLamports,
            agavePriorityScore: s.agavePriorityScore,
            effectiveFeePerConsumedCu: s.effectiveFeePerConsumedCu,
            contendedWritableCount: s.contendedWritableCount
          });
        }
      } catch (e) {
        // Slot might have been skipped; try next slot in leader window
        console.log(`  [SKIP] Slot ${candidateSlot}: ${e.message.slice(0, 80)}`);
      }
    }

    if (analyzedBlocks.length > 0) {
      // Compute aggregate stats for this validator
      const avg = fn =>
        Number(
          (
            analyzedBlocks.reduce((acc, b) => acc + fn(b), 0) / analyzedBlocks.length
          ).toFixed(4)
        );
      validatorAnalyses.push({
        validator: sv.nodeInfo,
        blocksAnalyzed: analyzedBlocks.length,
        slots: analyzedBlocks.map(b => b.slot),
        aggregateMetrics: {
          meanTotalTransactions: Math.round(avg(b => b.counts.totalTransactions)),
          meanSchedulerTransactions: Math.round(avg(b => b.counts.schedulerTransactions)),
          meanJitoTipTransactions: Math.round(avg(b => b.counts.jitoTipTransactions)),
          meanSpearmanRhoAgavePriority: avg(b => b.metrics.spearmanRhoAgavePriority),
          meanSpearmanRhoTotalFee: avg(b => b.metrics.spearmanRhoTotalFee),
          meanSpearmanRhoConsumedCuFee: avg(b => b.metrics.spearmanRhoConsumedCuFee),
          meanGlobalKendallTauB: avg(b => b.metrics.globalKendallTauB),
          meanGlobalPairwiseConcordanceRate: avg(b => b.metrics.globalPairwiseConcordanceRate),
          meanWindow15ConcordanceRate: avg(b => b.metrics.window15ConcordanceRate),
          meanWindow40ConcordanceRate: avg(b => b.metrics.window40ConcordanceRate),
          meanContendedAccountConcordanceRate: avg(
            b => b.metrics.contendedAccountConcordanceRate
          ),
          meanContendedAccountTau: avg(b => b.metrics.contendedAccountTau)
        },
        blocks: analyzedBlocks
      });
    }
  }

  const outDir = path.resolve("c:/Users/Miaz/Desktop/Bounty/projects/solana-validator-tx-ordering/data/raw");
  fs.mkdirSync(outDir, { recursive: true });

  const payload = {
    measurementMetadata: {
      project: "Inside the Block: How Solana Validators Order Transactions",
      network: "Solana Mainnet-Beta",
      rpcEndpoint: MAINNET_RPC,
      alpenglowRegime: "POST_ALPENGLOW (Post-Oct 21, 2026 Upgrade — Never Mixed)",
      measuredAtUtc: new Date().toISOString(),
      epoch: epochInfo.epoch,
      referenceAbsoluteSlot: epochInfo.absoluteSlot,
      distinctValidatorsCount: validatorAnalyses.length,
      distinctClientVersionsCount: new Set(validatorAnalyses.map(v => v.validator.version)).size,
      distinctClientVersions: Array.from(new Set(validatorAnalyses.map(v => v.validator.version))),
      totalBlocksAnalyzed: validatorAnalyses.reduce((acc, v) => acc + v.blocksAnalyzed, 0),
      totalTransactionsInspected: validatorAnalyses.reduce(
        (acc, v) => acc + v.blocks.reduce((s, b) => s + b.counts.totalTransactions, 0),
        0
      )
    },
    validatorAnalyses
  };

  const jsonPath = path.join(outDir, "mainnet_measurements.json");
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const csvHeader = [
    "slot",
    "validatorIdentity",
    "clientVersion",
    "clientFamily",
    "blockIndex",
    "schedulerOrderIndex",
    "signature",
    "totalFeeLamports",
    "computeUnitLimit",
    "computeUnitsConsumed",
    "computeUnitPriceMicroLamports",
    "agavePriorityScore",
    "effectiveFeePerConsumedCu",
    "contendedWritableCount"
  ].join(",");
  const csvLines = allSignatureRows.map(r =>
    [
      r.slot,
      r.validatorIdentity,
      r.clientVersion,
      `"${r.clientFamily}"`,
      r.blockIndex,
      r.schedulerOrderIndex,
      r.signature,
      r.totalFeeLamports,
      r.computeUnitLimit,
      r.computeUnitsConsumed,
      r.computeUnitPriceMicroLamports,
      r.agavePriorityScore,
      r.effectiveFeePerConsumedCu,
      r.contendedWritableCount
    ].join(",")
  );
  const csvPath = path.join(outDir, "verifiable_signatures.csv");
  fs.writeFileSync(csvPath, [csvHeader, ...csvLines].join("\n"), "utf8");

  console.log(`[5/5] Saved ${jsonPath} and ${csvPath} (${allSignatureRows.length} verifiable Mainnet tx signatures).`);
}

const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}