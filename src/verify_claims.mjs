import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import { rpcCall } from "./collect_mainnet_blocks.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function main() {
  const jsonPath = path.join(REPO_ROOT, "data", "raw", "mainnet_measurements.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Missing ${jsonPath}. Run 'npm run collect-mainnet' first.`);
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  console.log("================================================================================");
  console.log("  JUDGE VERIFIER: ON-CHAIN MAINNET getBlock REPRODUCIBILITY & SIGNATURE AUDIT   ");
  console.log("================================================================================");
  console.log(`Dataset Measured At : ${data.measurementMetadata.measuredAtUtc}`);
  console.log(`Mainnet Epoch       : ${data.measurementMetadata.epoch} (${data.measurementMetadata.alpenglowRegime})`);
  console.log(`Distinct Validators : ${data.measurementMetadata.distinctValidatorsCount} (Requirement: >= 6)`);
  console.log(
    `Distinct Forks      : ${data.measurementMetadata.distinctClientVersionsCount} [${data.measurementMetadata.distinctClientVersions.join(", ")}] (Requirement: >= 3)`
  );
  console.log(`Total Blocks        : ${data.measurementMetadata.totalBlocksAnalyzed}`);
  console.log(`Total Txs Inspected : ${data.measurementMetadata.totalTransactionsInspected.toLocaleString()}`);

  // Verify the first slot of up to 3 validators live against Mainnet getBlock
  const toVerify = data.validatorAnalyses.slice(0, 3);
  let verifiedTxCount = 0;

  for (const v of toVerify) {
    const firstBlock = v.blocks[0];
    if (!firstBlock) continue;
    const slot = firstBlock.slot;
    console.log(
      `\nVerifying Slot ${slot} (Validator ${v.validator.identity}, Version ${v.validator.version}) via live Mainnet getBlock...`
    );

    const liveBlock = await rpcCall("getBlock", [
      slot,
      {
        encoding: "json",
        transactionDetails: "signatures",
        maxSupportedTransactionVersion: 1,
        rewards: false
      }
    ]);

    if (!liveBlock || !Array.isArray(liveBlock.signatures)) {
      throw new Error(`Live getBlock(${slot}) returned no signatures.`);
    }

    if (liveBlock.signatures.length !== firstBlock.counts.totalTransactions) {
      throw new Error(
        `Mismatch in total transaction count for slot ${slot}: recorded=${firstBlock.counts.totalTransactions}, live=${liveBlock.signatures.length}`
      );
    }

    for (const sample of firstBlock.verifiableTxSamples) {
      const liveSig = liveBlock.signatures[sample.blockIndex];
      if (liveSig !== sample.signature) {
        throw new Error(
          `Signature mismatch at slot ${slot} blockIndex ${sample.blockIndex}: recorded=${sample.signature}, live=${liveSig}`
        );
      }
      verifiedTxCount++;
    }
    console.log(
      `  [PASS] Slot ${slot}: Total tx count (${liveBlock.signatures.length}) and all ${firstBlock.verifiableTxSamples.length} sampled signatures & block indices match Solana Mainnet 100%.`
    );
  }

  console.log(
    `\n[VERIFICATION COMPLETE] Audited ${verifiedTxCount} transaction signatures & exact block indices against live Solana Mainnet-Beta getBlock.`
  );
}

main().catch(err => {
  console.error("Verification failed:", err.message || err);
  process.exit(1);
});