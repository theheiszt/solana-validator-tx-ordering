import test from "node:test";
import assert from "node:assert/strict";
import { SpendGuard, DEFAULT_MAX_SPEND_LAMPORTS, verifyKeyHygiene } from "../src/utils/spend_guard.mjs";
import { encodeBase58, decodeBase58, parseComputeBudgetInstructions } from "../src/utils/base58.mjs";
import {
  spearmanRho,
  kendallTauDescending,
  windowedConcordance,
  contendedAccountConcordance
} from "../src/utils/stats.mjs";
import { buildControlledProbeBurst } from "../src/cli.mjs";

test("SpendGuard enforces hard 0.05 SOL (50,000,000 lamports) cap and blocks overspend", () => {
  const guard = new SpendGuard({ maxSpendLamports: DEFAULT_MAX_SPEND_LAMPORTS, liveMode: true });
  const r1 = guard.reserve(30_000_000, "batch_1");
  assert.equal(r1.remainingLamports, 20_000_000);
  guard.commit(30_000_000, 30_000_000, { batch: 1 });

  // Attempting to reserve 20,000,001 lamports must throw BEFORE sending
  assert.throws(() => {
    guard.reserve(20_000_001, "overspend_batch");
  }, /HARD FEE CAP EXCEEDED/);

  assert.equal(guard.summary().spentLamports, 30_000_000);
});

test("SpendGuard dry-run mode tracks reservations without incrementing live spentLamports", () => {
  const guard = new SpendGuard({ maxSpendLamports: 10_000_000, liveMode: false });
  const r = guard.reserve(25_000, "dry_probe");
  guard.commit(r.reservedLamports, 25_000, { probe: "dry" });
  assert.equal(guard.summary().spentLamports, 0);
  assert.equal(guard.summary().txCount, 1);
});

test("ComputeBudget Base58 encoder/decoder extracts SetComputeUnitLimit and SetComputeUnitPrice", () => {
  const limitBuf = Buffer.alloc(5);
  limitBuf.writeUInt8(2, 0);
  limitBuf.writeUInt32LE(140_000, 1);

  const priceBuf = Buffer.alloc(9);
  priceBuf.writeUInt8(3, 0);
  priceBuf.writeBigUInt64LE(250_000n, 1);

  const accountKeys = [
    "FeePayer11111111111111111111111111111111111",
    "ComputeBudget111111111111111111111111111111"
  ];
  const instructions = [
    { programIdIndex: 1, data: encodeBase58(limitBuf) },
    { programIdIndex: 1, data: encodeBase58(priceBuf) }
  ];

  const parsed = parseComputeBudgetInstructions(instructions, accountKeys);
  assert.equal(parsed.computeUnitLimit, 140_000);
  assert.equal(parsed.explicitComputeUnitLimit, true);
  assert.equal(parsed.computeUnitPriceMicroLamports, 250_000);
  assert.equal(parsed.hasExplicitPriorityFee, true);
});

test("Rank statistics distinguish strict descending priority order from arrival noise", () => {
  const descending = [500_000, 250_000, 100_000, 50_000, 10_000, 1_000];
  const negIdx = descending.map((_, i) => -i);
  const rho = spearmanRho(descending, negIdx);
  const kt = kendallTauDescending(descending);
  assert.ok(Math.abs(rho - 1.0) < 1e-9);
  assert.ok(Math.abs(kt.tauB - 1.0) < 1e-9);
  assert.equal(kt.strictConcordanceRate, 1.0);
});

test("Contended-account concordance isolates pairs sharing a hot writable account", () => {
  const mockTxs = [
    { blockIndex: 0, signature: "sig1", agavePriorityScore: 500_000, computeUnitPriceMicroLamports: 500_000, sharedWritableKeys: ["HotPoolA"] },
    { blockIndex: 1, signature: "sig2", agavePriorityScore: 10_000, computeUnitPriceMicroLamports: 10_000, sharedWritableKeys: ["UnrelatedB"] },
    { blockIndex: 2, signature: "sig3", agavePriorityScore: 100_000, computeUnitPriceMicroLamports: 100_000, sharedWritableKeys: ["HotPoolA"] },
    { blockIndex: 3, signature: "sig4", agavePriorityScore: 20_000, computeUnitPriceMicroLamports: 20_000, sharedWritableKeys: ["HotPoolA"] }
  ];
  const res = contendedAccountConcordance(mockTxs, 50);
  // Pairs on HotPoolA: (500k, 100k), (500k, 20k), (100k, 20k) -> all 3 concordant!
  assert.equal(res.concordant, 3);
  assert.equal(res.discordant, 0);
  assert.equal(res.concordanceRate, 1.0);
});

test("Controlled probe builder constructs ascending-fee inversion ladder and valid 32-byte SystemProgram pubkey", () => {
  assert.equal(decodeBase58("11111111111111111111111111111111").length, 32);
  const burst = buildControlledProbeBurst({
    validatorIdentity: "Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk",
    clientVersion: "4.4.0",
    targetLeaderSlot: 464543664,
    recentBlockhash: "11111111111111111111111111111111",
    burstMode: "SHARED_WRITABLE_CONTENTION",
    sharedStateAccount: "11111111111111111111111111111111"
  });
  assert.equal(burst.length, 4);
  assert.ok(burst[0].computeUnitPriceMicroLamports < burst[3].computeUnitPriceMicroLamports);
  assert.equal(burst[0].writableTargetAccount, burst[3].writableTargetAccount);
  assert.ok(burst[0].wireBase64.length > 100);
  assert.ok(burst[0].signature.length >= 80);
});
