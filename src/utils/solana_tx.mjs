import crypto from "crypto";
import { decodeBase58, encodeBase58 } from "./base58.mjs";

export const COMPUTE_BUDGET_PUBKEY = decodeBase58("ComputeBudget111111111111111111111111111111");
export const MEMO_PROGRAM_PUBKEY = decodeBase58("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const SYSTEM_PROGRAM_PUBKEY = decodeBase58("11111111111111111111111111111111");

/**
 * Generates or imports a Solana Ed25519 keypair using Node's native crypto module.
 * @param {Uint8Array} [seed32] Optional 32-byte secret seed (or first 32 bytes of 64-byte Solana keypair array)
 */
export function createSolanaKeypair(seed32 = null) {
  let privateKeyObj;
  if (seed32) {
    // PKCS#8 DER prefix for Ed25519 32-byte private seed
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const der = Buffer.concat([pkcs8Prefix, Buffer.from(seed32.slice(0, 32))]);
    privateKeyObj = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } else {
    const pair = crypto.generateKeyPairSync("ed25519");
    privateKeyObj = pair.privateKey;
  }
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  // SPKI DER for Ed25519 has a 12-byte header followed by the 32-byte raw public key
  const spkiDer = publicKeyObj.export({ format: "der", type: "spki" });
  const pubkeyBytes = new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
  const pkcs8Der = privateKeyObj.export({ format: "der", type: "pkcs8" });
  const secretSeed32 = new Uint8Array(pkcs8Der.subarray(pkcs8Der.length - 32));

  return {
    publicKeyBytes: pubkeyBytes,
    publicKeyBase58: encodeBase58(pubkeyBytes),
    secretSeed32,
    sign(messageBytes) {
      return new Uint8Array(crypto.sign(null, Buffer.from(messageBytes), privateKeyObj));
    }
  };
}

function encodeCompactU16(len) {
  const out = [];
  let rem = len;
  while (true) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      break;
    } else {
      elem |= 0x80;
      out.push(elem);
    }
  }
  return Buffer.from(out);
}

/**
 * Builds and signs a real Solana wire transaction containing:
 *  1. ComputeBudget::SetComputeUnitLimit(computeUnitLimit)
 *  2. ComputeBudget::SetComputeUnitPrice(computeUnitPriceMicroLamports)
 *  3. SystemProgram::Transfer(0 lamports to writableTargetPubkey) — locks writableTargetPubkey as WRITABLE!
 *  4. MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr (probe metadata tag)
 *
 * Returns the signed wire bytes, Base64 string, and real transaction signature (Base58).
 */
export function buildSignedProbeTransaction({
  signer,
  recentBlockhashBase58,
  writableTargetBase58,
  computeUnitLimit = 50_000,
  computeUnitPriceMicroLamports = 10_000,
  memoText = "probe"
}) {
  const writableTargetBytes = decodeBase58(writableTargetBase58);
  const blockhashBytes = decodeBase58(recentBlockhashBase58);

  // Account ordering rules in Solana legacy message:
  // 0: signer.publicKeyBytes (writable, signed)
  // 1: writableTargetBytes (writable, unsigned) — unless identical to signer
  // 2: COMPUTE_BUDGET_PUBKEY (readonly, unsigned)
  // 3: SYSTEM_PROGRAM_PUBKEY (readonly, unsigned)
  // 4: MEMO_PROGRAM_PUBKEY (readonly, unsigned)
  const sameTargetAsSigner = writableTargetBase58 === signer.publicKeyBase58;
  const accountKeys = sameTargetAsSigner
    ? [signer.publicKeyBytes, COMPUTE_BUDGET_PUBKEY, SYSTEM_PROGRAM_PUBKEY, MEMO_PROGRAM_PUBKEY]
    : [
        signer.publicKeyBytes,
        writableTargetBytes,
        COMPUTE_BUDGET_PUBKEY,
        SYSTEM_PROGRAM_PUBKEY,
        MEMO_PROGRAM_PUBKEY
      ];

  const header = Buffer.from([
    1, // numRequiredSignatures
    0, // numReadonlySignedAccounts
    3  // numReadonlyUnsignedAccounts (ComputeBudget, SystemProgram, MemoProgram)
  ]);

  const cbProgIdx = sameTargetAsSigner ? 1 : 2;
  const sysProgIdx = sameTargetAsSigner ? 2 : 3;
  const memoProgIdx = sameTargetAsSigner ? 3 : 4;
  const targetAccIdx = sameTargetAsSigner ? 0 : 1;

  // Instruction 1: SetComputeUnitLimit (0x02 + u32 LE)
  const limitData = Buffer.alloc(5);
  limitData.writeUInt8(2, 0);
  limitData.writeUInt32LE(computeUnitLimit, 1);

  // Instruction 2: SetComputeUnitPrice (0x03 + u64 LE)
  const priceData = Buffer.alloc(9);
  priceData.writeUInt8(3, 0);
  priceData.writeBigUInt64LE(BigInt(computeUnitPriceMicroLamports), 1);

  // Instruction 3: SystemProgram::Transfer(0 lamports) from [0] to [targetAccIdx]
  // Locks both [0] and [targetAccIdx] as writable accounts in the leader's prio-graph!
  const transferData = Buffer.alloc(12);
  transferData.writeUInt32LE(2, 0); // Transfer instruction index = 2
  transferData.writeBigUInt64LE(0n, 4); // 0 lamports

  // Instruction 4: SPL Memo
  const memoData = Buffer.from(memoText, "utf8");

  const compiledInstructions = [
    { programIdIndex: cbProgIdx, accounts: [], data: limitData },
    { programIdIndex: cbProgIdx, accounts: [], data: priceData },
    { programIdIndex: sysProgIdx, accounts: [0, targetAccIdx], data: transferData },
    { programIdIndex: memoProgIdx, accounts: [0], data: memoData }
  ];

  const ixsEncoded = compiledInstructions.map(ix =>
    Buffer.concat([
      Buffer.from([ix.programIdIndex]),
      encodeCompactU16(ix.accounts.length),
      Buffer.from(ix.accounts),
      encodeCompactU16(ix.data.length),
      ix.data
    ])
  );

  const messageBuffer = Buffer.concat([
    header,
    encodeCompactU16(accountKeys.length),
    ...accountKeys.map(k => Buffer.from(k)),
    Buffer.from(blockhashBytes),
    encodeCompactU16(compiledInstructions.length),
    ...ixsEncoded
  ]);

  const signatureBytes = signer.sign(messageBuffer);
  const wireTx = Buffer.concat([
    encodeCompactU16(1),
    Buffer.from(signatureBytes),
    messageBuffer
  ]);

  return {
    signature: encodeBase58(signatureBytes),
    wireBase64: wireTx.toString("base64"),
    wireBytesLength: wireTx.length,
    signerPubkey: signer.publicKeyBase58,
    writableTargetAccount: writableTargetBase58
  };
}
