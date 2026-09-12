import { describe, expect, test, vi } from "vitest";

import { settle } from "../src/evm/settle";
import {
  AUTHORIZATION_STATE_SELECTOR,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  buildEvmNetworkConfig,
  buildEvmPaymentPayload,
  buildEvmPaymentRequirements,
  buildNonce,
  encodeAuthorizationStateResult,
  makeWallet,
  signEip3009Authorization,
} from "./helpers/evmPayload";

const FACILITATOR_ADDRESS = "0x00000000000000000000000000000000000fac17";
const PAY_TO = "0x0000000000000000000000000000000000000f00";

type ApiOverrides = {
  relayerAddress?: string;
  chainIdHex?: string;
  chainTimestamp?: number;
  nonceUsed?: boolean;
  sendTransactionImpl?: () => Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApi(overrides: ApiOverrides = {}) {
  const {
    relayerAddress = FACILITATOR_ADDRESS,
    chainIdHex = "0xa869",
    chainTimestamp = Math.floor(Date.now() / 1000),
    nonceUsed = false,
    sendTransactionImpl,
  } = overrides;

  const rpc = vi
    .fn()
    .mockImplementation(async (req: { method: string; params: unknown }) => {
      if (req.method === "eth_chainId") {
        return { result: chainIdHex };
      }
      if (req.method === "eth_getBlockByNumber") {
        return { result: { timestamp: "0x" + chainTimestamp.toString(16) } };
      }
      if (req.method === "eth_call") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [call] = req.params as any[];
        const data = call.data as string;
        if (data.startsWith(AUTHORIZATION_STATE_SELECTOR)) {
          return { result: encodeAuthorizationStateResult(nonceUsed) };
        }
        if (data.startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)) {
          return { result: "0x" };
        }
        throw new Error(`Unexpected eth_call data: ${data}`);
      }
      throw new Error(`Unexpected rpc method: ${req.method}`);
    });

  const defaultSendTransaction = vi.fn().mockResolvedValue({
    wait: vi.fn().mockResolvedValue({
      status: "confirmed",
      hash: "0xabc123",
    }),
  });

  return {
    useRelayer: vi.fn().mockReturnValue({
      getRelayer: vi.fn().mockResolvedValue({ address: relayerAddress }),
      rpc,
      sendTransaction: sendTransactionImpl ?? defaultSendTransaction,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("evm settle", () => {
  test("settles a valid payment and returns the transaction hash", async () => {
    const wallet = makeWallet();
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("settle-1"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await settle(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xabc123");
    expect(result.payer).toBe(wallet.address);
  });

  test("propagates verify failures without submitting a transaction", async () => {
    const wallet = makeWallet();
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: "0x00000000000000000000000000000000000000ff", // wrong recipient
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("settle-2"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const sendTransaction = vi.fn();
    const api = makeApi({
      chainTimestamp: now,
      sendTransactionImpl: sendTransaction,
    });

    const result = await settle(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(
      "invalid_exact_evm_payload_wrong_recipient",
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("reports failure when the relayer transaction does not confirm", async () => {
    const wallet = makeWallet();
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("settle-3"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const sendTransactionImpl = vi.fn().mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ status: "failed", hash: "0xdead" }),
    });
    const api = makeApi({ chainTimestamp: now, sendTransactionImpl });

    const result = await settle(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_exact_evm_transaction_failed");
    expect(result.transaction).toBe("0xdead");
  });

  test("rejects a network mismatch before verifying", async () => {
    const wallet = makeWallet();
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("settle-4"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization, {
      network: "eip155:1",
    });
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await settle(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_exact_evm_network_mismatch");
  });
});
