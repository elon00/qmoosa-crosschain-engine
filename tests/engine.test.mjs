import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CrossChainEngine,
  AdminAuthManager,
  CrossChainSwapState,
  computeHashlock
} from "../dist/index.js";

function setupEngine() {
  const { publicKey, privateKey } = AdminAuthManager.generateKeyPair();
  const engine = new CrossChainEngine(publicKey, 1);
  return { engine, publicKey, privateKey };
}

test("1. Full End-to-End Cross-Chain Atomic Swap Lifecycle", () => {
  const { engine } = setupEngine();
  const secret = "atomic_swap_preimage_secure_99";
  const hashlock = computeHashlock(secret);
  const now = Math.floor(Date.now() / 1000);

  // 1. Create Swap
  const swap = engine.createSwapOrder({
    swapId: "0xSwap01",
    sender: "0xAlice",
    recipient: "0xBob",
    sourceToken: "0xUSDC",
    destToken: "0xMATIC",
    sourceAmount: 1000n * 10n**18n,
    destAmount: 1200n * 10n**18n,
    hashlock,
    sourceTimelock: now + 3600, // 1h
    destTimelock: now + 1800,   // 30m (delta = 1800s > 300s)
    sourceChainId: 1,
    destChainId: 137,
    nonce: 1
  });
  assert.equal(swap.state, CrossChainSwapState.CREATED);

  // 2. Fund Source and reach finality (12 blocks)
  engine.recordSourceFunding("0xSwap01", 12);
  const s2 = engine.getSwap("0xSwap01");
  assert.equal(s2.state, CrossChainSwapState.SOURCE_FUNDED);

  // 3. Fund Dest and reach finality (32 blocks)
  engine.recordCounterpartyFunding("0xSwap01", 32);
  const s3 = engine.getSwap("0xSwap01");
  assert.equal(s3.state, CrossChainSwapState.CLAIMABLE);

  // 4. Reveal secret and claim
  const s4 = engine.revealSecretAndClaim("0xSwap01", secret);
  assert.equal(s4.state, CrossChainSwapState.CLAIMED);
  assert.equal(s4.revealedSecret, secret);
});

test("2. Expiration and Refund Lifecycle after Timelock", () => {
  const { engine } = setupEngine();
  const secret = "secret_to_expire";
  const hashlock = computeHashlock(secret);
  const now = Math.floor(Date.now() / 1000);

  engine.createSwapOrder({
    swapId: "0xSwap02",
    sender: "0xAlice",
    recipient: "0xBob",
    sourceToken: "0xUSDC",
    destToken: "0xMATIC",
    sourceAmount: 500n * 10n**18n,
    destAmount: 600n * 10n**18n,
    hashlock,
    sourceTimelock: now + 1000,
    destTimelock: now + 500,
    sourceChainId: 1,
    destChainId: 137,
    nonce: 2
  });

  // Source funded
  engine.recordSourceFunding("0xSwap02", 12);

  // Premature refund before source timelock must fail closed
  assert.throws(
    () => engine.executeRefund("0xSwap02", now + 800),
    /TIMELOCK_ACTIVE/
  );

  // Refund after source timelock succeeds
  const refunded = engine.executeRefund("0xSwap02", now + 1001);
  assert.equal(refunded.state, CrossChainSwapState.REFUNDED);
});

test("3. Mutual Exclusion & Double Claim/Refund Defense", () => {
  const { engine } = setupEngine();
  const secret = "secret_mutual_exclusion";
  const hashlock = computeHashlock(secret);
  const now = Math.floor(Date.now() / 1000);

  engine.createSwapOrder({
    swapId: "0xSwap03",
    sender: "0xAlice",
    recipient: "0xBob",
    sourceToken: "0xUSDC",
    destToken: "0xMATIC",
    sourceAmount: 100n * 10n**18n,
    destAmount: 120n * 10n**18n,
    hashlock,
    sourceTimelock: now + 2000,
    destTimelock: now + 1000,
    sourceChainId: 1,
    destChainId: 137,
    nonce: 3
  });

  engine.recordSourceFunding("0xSwap03", 12);
  engine.recordCounterpartyFunding("0xSwap03", 32);
  engine.revealSecretAndClaim("0xSwap03", secret);

  // Claimed swap cannot be refunded even after timelock
  assert.throws(
    () => engine.executeRefund("0xSwap03", now + 3000),
    /MUTUAL_EXCLUSION_VIOLATION/
  );
});

test("4. Invalid Secret Preimage Rejection", () => {
  const { engine } = setupEngine();
  const hashlock = computeHashlock("real_secret");
  const now = Math.floor(Date.now() / 1000);

  engine.createSwapOrder({
    swapId: "0xSwap04",
    sender: "0xAlice",
    recipient: "0xBob",
    sourceToken: "0xUSDC",
    destToken: "0xMATIC",
    sourceAmount: 100n * 10n**18n,
    destAmount: 120n * 10n**18n,
    hashlock,
    sourceTimelock: now + 2000,
    destTimelock: now + 1000,
    sourceChainId: 1,
    destChainId: 137,
    nonce: 4
  });

  engine.recordSourceFunding("0xSwap04", 12);
  engine.recordCounterpartyFunding("0xSwap04", 32);

  assert.throws(
    () => engine.revealSecretAndClaim("0xSwap04", "forged_secret"),
    /INVALID_SECRET_PREIMAGE/
  );
});

test("5. Reorg Rollback State Demotion Defense", () => {
  const { engine } = setupEngine();
  const hashlock = computeHashlock("reorg_secret");
  const now = Math.floor(Date.now() / 1000);

  engine.createSwapOrder({
    swapId: "0xSwap05",
    sender: "0xAlice",
    recipient: "0xBob",
    sourceToken: "0xUSDC",
    destToken: "0xMATIC",
    sourceAmount: 100n * 10n**18n,
    destAmount: 120n * 10n**18n,
    hashlock,
    sourceTimelock: now + 2000,
    destTimelock: now + 1000,
    sourceChainId: 1,
    destChainId: 137,
    nonce: 5
  });

  engine.recordSourceFunding("0xSwap05", 12);
  assert.equal(engine.getSwap("0xSwap05").state, CrossChainSwapState.SOURCE_FUNDED);

  // Simulate reorg rollback of 3 blocks on Ethereum (depth drops to 9 < 12)
  engine.handleReorgRollback("0xSwap05", 1, 3);
  assert.equal(engine.getSwap("0xSwap05").state, CrossChainSwapState.CREATED);
  assert.equal(engine.getSwap("0xSwap05").sourceBlockDepth, 9);
});

test("6. Idempotent Event Processing Deduplication", () => {
  const { engine } = setupEngine();
  const hashlock = computeHashlock("event_secret");
  const now = Math.floor(Date.now() / 1000);

  engine.createSwapOrder({
    swapId: "0xSwap06",
    sender: "0xAlice",
    recipient: "0xBob",
    sourceToken: "0xUSDC",
    destToken: "0xMATIC",
    sourceAmount: 100n * 10n**18n,
    destAmount: 120n * 10n**18n,
    hashlock,
    sourceTimelock: now + 2000,
    destTimelock: now + 1000,
    sourceChainId: 1,
    destChainId: 137,
    nonce: 6
  });

  const event = {
    eventId: "evt_111",
    chainId: 1,
    blockNumber: 100,
    txHash: "0xTx1",
    swapId: "0xSwap06",
    eventType: "SWAP_CREATED",
    data: {}
  };

  const first = engine.processBlockEvent(event);
  assert.equal(first, true);

  // Duplicate event returns false without mutation
  const second = engine.processBlockEvent(event);
  assert.equal(second, false);
});

test("7. Ed25519 Admin Intent Authentication & Nonce Replay Defense", () => {
  const { engine, publicKey, privateKey } = setupEngine();
  const now = Math.floor(Date.now() / 1000);

  const intent = {
    action: "SET_SAFETY_MARGIN",
    nonce: 101,
    deadline: now + 600,
    chainId: 1,
    params: { marginSeconds: 600 }
  };

  const signature = AdminAuthManager.signIntent(intent, privateKey);
  const signed = { ...intent, signature, signerPublicKey: publicKey };

  engine.executeAdminIntent(signed);

  // Replaying same nonce fails closed
  assert.throws(
    () => engine.executeAdminIntent(signed),
    /NONCE_REPLAY_ATTACK/
  );
});
