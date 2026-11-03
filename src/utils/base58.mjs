const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map();
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP.set(ALPHABET[i], i);
}

export function decodeBase58(str) {
  if (!str || typeof str !== "string") return new Uint8Array(0);
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const val = ALPHABET_MAP.get(c);
    if (val === undefined) {
      throw new Error(`Invalid base58 character: ${c}`);
    }
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < str.length && str[i] === "1"; i++) {
    leadingZeros++;
  }
  const nonZeroBytes = bytes.length === 1 && bytes[0] === 0 ? [] : bytes;
  const out = new Uint8Array(leadingZeros + nonZeroBytes.length);
  for (let i = 0; i < nonZeroBytes.length; i++) {
    out[out.length - 1 - i] = nonZeroBytes[i];
  }
  return out;
}

export function encodeBase58(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) return "";
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    out += ALPHABET[digits[i]];
  }
  return out;
}

/**
 * Decodes Solana ComputeBudget111111111111111111111111111111 instructions:
 * - Tag 0x02: SetComputeUnitLimit (u32 little-endian at offset 1..5)
 * - Tag 0x03: SetComputeUnitPrice (u64 little-endian at offset 1..9, micro-lamports per CU)
 */
export function parseComputeBudgetInstructions(instructions, accountKeys) {
  const COMPUTE_BUDGET_ID = "ComputeBudget111111111111111111111111111111";
  let computeUnitLimit = null;
  let computeUnitPriceMicroLamports = null;

  for (const ix of instructions || []) {
    const progId =
      typeof ix.programIdIndex === "number"
        ? accountKeys[ix.programIdIndex]
        : ix.programId;
    if (progId !== COMPUTE_BUDGET_ID || !ix.data) continue;
    try {
      const buf = decodeBase58(ix.data);
      if (buf.length >= 5 && buf[0] === 2) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        computeUnitLimit = view.getUint32(1, true);
      } else if (buf.length >= 9 && buf[0] === 3) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        computeUnitPriceMicroLamports = Number(view.getBigUint64(1, true));
      }
    } catch {
      // Ignore malformed third-party ix data
    }
  }

  return {
    computeUnitLimit: computeUnitLimit ?? 200_000,
    explicitComputeUnitLimit: computeUnitLimit !== null,
    computeUnitPriceMicroLamports: computeUnitPriceMicroLamports ?? 0,
    hasExplicitPriorityFee: computeUnitPriceMicroLamports !== null && computeUnitPriceMicroLamports > 0
  };
}
