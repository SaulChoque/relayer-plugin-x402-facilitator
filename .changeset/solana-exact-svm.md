---
"@rodacio/relayer-plugin-x402-facilitator": minor
---

feat: add Solana support for the x402 `exact` scheme (SVM)

- New `type: "solana"` network config for CAIP-2 `solana:<genesis hash>` networks served by an OpenZeppelin Relayer Solana relayer with `fee_payment_strategy: "relayer"`.
- `/verify` implements the x402 SVM rules (instruction layout, compute price cap, TransferChecked mint/destination/amount, fee payer safety, memo, client signatures) and simulates through the relayer RPC. Legacy and v0 transactions are supported.
- `/settle` re-verifies, guards against duplicate settlements with the plugin KV store, has the relayer add its fee payer signature, checks the relayer did not alter the transaction, submits it and waits for confirmation.
- `/supported` returns `extra.feePayer` (the relayer address) for Solana kinds.
- Signing v0 transactions (sent by official `@x402/svm` clients) requires a relayer that supports versioned Solana transactions.
