/**
 * EVM plugin
 *
 * This plugin implements EVM payment processing for the x402 `exact` scheme
 * using EIP-3009 `transferWithAuthorization` (e.g. USDC).
 *
 * Works on any EVM chain configured in the relayer, identified by its CAIP-2
 * network id (e.g. "eip155:8453" for Base, "eip155:42161" for Arbitrum One).
 */
export * from "./verify";
export * from "./settle";
