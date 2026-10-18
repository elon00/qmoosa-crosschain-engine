import crypto from "node:crypto";

export function computeHashlock(secret: string | Buffer | Uint8Array): string {
  const buf = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

export function verifyPreimage(secret: string | Buffer | Uint8Array, hashlock: string): boolean {
  const computed = computeHashlock(secret);
  const normExpected = hashlock.startsWith("0x") ? hashlock.toLowerCase() : "0x" + hashlock.toLowerCase();
  return computed.toLowerCase() === normExpected;
}

export function calculateSafetyBuffer(sourceChainFinalitySec: number, destChainFinalitySec: number): number {
  // Safe buffer = max finality + 300s margin for network relay propagation
  return Math.max(sourceChainFinalitySec, destChainFinalitySec) + 300;
}
