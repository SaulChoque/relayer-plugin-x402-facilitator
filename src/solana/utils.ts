/**
 * Shared utility functions for Solana payment processing (x402 `exact` scheme on SVM)
 */
import {
  type Address,
  type SignaturesMap,
  address,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
} from "@solana/kit";
import type { Relayer } from "@openzeppelin/relayer-sdk";

// Default timeout in seconds for payment operations
export const DEFAULT_TIMEOUT_SECONDS = 60;

export const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  "ComputeBudget111111111111111111111111111111";
export const TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MEMO_PROGRAM_ADDRESS =
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
// Wallet-injected user protection program (Phantom adds 1 instruction, Solflare 2)
export const LIGHTHOUSE_PROGRAM_ADDRESS =
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

// Upper bound for the compute unit price: 5 lamports per compute unit
// (the x402 reference facilitator's limit).
export const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000_000n;
export const MAX_MEMO_BYTES = 256;

// Duplicate-settlement guard: long enough to outlive a blockhash (~60-90s).
export const SETTLEMENT_CACHE_TTL_SECONDS = 120;

/** CAIP-2 identifiers of the public Solana clusters (genesis hash, first 32 chars). */
export const SOLANA_CLUSTER_CAIP2: Record<string, string> = {
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

const SOLANA_CAIP2_REGEX = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

/**
 * Validates a CAIP-2 Solana network identifier ("solana:<genesis hash prefix>").
 */
export function isValidSolanaNetwork(network: string): boolean {
  return SOLANA_CAIP2_REGEX.test(network);
}

/**
 * Builds the CAIP-2 identifier from a full base58 genesis hash.
 */
export function caip2FromGenesisHash(genesisHash: string): string {
  return `solana:${genesisHash.slice(0, 32)}`;
}

export function isSolanaAddress(value: unknown): value is string {
  return typeof value === "string" && isAddress(value);
}

/** Compiled message (legacy or v0) as returned by the kit decoder, lifetime included. */
export type DecodedMessage = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]
>;

export type DecodedTransaction = {
  messageBytes: Uint8Array;
  signatures: SignaturesMap;
  compiled: DecodedMessage;
};

/**
 * Decodes a base64 wire transaction (legacy or v0) into its message bytes,
 * signature map and compiled message.
 */
export function decodeTransaction(
  base64Transaction: string,
): DecodedTransaction {
  const bytes = getBase64Encoder().encode(base64Transaction);
  const transaction = getTransactionDecoder().decode(bytes);
  const messageBytes = new Uint8Array(transaction.messageBytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  return { messageBytes, signatures: transaction.signatures, compiled };
}

/**
 * Returns the fee payer (first static account) of a compiled message.
 */
export function getFeePayer(compiled: DecodedMessage): Address {
  return compiled.staticAccounts[0];
}

export function signatureToBase58(signature: Uint8Array): string {
  return getBase58Decoder().decode(signature);
}

export function isEmptySignature(
  signature: Uint8Array | null | undefined,
): boolean {
  return !signature || signature.every((byte) => byte === 0);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function toAddress(value: string): Address {
  return address(value);
}

// Error text produced by OpenZeppelin Relayer versions that cannot serialize
// non-object raw RPC results (e.g. the signature string returned by
// `sendTransaction`). The call itself succeeded on the node.
const UNSERIALIZABLE_RAW_RESULT = "cannot serialize tagged newtype variant";

export type RpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: unknown; unserializableResult?: boolean };

/**
 * Performs a raw JSON-RPC call against the Solana node behind the relayer.
 *
 * Object results come back tagged with `"method": "rawRpc"` by the relayer;
 * that extra key is harmless and left in place.
 */
export async function solanaRpc<T = unknown>(
  relayer: Relayer,
  method: string,
  params: unknown[],
): Promise<RpcResult<T>> {
  try {
    const response = await relayer.rpc({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      method,
      params,
    });
    if (response.error) {
      return { ok: false, error: response.error };
    }
    return { ok: true, result: response.result as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error,
      unserializableResult: message.includes(UNSERIALIZABLE_RAW_RESULT),
    };
  }
}
