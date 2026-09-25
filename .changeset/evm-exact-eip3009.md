---
"@openzeppelin/relayer-plugin-x402-facilitator": minor
---

feat: add EVM support for the x402 `exact` scheme (EIP-3009)

- New `type: "evm"` network config for any CAIP-2 `eip155:<chainId>` network served by an OpenZeppelin Relayer EVM relayer (e.g. Base, Arbitrum, Avalanche, Arc).
- `/verify` checks the EIP-712 `TransferWithAuthorization` signature, recipient, exact amount, validity window, payer balance, unused nonce, relayer chain (`eth_chainId`) and simulates `transferWithAuthorization` via the relayer RPC.
- `/settle` re-verifies, estimates gas and submits `transferWithAuthorization` through `relayer.sendTransaction`, waiting until the transaction is mined.
- `/supported` lists EVM kinds and the relayer signer address.
- `extra.areFeesSponsored` is now only required for Stellar requirements.
