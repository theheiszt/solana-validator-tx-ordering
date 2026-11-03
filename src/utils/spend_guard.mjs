import fs from "fs";
import path from "path";

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const DEFAULT_MAX_SPEND_LAMPORTS = 50_000_000; // 0.05 SOL hard cap per specification

export class SpendGuard {
  /**
   * @param {object} opts
   * @param {number} [opts.maxSpendLamports=50000000]
   * @param {boolean} [opts.liveMode=false]
   * @param {string} [opts.ledgerPath]
   */
  constructor(opts = {}) {
    const cap = opts.maxSpendLamports ?? DEFAULT_MAX_SPEND_LAMPORTS;
    if (!Number.isInteger(cap) || cap <= 0 || cap > DEFAULT_MAX_SPEND_LAMPORTS) {
      throw new Error(
        `[SpendGuard] Invalid maxSpendLamports=${cap}. Must be a positive integer <= ${DEFAULT_MAX_SPEND_LAMPORTS} (0.05 SOL).`
      );
    }
    this.maxSpendLamports = cap;
    this.liveMode = Boolean(opts.liveMode);
    this.ledgerPath = opts.ledgerPath || null;
    this.spentLamports = 0;
    this.reservedLamports = 0;
    this.txHistory = [];

    if (this.ledgerPath && fs.existsSync(this.ledgerPath)) {
      try {
        const persisted = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8"));
        this.spentLamports = Number(persisted.spentLamports || 0);
        this.txHistory = Array.isArray(persisted.txHistory) ? persisted.txHistory : [];
      } catch {
        // Fresh ledger if corrupt
      }
    }
  }

  /**
   * Calculates exact worst-case fee in lamports for a Solana transaction:
   * Base fee (5000 lamports * numSignatures) + ceil(computeUnitLimit * microLamportsPerCu / 1e6)
   */
  static estimateMaxFeeLamports({
    numSignatures = 1,
    computeUnitLimit = 200_000,
    computeUnitPriceMicroLamports = 0
  }) {
    const baseFee = numSignatures * 5_000;
    const priorityFee = Math.ceil((computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000);
    return baseFee + priorityFee;
  }

  /**
   * Reserves budget before building/sending a transaction. Throws if cap would be exceeded.
   */
  reserve(estimatedFeeLamports, label = "probe_tx") {
    if (!Number.isFinite(estimatedFeeLamports) || estimatedFeeLamports < 0) {
      throw new Error(`[SpendGuard] Invalid fee estimate: ${estimatedFeeLamports}`);
    }
    const projectedTotal = this.spentLamports + this.reservedLamports + estimatedFeeLamports;
    if (projectedTotal > this.maxSpendLamports) {
      throw new Error(
        `[SpendGuard] HARD FEE CAP EXCEEDED on "${label}": projected ${projectedTotal} lamports (${(
          projectedTotal / LAMPORTS_PER_SOL
        ).toFixed(6)} SOL) > cap ${this.maxSpendLamports} lamports (${(
          this.maxSpendLamports / LAMPORTS_PER_SOL
        ).toFixed(6)} SOL). Aborting before send.`
      );
    }
    this.reservedLamports += estimatedFeeLamports;
    return {
      label,
      reservedLamports: estimatedFeeLamports,
      remainingLamports: this.maxSpendLamports - projectedTotal
    };
  }

  /**
   * Commits actual spent fee (or releases reservation on dry-run / simulation).
   */
  commit(reservedFeeLamports, actualFeeLamports, meta = {}) {
    this.reservedLamports = Math.max(0, this.reservedLamports - reservedFeeLamports);
    if (this.liveMode) {
      this.spentLamports += actualFeeLamports;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      mode: this.liveMode ? "LIVE" : "DRY_RUN",
      reservedFeeLamports,
      actualFeeLamports: this.liveMode ? actualFeeLamports : 0,
      simulatedFeeLamports: actualFeeLamports,
      cumulativeSpentLamports: this.spentLamports,
      ...meta
    };
    this.txHistory.push(entry);
    this._persist();
    return entry;
  }

  summary() {
    return {
      mode: this.liveMode ? "LIVE" : "DRY_RUN",
      maxSpendLamports: this.maxSpendLamports,
      maxSpendSol: this.maxSpendLamports / LAMPORTS_PER_SOL,
      spentLamports: this.spentLamports,
      spentSol: this.spentLamports / LAMPORTS_PER_SOL,
      reservedLamports: this.reservedLamports,
      remainingLamports: this.maxSpendLamports - (this.spentLamports + this.reservedLamports),
      remainingSol:
        (this.maxSpendLamports - (this.spentLamports + this.reservedLamports)) / LAMPORTS_PER_SOL,
      txCount: this.txHistory.length
    };
  }

  _persist() {
    if (!this.ledgerPath) return;
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.ledgerPath,
      JSON.stringify(
        {
          ...this.summary(),
          txHistory: this.txHistory
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

/**
 * Verifies that key material is loaded exclusively from env or an external volume path
 * and is never inside the tracked repository tree.
 */
export function verifyKeyHygiene(repoRoot) {
  const keyEnv = process.env.SOLANA_PRIVATE_KEY || "";
  const keyPath = process.env.SOLANA_KEYPAIR_PATH || "";

  if (keyPath) {
    const resolvedKey = path.resolve(keyPath);
    const resolvedRepo = path.resolve(repoRoot);
    if (
      resolvedKey.startsWith(resolvedRepo) &&
      !resolvedKey.includes(`${path.sep}keys_volume${path.sep}`)
    ) {
      throw new Error(
        `[SecurityGuard] SOLANA_KEYPAIR_PATH (${resolvedKey}) points inside the repository tree! Keys must only be mounted via external Docker volume or environment variable.`
      );
    }
  }

  return {
    hasEnvKey: keyEnv.length > 0,
    hasVolumeKeyPath: keyPath.length > 0,
    keySource: keyPath ? `volume:${keyPath}` : keyEnv ? "env:SOLANA_PRIVATE_KEY" : "ephemeral_dry_run_signer"
  };
}
