# QMOOSA Cross-Chain Engine (`@qmoosa/crosschain-engine`)

Deterministic State Machine, Multi-Chain Relayer Coordination, and Reorg-Resilient Finality Verifier for Cross-Chain Atomic Swaps.

## Lifecycle States

- `CREATED`: Local swap parameters committed.
- `SOURCE_FUNDED`: Funds locked on source chain and verified by confirmation block depth.
- `COUNTERPARTY_FUNDED`: Destination chain funds locked and awaiting confirmation.
- `CLAIMABLE`: Both chains verified with required block finality depth; secret preimage ready for revelation.
- `CLAIMED`: Secret preimage disclosed, funds claimed on destination and source.
- `EXPIRED`: Timelock passed without claim.
- `REFUNDED`: Funds reclaimed on source chain.

## Verification

```bash
npm test
```
