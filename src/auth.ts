import crypto from "node:crypto";
import { AdminIntent, SignedAdminIntent } from "./types.js";

export class AdminAuthManager {
  private allowedPublicKey: string;
  private chainId: number;
  private consumedNonces: Set<number> = new Set();

  constructor(allowedPublicKey: string, chainId: number) {
    this.allowedPublicKey = allowedPublicKey;
    this.chainId = chainId;
  }

  public static generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    return { publicKey, privateKey };
  }

  public static signIntent(intent: AdminIntent, privateKeyPem: string): string {
    const serialized = JSON.stringify({
      action: intent.action,
      nonce: intent.nonce,
      deadline: intent.deadline,
      chainId: intent.chainId,
      params: intent.params
    });
    return crypto.sign(null, Buffer.from(serialized, "utf8"), privateKeyPem).toString("hex");
  }

  public verifyAndConsume(intent: SignedAdminIntent): void {
    if (intent.chainId !== this.chainId) {
      throw new Error(`CHAIN_ID_MISMATCH: Expected ${this.chainId}, got ${intent.chainId}`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      throw new Error("INTENT_EXPIRED: Deadline has passed");
    }
    if (this.consumedNonces.has(intent.nonce)) {
      throw new Error("NONCE_REPLAY_ATTACK: Nonce has already been consumed");
    }
    if (intent.signerPublicKey !== this.allowedPublicKey) {
      throw new Error("UNAUTHORIZED_SIGNER: Signer public key does not match admin");
    }

    const serialized = JSON.stringify({
      action: intent.action,
      nonce: intent.nonce,
      deadline: intent.deadline,
      chainId: intent.chainId,
      params: intent.params
    });

    let isValid = false;
    try {
      isValid = crypto.verify(
        null,
        Buffer.from(serialized, "utf8"),
        this.allowedPublicKey,
        Buffer.from(intent.signature, "hex")
      );
    } catch {
      isValid = false;
    }

    if (!isValid) {
      throw new Error("INVALID_SIGNATURE: Cryptographic signature verification failed");
    }

    this.consumedNonces.add(intent.nonce);
  }
}
