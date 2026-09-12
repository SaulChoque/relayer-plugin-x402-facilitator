/**
 * Shared utility functions for EVM payment processing (EIP-3009 "exact" scheme).
 */
import type { Relayer } from "@openzeppelin/relayer-sdk";

// Default timeout in seconds for payment operations
export const DEFAULT_TIMEOUT_SECONDS = 60;

// Tolerance for clock drift between the facilitator/chain and the client that
// signed the authorization window. Kept small since it only widens the
// acceptance window, never narrows the security guarantees of validAfter/validBefore.
export const CLOCK_SKEW_TOLERANCE_SECONDS = 30;

const CAIP2_EVM_PREFIX = "eip155:";

/**
 * Validates that a network identifier is a recognized CAIP-2 EVM network,
 * e.g. "eip155:43113" (Avalanche Fuji) or "eip155:133" (HSK testnet).
 */
export function isValidEvmNetwork(network: string): boolean {
  return /^eip155:(0|[1-9]\d*)$/.test(network);
}

/**
 * Extracts the numeric chain id from a CAIP-2 EVM network identifier.
 * Returns null if the network is not a valid "eip155:<chainId>" identifier.
 */
export function getChainIdFromNetwork(network: string): number | null {
  if (!isValidEvmNetwork(network)) {
    return null;
  }
  return Number(network.slice(CAIP2_EVM_PREFIX.length));
}

/**
 * Checks if two network identifiers match (exact string match; CAIP-2 EVM
 * identifiers are already canonical, unlike Stellar's legacy/CAIP-2 duality).
 */
export function networksMatch(network1: string, network2: string): boolean {
  return network1 === network2;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/**
 * Case-insensitive EVM address comparison.
 */
export function addressesEqual(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeAddress(a) === normalizeAddress(b);
}

export function isValidHexAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isValidBytes32(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isValidUintString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return BigInt(value) >= 0n;
  } catch {
    return false;
  }
}

function rpcId(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/**
 * Fetches the chain id the relayer's configured RPC node is actually
 * connected to, so verification doesn't rely on trusting the network's
 * config label alone.
 */
export async function getRelayerChainId(relayer: Relayer): Promise<number> {
  const response = await relayer.rpc({
    method: "eth_chainId",
    id: rpcId(),
    jsonrpc: "2.0",
    params: [],
  });

  if (response.error || !response.result) {
    throw new Error(
      `Failed to fetch chain id from relayer RPC: ${JSON.stringify(response.error)}`,
    );
  }

  return parseInt(response.result as string, 16);
}

/**
 * Fetches the latest block timestamp from the chain, used instead of the
 * facilitator's local clock to validate the validAfter/validBefore window.
 */
export async function getChainTimestampSeconds(
  relayer: Relayer,
): Promise<bigint> {
  const response = await relayer.rpc({
    method: "eth_getBlockByNumber",
    id: rpcId(),
    jsonrpc: "2.0",
    params: ["latest", false],
  });

  if (response.error || !response.result) {
    throw new Error(
      `Failed to fetch latest block: ${JSON.stringify(response.error)}`,
    );
  }

  const block = response.result as { timestamp: string };
  return BigInt(block.timestamp);
}

/**
 * Performs a read-only eth_call against the relayer's configured RPC node.
 */
export async function ethCall(
  relayer: Relayer,
  to: string,
  data: string,
): Promise<string> {
  const response = await relayer.rpc({
    method: "eth_call",
    id: rpcId(),
    jsonrpc: "2.0",
    params: [{ to, data }, "latest"],
  });

  if (response.error) {
    throw new Error(`eth_call failed: ${JSON.stringify(response.error)}`);
  }

  return response.result as string;
}
