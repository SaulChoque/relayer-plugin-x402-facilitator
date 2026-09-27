/**
 * Solana plugin
 *
 * This plugin implements Solana payment processing for the x402 `exact` scheme:
 * the client partially signs an SPL Token / Token-2022 `TransferChecked`
 * transaction whose fee payer is the relayer, and the relayer adds its
 * signature and submits it.
 *
 * Networks are identified by CAIP-2 ids, e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
 * (mainnet-beta) or "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" (devnet).
 */
export * from "./verify";
export * from "./settle";
