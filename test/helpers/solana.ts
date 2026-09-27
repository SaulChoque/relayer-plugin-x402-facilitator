import {
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { vi } from "vitest";
import type { PluginAPI, PluginKVStore } from "@openzeppelin/relayer-sdk";
import type { NetworkConfig, SettleRequest } from "../../src/types";
import {
  MEMO_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/solana/utils";

/** Memo instruction exactly as the x402 SVM client builds it (no accounts). */
export function memoInstruction(
  memo: string,
  accounts: Instruction["accounts"] = [],
): Instruction {
  return {
    programAddress: address(MEMO_PROGRAM_ADDRESS),
    accounts,
    data: new TextEncoder().encode(memo),
  } as Instruction;
}

export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // devnet
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1ENhsjb8Z3Ew";
export const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const AMOUNT = "10000";
export const BLOCKHASH =
  "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Blockhash;

export type Actors = {
  relayer: KeyPairSigner;
  payer: KeyPairSigner;
  payTo: KeyPairSigner;
};

let cachedActors: Actors | undefined;
export async function actors(): Promise<Actors> {
  cachedActors ??= {
    relayer: await generateKeyPairSigner(),
    payer: await generateKeyPairSigner(),
    payTo: await generateKeyPairSigner(),
  };
  return cachedActors;
}

export async function networkConfig(): Promise<NetworkConfig> {
  return {
    network: NETWORK,
    type: "solana",
    relayer_id: "solana-relayer",
    assets: [USDC],
  };
}

export type BuildOptions = {
  version?: 0 | "legacy";
  amount?: bigint;
  mint?: string;
  destinationOwner?: Address;
  authority?: KeyPairSigner;
  feePayer?: Address;
  microLamports?: bigint;
  memo?: string | null;
  instructions?: (defaults: Instruction[]) => Instruction[];
  extra?: Record<string, unknown>;
  signers?: "all" | "none";
};

/**
 * Builds a request exactly like the x402 SVM client: ComputeUnitLimit,
 * ComputeUnitPrice, TransferChecked and a Memo, fee payer = relayer,
 * partially signed by the payer.
 */
export async function createSvmRequest(
  options: BuildOptions = {},
): Promise<SettleRequest> {
  const { relayer, payer, payTo } = await actors();
  const authority = options.authority ?? payer;
  const mint = address(options.mint ?? USDC);
  const feePayer = options.feePayer ?? relayer.address;

  const [source] = await findAssociatedTokenPda({
    owner: authority.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
  });
  const [destination] = await findAssociatedTokenPda({
    owner: options.destinationOwner ?? payTo.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
  });

  const defaults: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 20_000 }),
    getSetComputeUnitPriceInstruction({
      microLamports: options.microLamports ?? 1n,
    }),
    getTransferCheckedInstruction({
      source,
      mint,
      destination,
      authority,
      amount: options.amount ?? BigInt(AMOUNT),
      decimals: 6,
    }),
  ];
  if (options.memo !== null) {
    defaults.push(
      memoInstruction(options.memo ?? "0123456789abcdef0123456789abcdef"),
    );
  }
  const instructions = options.instructions
    ? options.instructions(defaults)
    : defaults;

  const message = pipe(
    createTransactionMessage({ version: options.version ?? 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  let transaction = getBase64EncodedWireTransaction(signed);
  if (options.signers === "none") {
    const decoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(transaction),
    );
    const cleared = Object.fromEntries(
      Object.keys(decoded.signatures).map((k) => [k, null]),
    );
    transaction = getBase64Decoder().decode(
      getTransactionEncoder().encode({
        ...decoded,
        signatures: cleared,
      } as never),
    );
  }

  const requirements = {
    scheme: "exact" as const,
    network: NETWORK,
    amount: AMOUNT,
    payTo: payTo.address as string,
    asset: USDC,
    maxTimeoutSeconds: 10,
    extra: { feePayer: relayer.address as string, ...options.extra },
  };
  return {
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction },
    },
    paymentRequirements: requirements,
  };
}

/** Adds the relayer's fee payer signature, like the relayer's signTransaction. */
export async function relayerSign(
  base64: string,
  relayer: KeyPairSigner,
): Promise<string> {
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(base64),
  );
  const signature = await signBytes(
    relayer.keyPair.privateKey,
    decoded.messageBytes as never,
  );
  const signatures = { ...decoded.signatures, [relayer.address]: signature };
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({ ...decoded, signatures } as never),
  );
}

export function firstSignature(base64: string): string {
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(base64),
  );
  return getBase58Decoder().decode(Object.values(decoded.signatures)[0]!);
}

export type MockSolanaOptions = {
  networkType?: string;
  relayerNetwork?: string;
  feePaymentStrategy?: string | null;
  genesis?: string | "unserializable";
  simulationErr?: unknown;
  simulationRpcError?: boolean;
  sendError?: unknown;
  sendUnserializable?: boolean;
  statuses?: ({ err: unknown; confirmationStatus: string } | null)[];
  tamper?: "message" | "client-signature" | "no-signature";
};

/**
 * PluginAPI mock that behaves like the OpenZeppelin Relayer for a Solana
 * relayer: raw JSON-RPC passthrough (`"method": "rawRpc"` tagged objects)
 * and signTransaction adding a real fee payer signature.
 */
export async function createSolanaApi(options: MockSolanaOptions = {}) {
  const { relayer: relayerKey } = await actors();
  const rpcCalls: { method: string; params: any }[] = [];
  let statusIndex = 0;

  const rpc = vi.fn(async (request: { method: string; params: any }) => {
    rpcCalls.push(request);
    switch (request.method) {
      case "getGenesisHash":
        if ((options.genesis ?? "unserializable") === "unserializable") {
          throw new Error(
            "Relayer error: cannot serialize tagged newtype variant SolanaRpcResult::RawRpc containing a string",
          );
        }
        return { jsonrpc: "2.0", result: options.genesis };
      case "simulateTransaction":
        if (options.simulationRpcError) {
          return {
            jsonrpc: "2.0",
            error: { code: -32602, message: "invalid transaction" },
          };
        }
        return {
          jsonrpc: "2.0",
          result: {
            method: "rawRpc",
            context: { slot: 1 },
            value: { err: options.simulationErr ?? null, logs: [] },
          },
        };
      case "sendTransaction":
        if (options.sendUnserializable) {
          throw new Error(
            "Relayer error: cannot serialize tagged newtype variant SolanaRpcResult::RawRpc containing a string",
          );
        }
        if (options.sendError)
          return { jsonrpc: "2.0", error: options.sendError };
        return { jsonrpc: "2.0", result: firstSignature(request.params[0]) };
      case "getSignatureStatuses": {
        const statuses = options.statuses ?? [
          { err: null, confirmationStatus: "confirmed" },
        ];
        const status = statuses[Math.min(statusIndex++, statuses.length - 1)];
        return {
          jsonrpc: "2.0",
          result: { method: "rawRpc", context: { slot: 1 }, value: [status] },
        };
      }
      default:
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `unsupported ${request.method}` },
        };
    }
  });

  const signTransaction = vi.fn(
    async ({ transaction }: { transaction: string }) => {
      let signed = await relayerSign(transaction, relayerKey);
      if (options.tamper) {
        const decoded = getTransactionDecoder().decode(
          getBase64Encoder().encode(signed),
        );
        const signatures = { ...decoded.signatures } as Record<string, any>;
        let messageBytes = decoded.messageBytes as Uint8Array;
        if (options.tamper === "message") {
          messageBytes = new Uint8Array(messageBytes);
          messageBytes[messageBytes.length - 1] ^= 1;
        } else if (options.tamper === "client-signature") {
          const client = Object.keys(signatures).find(
            (k) => k !== relayerKey.address,
          )!;
          signatures[client] = new Uint8Array(64);
        } else {
          signatures[relayerKey.address] = null;
        }
        signed = getBase64Decoder().decode(
          getTransactionEncoder().encode({ messageBytes, signatures } as never),
        );
      }
      return {
        transaction: signed,
        signature: options.tamper ? "" : firstSignature(signed),
      };
    },
  );

  const getRelayer = vi.fn(async () => ({
    id: "solana-relayer",
    network: options.relayerNetwork ?? "devnet",
    network_type: options.networkType ?? "solana",
    address: relayerKey.address as string,
    policies:
      options.feePaymentStrategy === null
        ? { min_balance: 0 }
        : {
            fee_payment_strategy: options.feePaymentStrategy ?? "relayer",
            min_balance: 0,
          },
  }));

  const relayer = { rpc, signTransaction, getRelayer };
  const api = { useRelayer: vi.fn(() => relayer) } as unknown as PluginAPI;
  return { api, relayer, rpcCalls, signTransaction };
}

/** In-memory PluginKVStore with the subset used by the plugin. */
export function createKv(): PluginKVStore {
  const store = new Map<string, unknown>();
  const locks = new Set<string>();
  return {
    get: async (key: string) => (store.get(key) as any) ?? null,
    set: async (key: string, value: unknown) => {
      store.set(key, value);
      return true;
    },
    del: async (key: string) => store.delete(key),
    exists: async (key: string) => store.has(key),
    listKeys: async () => [...store.keys()],
    clear: async () => {
      const n = store.size;
      store.clear();
      return n;
    },
    withLock: async (
      key: string,
      fn: () => Promise<any>,
      opts?: { onBusy?: string },
    ) => {
      if (locks.has(key)) {
        if (opts?.onBusy === "skip") return null;
        throw new Error("busy");
      }
      locks.add(key);
      try {
        return await fn();
      } finally {
        locks.delete(key);
      }
    },
  } as unknown as PluginKVStore;
}
