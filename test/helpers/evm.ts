import {
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { vi } from "vitest";
import type { PluginAPI } from "@openzeppelin/relayer-sdk";
import type { NetworkConfig, SettleRequest } from "../../src/types";
import {
  EIP3009_ABI,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../../src/evm/utils";

// Well-known Hardhat/Anvil test keys — never hold real funds.
export const PAYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const OTHER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export const payerAccount = privateKeyToAccount(PAYER_KEY);
export const otherAccount = privateKeyToAccount(OTHER_KEY);

export const CHAIN_ID = 84532; // Base Sepolia
export const NETWORK = `eip155:${CHAIN_ID}`;
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
export const RELAYER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const AMOUNT = "10000";
export const TX_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

export const networkConfig: NetworkConfig = {
  network: NETWORK,
  type: "evm",
  relayer_id: "base-sepolia-relayer",
  assets: [USDC],
};

export const SELECTORS = {
  balanceOf: toFunctionSelector("balanceOf(address)"),
  authorizationState: toFunctionSelector("authorizationState(address,bytes32)"),
  transferVRS: toFunctionSelector(
    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  ),
  transferBytes: toFunctionSelector(
    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
  ),
};

export type AuthorizationOverrides = Partial<{
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}>;

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Builds a v2 request with an authorization signed via EIP-712, exactly like
 * an x402 EVM client does.
 */
export async function createEvmRequest(
  options: {
    auth?: AuthorizationOverrides;
    signer?: typeof payerAccount;
    domainName?: string;
    domainVersion?: string;
    chainId?: number;
    signature?: Hex;
    requirements?: Record<string, unknown>;
  } = {},
): Promise<SettleRequest> {
  const signer = options.signer ?? payerAccount;
  const authorization = {
    from: payerAccount.address as string,
    to: PAY_TO,
    value: AMOUNT,
    validAfter: String(nowSeconds() - 60),
    validBefore: String(nowSeconds() + 300),
    nonce: ("0x" + "ab".repeat(32)) as Hex,
    ...options.auth,
  };

  const signature =
    options.signature ??
    (await signer.signTypedData({
      domain: {
        name: options.domainName ?? "USDC",
        version: options.domainVersion ?? "2",
        chainId: options.chainId ?? CHAIN_ID,
        verifyingContract: USDC,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as Hex,
        to: authorization.to as Hex,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    }));

  const requirements = {
    scheme: "exact" as const,
    network: NETWORK,
    amount: AMOUNT,
    payTo: PAY_TO,
    asset: USDC,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...options.requirements,
  };

  return {
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { signature, authorization },
    },
    paymentRequirements: requirements,
  };
}

export type MockRelayerOptions = {
  chainId?: number;
  networkType?: string;
  address?: string;
  balance?: bigint;
  nonceUsed?: boolean;
  simulationError?: boolean;
  estimateError?: boolean;
  estimatedGas?: bigint;
  code?: Hex;
  finalStatus?: string;
  waitError?: Error;
};

/**
 * Creates a PluginAPI mock that behaves like the OpenZeppelin Relayer plugin
 * API for an EVM relayer (JSON-RPC passthrough + sendTransaction/wait).
 */
export function createEvmApi(options: MockRelayerOptions = {}) {
  const rpcCalls: { method: string; params: any }[] = [];

  const rpc = vi.fn(async (request: { method: string; params: any }) => {
    rpcCalls.push(request);
    const { method, params } = request;

    switch (method) {
      case "eth_chainId":
        return {
          jsonrpc: "2.0",
          result: "0x" + (options.chainId ?? CHAIN_ID).toString(16),
        };
      case "eth_getCode":
        return { jsonrpc: "2.0", result: options.code ?? "0x" };
      case "eth_estimateGas":
        if (options.estimateError) {
          return {
            jsonrpc: "2.0",
            error: { code: -32000, message: "execution reverted" },
          };
        }
        return {
          jsonrpc: "2.0",
          result: "0x" + (options.estimatedGas ?? 80_000n).toString(16),
        };
      case "eth_call": {
        const data = params[0].data as Hex;
        const selector = data.slice(0, 10);
        if (selector === SELECTORS.balanceOf) {
          return {
            jsonrpc: "2.0",
            result: encodeAbiParameters(
              [{ type: "uint256" }],
              [options.balance ?? 1_000_000n],
            ),
          };
        }
        if (selector === SELECTORS.authorizationState) {
          return {
            jsonrpc: "2.0",
            result: encodeAbiParameters(
              [{ type: "bool" }],
              [options.nonceUsed ?? false],
            ),
          };
        }
        if (
          selector === SELECTORS.transferVRS ||
          selector === SELECTORS.transferBytes
        ) {
          if (options.simulationError) {
            return {
              jsonrpc: "2.0",
              error: {
                code: 3,
                message: "execution reverted: FiatTokenV2: invalid signature",
              },
            };
          }
          return { jsonrpc: "2.0", result: "0x" };
        }
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: "unknown call" },
        };
      }
      default:
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `unsupported ${method}` },
        };
    }
  });

  const wait = vi.fn(async () => {
    if (options.waitError) throw options.waitError;
    return {
      id: "tx-1",
      status: options.finalStatus ?? "mined",
      hash: TX_HASH,
    };
  });

  const sendTransaction = vi.fn(async () => ({
    id: "tx-1",
    relayer_id: networkConfig.relayer_id,
    status: "pending",
    hash: null,
    wait,
  }));

  const getRelayer = vi.fn(async () => ({
    id: networkConfig.relayer_id,
    network: "base-sepolia",
    network_type: options.networkType ?? "evm",
    address: options.address ?? RELAYER_ADDRESS,
  }));

  const relayer = { rpc, sendTransaction, getRelayer };
  const api = {
    useRelayer: vi.fn(() => relayer),
  } as unknown as PluginAPI;

  return { api, relayer, rpcCalls, sendTransaction, wait };
}

export function decodeTransferCall(data: Hex) {
  return decodeFunctionData({ abi: EIP3009_ABI, data });
}
