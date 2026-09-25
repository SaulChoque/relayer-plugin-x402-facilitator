/**
 * Shared utility functions for EVM payment processing (x402 `exact` scheme, EIP-3009)
 */
import {
  type Hex,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  parseSignature,
} from "viem";
import type { Relayer } from "@openzeppelin/relayer-sdk";
import type { ExactEvmPayload } from "../types";

// Default timeout in seconds for payment operations
export const DEFAULT_TIMEOUT_SECONDS = 60;

// Minimum time (seconds) an authorization must remain valid for, so that the
// settlement transaction has a realistic chance of being mined before
// `validBefore` elapses. Matches the x402 reference facilitator.
export const MIN_VALIDITY_BUFFER_SECONDS = 6;

// Extra gas added on top of the `eth_estimateGas` result (percentage).
export const GAS_LIMIT_BUFFER_PERCENT = 20n;

export const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const EIP155_NETWORK_REGEX = /^eip155:([1-9][0-9]*)$/;

/**
 * Parses a CAIP-2 EVM network identifier (e.g. "eip155:8453") into its chain ID.
 *
 * @returns The chain ID, or null if the identifier is not a valid `eip155` network
 */
export function parseEvmChainId(network: string): number | null {
  const match = EIP155_NETWORK_REGEX.exec(network);
  if (!match) {
    return null;
  }
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) ? chainId : null;
}

/**
 * Validates that a network identifier is a CAIP-2 EVM network ("eip155:<chainId>").
 */
export function isValidEvmNetwork(network: string): boolean {
  return parseEvmChainId(network) !== null;
}

/**
 * Case-insensitive EVM address comparison. Returns false for invalid addresses.
 */
export function addressesEqual(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (!a || !b || !isAddress(a, { strict: false })) return false;
  if (!isAddress(b, { strict: false })) return false;
  return getAddress(a) === getAddress(b);
}

const UINT_STRING_REGEX = /^[0-9]+$/;

/**
 * Checks the shape of an `exact` EVM payload (EIP-3009 authorization + signature).
 */
export function isValidExactEvmPayload(
  payload: unknown,
): payload is ExactEvmPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const { signature, authorization } = payload as Record<string, unknown>;

  if (typeof signature !== "string" || !isHex(signature, { strict: true })) {
    return false;
  }
  if (typeof authorization !== "object" || authorization === null) {
    return false;
  }

  const auth = authorization as Record<string, unknown>;
  return (
    typeof auth.from === "string" &&
    isAddress(auth.from, { strict: false }) &&
    typeof auth.to === "string" &&
    isAddress(auth.to, { strict: false }) &&
    typeof auth.value === "string" &&
    UINT_STRING_REGEX.test(auth.value) &&
    typeof auth.validAfter === "string" &&
    UINT_STRING_REGEX.test(auth.validAfter) &&
    typeof auth.validBefore === "string" &&
    UINT_STRING_REGEX.test(auth.validBefore) &&
    typeof auth.nonce === "string" &&
    isHex(auth.nonce, { strict: true }) &&
    auth.nonce.length === 66
  );
}

/**
 * Encodes the `transferWithAuthorization` call for an EIP-3009 token.
 *
 * A 65-byte ECDSA signature uses the widely supported `(v, r, s)` overload.
 * Any other signature (e.g. ERC-1271 smart wallet signatures) uses the
 * `bytes signature` overload introduced in FiatToken v2.2.
 */
export function encodeTransferWithAuthorization(payload: ExactEvmPayload): Hex {
  const { authorization } = payload;
  const signature = payload.signature as Hex;
  const baseArgs = [
    getAddress(authorization.from),
    getAddress(authorization.to),
    BigInt(authorization.value),
    BigInt(authorization.validAfter),
    BigInt(authorization.validBefore),
    authorization.nonce as Hex,
  ] as const;

  // 0x + 65 bytes
  if (signature.length === 132) {
    const { r, s, v, yParity } = parseSignature(signature);
    const vValue = v !== undefined ? Number(v) : yParity + 27;
    return encodeFunctionData({
      abi: EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [...baseArgs, vValue, r, s],
    });
  }

  return encodeFunctionData({
    abi: EIP3009_ABI,
    functionName: "transferWithAuthorization",
    args: [...baseArgs, signature],
  });
}

export type RpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: unknown };

/**
 * Performs a JSON-RPC call through the relayer's EVM provider.
 */
export async function evmRpc<T = unknown>(
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
    return { ok: false, error };
  }
}

/**
 * Builds an `eth_call` / `eth_estimateGas` call object.
 */
export function callObject(
  to: string,
  data: Hex,
  from?: string,
): Record<string, string> {
  return from ? { from, to, data } : { to, data };
}
