---
"@openzeppelin/relayer-plugin-x402-facilitator": minor
---

Add EVM network support for the "exact" scheme using EIP-3009 (`transferWithAuthorization`), alongside the existing Stellar support. Configure EVM networks with `type: "evm"` and a CAIP-2 `eip155:<chainId>` network identifier (e.g. `eip155:43113` for Avalanche Fuji, `eip155:133` for HSK testnet).
