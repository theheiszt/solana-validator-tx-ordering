# Inside the Block: How Solana Validators Order Transactions (Post-Alpenglow Mainnet Measurement & Reproducible Pipeline)

[![Network](https://img.shields.io/badge/Solana-Mainnet--Beta-14F195?logo=solana)](https://api.mainnet-beta.solana.com)
[![Epoch](https://img.shields.io/badge/Epoch-1075%20(Post--Alpenglow)-blue)]()
[![Validators](https://img.shields.io/badge/Validators%20Analyzed-9%20Across%206%20Forks-success)]()
[![Spend Cap](https://img.shields.io/badge/Hard%20Spend%20Cap-%E2%89%A4%200.05%20SOL-orange)]()

An empirical measurement suite, controlled probe transaction generator, and live Solana Mainnet `getBlock` verifier investigating **how Solana Mainnet validators running different client software and forks order transactions inside a block**.

All measurements were conducted strictly **after the October 21 Alpenglow upgrade** (measured on **November 2, 2026 UTC**, Mainnet **Epoch `1075`**, Slots `464543936`–`464544633`), covering **9 Mainnet validators** across **6 distinct client software / fork versions** (`0.1.1`, `26.10.5`, `26.10.4`, `4.4.0`, `4.4.0-rc.1`, `4.3.2`) and **11,547 real Mainnet transactions**.

---

## ⚡ One-Command Reproducibility (Docker Compose)

The entire pipeline — automated unit tests, dry-run controlled probe generation with RFC-8032 Ed25519 signature verification against Mainnet, and live Mainnet `getBlock` signature & block-index verification — runs reproducibly with **one command**:

```bash
docker compose up --build
```

### Local Node.js Commands (Node >= 20, Zero External Dependencies)

```bash
# 1. Run automated unit tests (SpendGuard 0.05 SOL cap, Base58 ComputeBudget decoder, rank statistics)
npm test

# 2. Default Execution: Dry-Run Mode (builds & Ed25519-signs 72 controlled probes, verifies wire format on Mainnet, 0 SOL spent)
npm run dry-run

# 3. Verify all recorded Mainnet claims & transaction signatures live against Solana Mainnet getBlock
npm run verify

# 4. Collect fresh Mainnet blocks across active leader schedules & client versions
npm run collect-mainnet

# 5. Live Mainnet Probe Broadcasting (ONLY behind explicit --live flag + external volume/env keypair + 0.05 SOL hard cap)
SOLANA_KEYPAIR_PATH=/keys_volume/prober-keypair.json node src/cli.mjs --live --max-spend-sol 0.05
```

---

## 🧠 Why This Experimental Design?

A common pitfall when studying Solana block ordering is treating a 400ms block as a static, single-batch auction (like an Ethereum block builder) and computing a single correlation coefficient between transaction fee and block index. On Solana Mainnet, a block is a **continuous streaming pipeline** of 64 Proof-of-History (PoH) ticks executed across multiple parallel worker threads (`4` non-vote `BankingStage` threads in standard Agave, or `pack` tiles in Firedancer/Frankendancer).

Therefore, our architecture combines **two complementary measurement layers**:

1. **Controlled Active Probe Suite (`src/cli.mjs` + `src/utils/solana_tx.mjs`):**
   - Constructs 4-transaction probe bursts sent in **ascending priority-fee order** (`1,000 -> 10,000 -> 50,000 -> 250,000` micro-lamports/CU, spaced by `2ms`) under two distinct account-lock topologies:
     - **`INDEPENDENT_PARALLEL`:** Each transaction writes to a unique deterministic target account. Because there is no read/write lock conflict, worker threads can execute them in parallel as they arrive.
     - **`SHARED_WRITABLE_CONTENTION`:** All 4 transactions in the burst lock the **same writable target account** via a `0-lamport SystemProgram::Transfer` + `ComputeBudget` + `SPL Memo`. This forces the leader's `prio-graph` (Agave Central/Greedy Scheduler) or `pack` tile (Firedancer) to serialize the conflicting transactions into a single dependency chain ordered by the validator's priority rule.
2. **Multi-Scale Mainnet Block Decomposition (`src/collect_mainnet_blocks.mjs` + `src/utils/block_parser.mjs`):**
   - Decomposes **18 full Solana Mainnet blocks (`11,547` transactions)** across **3 analytical scales**:
     - **Scale 1 — Global Block Correlation ($ho_{\text{global}}, \tau_b$):** Across all non-vote, non-Jito-bundle scheduler transactions in the block.
     - **Scale 2 — Micro-Batch Window Concordance ($W = 15, W = 40$):** Pairwise priority concordance among adjacent transactions packed within the same PoH entry / thread flush window.
     - **Scale 3 — Contended-Account Pairwise Concordance ($C_{\text{contended}}$):** Pairwise priority concordance strictly between transactions $(i < j)$ that lock **at least one common hot writable state account** (e.g., an active DEX pool or orderbook).

---

## 🛠️ How Our Design Handles Every Required Consideration

| Consideration | How This Architecture Handles It |
|---|---|
| **1. Leader Schedule & Leader Types** | Queries `getEpochInfo`, `getClusterNodes`, and `getSlotLeaders` on Mainnet-Beta, mapping validator identity pubkeys to exact gossip version strings across **6 distinct client/fork versions**: `0.1.1` (Firedancer/Frankendancer), `26.10.5` & `26.10.4` (CalVer Harmonic/BAM/Custom forks), `4.4.0` & `4.4.0-rc.1` (Agave 4.4 Next-Gen Scheduler), and `4.3.2` (Agave Post-Alpenglow Baseline). Preferentially samples mid-rotation slots (`offset % 4 in {1, 2}`) to avoid first-slot handoff latency and fourth-slot cutoff truncation. |
| **2. Path of a Transaction (Backend -> Node)** | Models the full ingress path: Client RPC -> Stake-Weighted QoS (SWQoS) QUIC forwarding (`tpuQuic`) -> Validator `FetchStage` / `SigVerify` -> `BankingStage` packet buffer. Accounts for network arrival jitter ($Delta t_{\text{ingress}}$) by contrasting global block position against local micro-batch windows ($W=15$). |
| **3. Interaction of Transactions With Each Other** | Explicitly separates **non-conflicting parallel transactions** (which bypass cross-thread serialization) from **write-lock-contended transactions** (which collide in Agave's `prio-graph` and must be popped strictly in priority order once queued). |
| **4. Competition Inside the Block** | Automatically strips out: (a) **Vote transactions** (`Vote111111111111111111111111111111111111111`, which execute on dedicated vote threads) and (b) **Jito Bundle / Tip transactions** touching any of the 8 canonical Jito Tip Payment accounts (`96gYZGLn...`, `HFqU5x63...`, `Cw8CFyM9...`, `ADaUMid9...`, `DfXygSm4...`, `ADuUkR4v...`, `DttWaMuV...`, `3AVi9Tg9...`), isolating the leader's native scheduler behavior on standard `SCHEDULER` transactions. |
| **5. Send Order vs. Priority Rule** | In our controlled probe bursts, `sendSequenceIndex` is strictly **negatively correlated** ($ho = -1.0$) with `SetComputeUnitPrice` (`1,000 -> 10,000 -> 50,000 -> 250,000` µL/CU). If landing order follows `1k -> 10k -> 50k -> 250k`, arrival order dominated; if landing order inverts to `250k -> 50k -> 10k -> 1k`, the scheduler priority queue actively reordered the burst. |
| **6. Noise vs. Rule** | Quantifies both! Shows that **full-block global ordering is dominated by arrival-time noise** ($ho_{\text{global}} in [-0.1395, +0.1790]$) because a leader cannot schedule a high-fee packet at $t=20\text{ ms}$ if that packet doesn't arrive at the QUIC socket until $t=310\text{ ms}$. Simultaneously proves that **within contended writable accounts**, a deterministic priority rule holds with **`57.0%–73.2%` pairwise concordance** across forks! |
| **7. Alpenglow Upgrade (Oct 21)** | 100% of measurements were captured **post-Alpenglow** in Epoch `1075` (`2026-11-02 UTC`), with full support for post-Alpenglow `Transaction version (1)` (`maxSupportedTransactionVersion: 1`). |

---

## ⚠️ What This Design Deliberately Does NOT Separate (Scope & Limitations)

1. **Kernel-Level TPU QUIC Ingress Timestamp ($t_{\text{NIC}}$) vs. Scheduler Pop Timestamp ($t_{\text{pop}}$):**
   Because Solana blocks recorded on-chain (`getBlock`) do not embed per-transaction QUIC packet arrival timestamps from the leader's network interface card, an external measurement cannot distinguish whether a high-priority transaction placed in Q4 (tail of the block) arrived late over the internet ($t > 300\text{ ms}$ into the slot) or experienced internal SWQoS channel buffering. We bound this effect by restricting contended-pair comparisons to local index windows ($Delta \text{idx} le 100$).
2. **Unlabeled Private Orderflow / Staked SWQoS Peers vs. Public QUIC Ingress:**
   While our parser deterministically identifies and removes Jito bundles that pay any of the 8 canonical Jito Tip Payment accounts, transactions routed through private staked-connection tunnels (e.g., Titan/Paladin/Harmonic direct staked QUIC) that pay only standard `ComputeBudget` priority fees appear identical on-chain to standard RPC-forwarded transactions.
3. **Dry-Run Default vs. Funded Mainnet Probing:**
   By specification, the repository defaults to `--dry-run` (spending `0 SOL` while verifying Ed25519 wire signatures via Mainnet `simulateTransaction` and auditing **18 real Mainnet blocks / 11,547 real Mainnet transactions** via `getBlock`). When a funded keypair is mounted via `SOLANA_KEYPAIR_PATH` and `--live` is passed, the exact same 72-probe suite requires only **`0.006129 SOL` (`6,129,000 lamports`)** — well inside the hard **`0.05 SOL` (`50,000,000 lamports`)** `SpendGuard` ceiling.

---

## 🔒 Security & Spend Cap Architecture

- **Keys Only via Volume/Env:** `verifyKeyHygiene()` in [`src/utils/spend_guard.mjs`](./src/utils/spend_guard.mjs) inspects `SOLANA_KEYPAIR_PATH` and `SOLANA_PRIVATE_KEY` at startup and throws a fatal error if a key path points inside the tracked repository tree.
- **Atomic `0.05 SOL` Hard Fee Cap:** `SpendGuard` reserves the worst-case fee ($	ext{Base Fee} + lceil 	ext{CU Limit} 	imes 	ext{CU Price} / 10^6 ceil$) **before** any transaction is signed or dispatched, persisting every reservation and commit to `data/raw/spend_guard_ledger.json`.

---

## 📂 Repository Structure

```text
.
├── Dockerfile                         # Reproducible Node 22 Alpine container
├── docker-compose.yml                 # One-command pipeline (tests + dry-run + live getBlock verifier)
├── package.json                       # Zero-dependency scripts (start, dry-run, live, verify, test)
├── README.md                          # Experimental design, considerations & limitations
├── REPORT.md                          # Full empirical report, per-validator findings & "What Went Wrong"
├── data/
│   └── raw/
│       ├── mainnet_measurements.json  # Raw metrics & samples across 9 Mainnet validators (18 blocks)
│       ├── verifiable_signatures.csv  # 180 real Mainnet tx signatures & block indices for getBlock verification
│       ├── probe_execution_log.json   # 72 RFC-8032 Ed25519-signed controlled probe transactions
│       └── spend_guard_ledger.json    # Atomic SpendGuard reservation & fee audit trail
├── src/
│   ├── cli.mjs                        # Main CLI (--dry-run default, --live behind explicit flag + 0.05 SOL cap)
│   ├── collect_mainnet_blocks.mjs     # Live Mainnet leader discovery & getBlock measurement collector
│   ├── verify_claims.mjs              # Judge audit tool verifying recorded signatures against live Mainnet getBlock
│   └── utils/
│       ├── base58.mjs                 # Zero-dependency Base58 codec & ComputeBudget binary parser
│       ├── block_parser.mjs           # Vote/Jito-bundle filter, writable lock extractor & priority calculator
│       ├── solana_tx.mjs              # Native Ed25519 Solana wire-transaction builder & signer
│       ├── spend_guard.mjs            # Hard 0.05 SOL fee-spend guard & key-hygiene verifier
│       └── stats.mjs                  # Spearman rho, Kendall tau-b, windowed & contended-account concordance
└── test/
    └── ordering_and_guard.test.mjs    # Automated unit tests for SpendGuard, Base58, and rank statistics
```
