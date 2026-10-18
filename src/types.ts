export enum CrossChainSwapState {
  CREATED = "CREATED",
  SOURCE_FUNDED = "SOURCE_FUNDED",
  COUNTERPARTY_FUNDED = "COUNTERPARTY_FUNDED",
  CLAIMABLE = "CLAIMABLE",
  CLAIMED = "CLAIMED",
  EXPIRED = "EXPIRED",
  REFUNDED = "REFUNDED",
  FAILED = "FAILED"
}

export interface ChainConfig {
  chainId: number;
  name: string;
  requiredFinalityBlocks: number;
  htlcAddress: string;
  isPaused: boolean;
}

export interface CrossChainSwap {
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
  state: CrossChainSwapState;
  sourceBlockDepth: number;
  destBlockDepth: number;
  revealedSecret?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChainBlockEvent {
  eventId: string;
  chainId: number;
  blockNumber: number;
  txHash: string;
  swapId: string;
  eventType: "SWAP_CREATED" | "SWAP_CLAIMED" | "SWAP_REFUNDED";
  data: any;
}

export interface AdminIntent {
  action: "SET_CHAIN_CONFIG" | "SET_PAUSED" | "SET_SAFETY_MARGIN";
  nonce: number;
  deadline: number;
  chainId: number;
  params: Record<string, any>;
}

export interface SignedAdminIntent extends AdminIntent {
  signature: string;
  signerPublicKey: string;
}
