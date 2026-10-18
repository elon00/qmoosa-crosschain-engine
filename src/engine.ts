import {
  CrossChainSwapState,
  ChainConfig,
  CrossChainSwap,
  ChainBlockEvent,
  SignedAdminIntent
} from "./types.js";
import { AdminAuthManager } from "./auth.js";
import { computeHashlock, verifyPreimage } from "./math.js";

export class CrossChainEngine {
  private chainConfigs: Map<number, ChainConfig> = new Map();
  private swaps: Map<string, CrossChainSwap> = new Map();
  private processedEvents: Set<string> = new Set();
  private authManager: AdminAuthManager;
  private minSafetyBufferSeconds: number = 300; // 5 minutes minimum floor
  private isSystemPaused: boolean = false;

  constructor(adminPublicKey: string, primaryChainId: number = 1) {
    this.authManager = new AdminAuthManager(adminPublicKey, primaryChainId);
    this._initDefaultChains();
  }

  private _initDefaultChains(): void {
    // Chain 1: Ethereum Mainnet simulation
    this.chainConfigs.set(1, {
      chainId: 1,
      name: "Ethereum",
      requiredFinalityBlocks: 12,
      blockTimeSeconds: 12,
      reorgSafetyBufferBlocks: 6,
      htlcAddress: "0x1111111111111111111111111111111111111111",
      isPaused: false
    });

    // Chain 137: Polygon PoS simulation
    this.chainConfigs.set(137, {
      chainId: 137,
      name: "Polygon",
      requiredFinalityBlocks: 32,
      blockTimeSeconds: 2,
      reorgSafetyBufferBlocks: 16,
      htlcAddress: "0x2222222222222222222222222222222222222222",
      isPaused: false
    });
  }

  public registerChainDirect(config: ChainConfig): void {
    this.chainConfigs.set(config.chainId, { ...config });
  }

  public getChainConfig(chainId: number): ChainConfig | undefined {
    const c = this.chainConfigs.get(chainId);
    return c ? { ...c } : undefined;
  }

  public calculatePairSafetyMargin(sourceChainId: number, destChainId: number): number {
    const src = this.chainConfigs.get(sourceChainId);
    const dst = this.chainConfigs.get(destChainId);
    if (!src || !dst) return this.minSafetyBufferSeconds;

    const srcFinalityTime = (src.requiredFinalityBlocks + src.reorgSafetyBufferBlocks) * src.blockTimeSeconds;
    const dstFinalityTime = (dst.requiredFinalityBlocks + dst.reorgSafetyBufferBlocks) * dst.blockTimeSeconds;

    // Margin = (source + destination confirmation latency) * 2 + 60s relayer latency
    const calculated = (srcFinalityTime + dstFinalityTime) * 2 + 60;
    return Math.max(this.minSafetyBufferSeconds, calculated);
  }

  public createSwapOrder(params: {
    swapId: string;
    sender: string;
    recipient: string;
    sourceToken: string;
    destToken: string;
    sourceAmount: bigint;
    destAmount: bigint;
    hashlock: string;
    sourceTimelock: number;
    destTimelock: number;
    sourceChainId: number;
    destChainId: number;
    nonce: number;
  }): CrossChainSwap {
    if (this.isSystemPaused) {
      throw new Error("SYSTEM_PAUSED: Cross-chain operations are currently paused");
    }
    const sourceChain = this.chainConfigs.get(params.sourceChainId);
    const destChain = this.chainConfigs.get(params.destChainId);

    if (!sourceChain || sourceChain.isPaused) {
      throw new Error(`SOURCE_CHAIN_UNAVAILABLE: Chain ${params.sourceChainId} is not configured or paused`);
    }
    if (!destChain || destChain.isPaused) {
      throw new Error(`DEST_CHAIN_UNAVAILABLE: Chain ${params.destChainId} is not configured or paused`);
    }
    if (params.sourceAmount <= 0n || params.destAmount <= 0n) {
      throw new RangeError("INVALID_AMOUNT: Amounts must be strictly positive");
    }

    // Invariant: Initiator's source timelock must exceed destination timelock by at least pair-specific safety margin
    const requiredMargin = this.calculatePairSafetyMargin(params.sourceChainId, params.destChainId);
    const delta = params.sourceTimelock - params.destTimelock;
    if (delta < requiredMargin) {
      throw new Error(
        `INSUFFICIENT_TIMELOCK_DELTA: Source timelock must exceed dest timelock by at least ${requiredMargin}s (actual: ${delta}s)`
      );
    }

    if (this.swaps.has(params.swapId)) {
      throw new Error(`SWAP_ALREADY_EXISTS: Swap ID ${params.swapId} is already registered`);
    }

    const now = Math.floor(Date.now() / 1000);
    const swap: CrossChainSwap = {
      ...params,
      state: CrossChainSwapState.CREATED,
      sourceBlockDepth: 0,
      destBlockDepth: 0,
      createdAt: now,
      updatedAt: now
    };

    this.swaps.set(params.swapId, swap);
    return Object.freeze({ ...swap });
  }

  public recordSourceFunding(swapId: string, blockDepth: number): CrossChainSwap {
    const swap = this._getInternalSwapOrThrow(swapId);
    if (swap.state !== CrossChainSwapState.CREATED && swap.state !== CrossChainSwapState.SOURCE_FUNDED) {
      throw new Error(`INVALID_STATE_TRANSITION: Cannot record source funding from state ${swap.state}`);
    }

    swap.sourceBlockDepth = blockDepth;
    const required = this.chainConfigs.get(swap.sourceChainId)?.requiredFinalityBlocks ?? 12;

    if (blockDepth >= required) {
      swap.state = CrossChainSwapState.SOURCE_FUNDED;
    }
    swap.updatedAt = Math.floor(Date.now() / 1000);
    return Object.freeze({ ...swap });
  }

  public recordCounterpartyFunding(swapId: string, blockDepth: number): CrossChainSwap {
    const swap = this._getInternalSwapOrThrow(swapId);
    if (swap.state !== CrossChainSwapState.SOURCE_FUNDED && swap.state !== CrossChainSwapState.COUNTERPARTY_FUNDED) {
      throw new Error(`INVALID_STATE_TRANSITION: Cannot fund counterparty before source is funded (current: ${swap.state})`);
    }

    swap.destBlockDepth = blockDepth;
    const required = this.chainConfigs.get(swap.destChainId)?.requiredFinalityBlocks ?? 32;

    if (blockDepth >= required) {
      swap.state = CrossChainSwapState.CLAIMABLE;
    } else {
      swap.state = CrossChainSwapState.COUNTERPARTY_FUNDED;
    }
    swap.updatedAt = Math.floor(Date.now() / 1000);
    return Object.freeze({ ...swap });
  }

  public revealSecretAndClaim(swapId: string, secret: string, currentTimestamp: number = Math.floor(Date.now() / 1000)): CrossChainSwap {
    const swap = this._getInternalSwapOrThrow(swapId);
    if (swap.state !== CrossChainSwapState.CLAIMABLE && swap.state !== CrossChainSwapState.COUNTERPARTY_FUNDED) {
      throw new Error(`INVALID_STATE_TRANSITION: Swap is not claimable in state ${swap.state}`);
    }

    if (currentTimestamp > swap.destTimelock) {
      swap.state = CrossChainSwapState.EXPIRED;
      throw new Error("SWAP_TIMELOCK_EXPIRED: Cannot claim after destination timelock has elapsed");
    }

    // Verify preimage
    if (!verifyPreimage(secret, swap.hashlock)) {
      throw new Error("INVALID_SECRET_PREIMAGE: Revealed secret does not match hashlock");
    }

    swap.revealedSecret = secret;
    swap.state = CrossChainSwapState.CLAIMED;
    swap.updatedAt = currentTimestamp;
    return Object.freeze({ ...swap });
  }

  public executeRefund(swapId: string, currentTimestamp: number = Math.floor(Date.now() / 1000)): CrossChainSwap {
    const swap = this._getInternalSwapOrThrow(swapId);
    if (swap.state === CrossChainSwapState.CLAIMED) {
      throw new Error("MUTUAL_EXCLUSION_VIOLATION: Cannot refund an already claimed swap");
    }
    if (swap.state === CrossChainSwapState.REFUNDED) {
      throw new Error("DOUBLE_REFUND_ATTEMPT: Swap has already been refunded");
    }

    // Must be after source timelock
    if (currentTimestamp <= swap.sourceTimelock) {
      throw new Error(
        `TIMELOCK_ACTIVE: Cannot refund while timelock is active (${currentTimestamp} <= ${swap.sourceTimelock})`
      );
    }

    swap.state = CrossChainSwapState.REFUNDED;
    swap.updatedAt = currentTimestamp;
    return Object.freeze({ ...swap });
  }

  public handleReorgRollback(swapId: string, chainId: number, rolledBackDepth: number): CrossChainSwap {
    const swap = this._getInternalSwapOrThrow(swapId);
    if (swap.state === CrossChainSwapState.CLAIMED || swap.state === CrossChainSwapState.REFUNDED) {
      return Object.freeze({ ...swap });
    }

    if (chainId === swap.sourceChainId) {
      swap.sourceBlockDepth = Math.max(0, swap.sourceBlockDepth - rolledBackDepth);
      const req = this.chainConfigs.get(swap.sourceChainId)?.requiredFinalityBlocks ?? 12;
      if (swap.sourceBlockDepth < req && swap.state === CrossChainSwapState.SOURCE_FUNDED) {
        swap.state = CrossChainSwapState.CREATED; // Demote back to pending finality
      }
    } else if (chainId === swap.destChainId) {
      swap.destBlockDepth = Math.max(0, swap.destBlockDepth - rolledBackDepth);
      const req = this.chainConfigs.get(swap.destChainId)?.requiredFinalityBlocks ?? 32;
      if (swap.destBlockDepth < req && swap.state === CrossChainSwapState.CLAIMABLE) {
        swap.state = CrossChainSwapState.COUNTERPARTY_FUNDED;
      }
    }

    swap.updatedAt = Math.floor(Date.now() / 1000);
    return Object.freeze({ ...swap });
  }

  public processBlockEvent(event: ChainBlockEvent): boolean {
    if (this.processedEvents.has(event.eventId)) {
      return false; // Idempotent: already processed
    }

    // Validate genuine receipt status and format
    if (event.status !== 1) {
      throw new Error(`TRANSACTION_FAILED: Event ${event.eventId} references a reverted receipt status`);
    }
    if (!event.blockHash || !event.blockHash.startsWith("0x")) {
      throw new Error(`INVALID_BLOCK_HASH: Event ${event.eventId} missing canonical block hash`);
    }
    if (!event.txHash || !event.txHash.startsWith("0x")) {
      throw new Error(`INVALID_TX_HASH: Event ${event.eventId} missing transaction hash`);
    }

    const swap = this.swaps.get(event.swapId);
    if (!swap) {
      this.processedEvents.add(event.eventId);
      return false;
    }

    switch (event.eventType) {
      case "SWAP_CREATED":
        if (event.chainId === swap.sourceChainId) {
          this.recordSourceFunding(swap.swapId, swap.sourceBlockDepth + 1);
        } else if (event.chainId === swap.destChainId) {
          this.recordCounterpartyFunding(swap.swapId, swap.destBlockDepth + 1);
        }
        break;
      case "SWAP_CLAIMED":
        if (event.data?.secret && swap.state !== CrossChainSwapState.CLAIMED) {
          this.revealSecretAndClaim(swap.swapId, event.data.secret);
        }
        break;
      case "SWAP_REFUNDED":
        if (swap.state !== CrossChainSwapState.REFUNDED && swap.state !== CrossChainSwapState.CLAIMED) {
          swap.state = CrossChainSwapState.REFUNDED;
        }
        break;
    }

    this.processedEvents.add(event.eventId);
    return true;
  }

  public executeAdminIntent(intent: SignedAdminIntent): void {
    this.authManager.verifyAndConsume(intent);

    switch (intent.action) {
      case "SET_CHAIN_CONFIG": {
        const { chainId, name, requiredFinalityBlocks, blockTimeSeconds, reorgSafetyBufferBlocks, htlcAddress, isPaused } = intent.params;
        this.chainConfigs.set(Number(chainId), {
          chainId: Number(chainId),
          name: String(name),
          requiredFinalityBlocks: Number(requiredFinalityBlocks),
          blockTimeSeconds: Number(blockTimeSeconds ?? 12),
          reorgSafetyBufferBlocks: Number(reorgSafetyBufferBlocks ?? 6),
          htlcAddress: String(htlcAddress),
          isPaused: Boolean(isPaused)
        });
        break;
      }
      case "SET_PAUSED": {
        this.isSystemPaused = Boolean(intent.params.paused);
        break;
      }
      case "SET_SAFETY_MARGIN": {
        this.minSafetyBufferSeconds = Number(intent.params.marginSeconds);
        break;
      }
      default:
        throw new Error(`UNKNOWN_ADMIN_ACTION: Action ${(intent as any).action} is not recognized`);
    }
  }

  public getSwap(swapId: string): CrossChainSwap | undefined {
    const swap = this.swaps.get(swapId);
    if (!swap) return undefined;
    return Object.freeze({ ...swap });
  }

  public getAllSwaps(): CrossChainSwap[] {
    return Array.from(this.swaps.values()).map(s => Object.freeze({ ...s }));
  }

  public isPaused(): boolean {
    return this.isSystemPaused;
  }

  private _getInternalSwapOrThrow(swapId: string): CrossChainSwap {
    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new Error(`SWAP_NOT_FOUND: Swap ID ${swapId} does not exist`);
    }
    return swap;
  }
}
