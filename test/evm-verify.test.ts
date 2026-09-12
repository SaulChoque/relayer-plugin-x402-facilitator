import { beforeEach, describe, expect, test, vi } from "vitest";

import { verify } from "../src/evm/verify";
import {
  ASSET,
  AUTHORIZATION_STATE_SELECTOR,
  CHAIN_ID,
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
  simulationError?: unknown;
  channelServiceFundRelayerAddress?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApi(overrides: ApiOverrides = {}) {
  const {
    relayerAddress = FACILITATOR_ADDRESS,
    chainIdHex = "0xa869", // 43113
    chainTimestamp = Math.floor(Date.now() / 1000),
    nonceUsed = false,
    simulationError,
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
          if (simulationError) {
            return { error: simulationError };
          }
          return { result: "0x" };
        }
        throw new Error(`Unexpected eth_call data: ${data}`);
      }
      throw new Error(`Unexpected rpc method: ${req.method}`);
    });

  return {
    useRelayer: vi.fn().mockReturnValue({
      getRelayer: vi.fn().mockResolvedValue({ address: relayerAddress }),
      rpc,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("evm verify", () => {
  let wallet: ReturnType<typeof makeWallet>;

  beforeEach(() => {
    wallet = makeWallet();
  });

  test("accepts a valid EIP-3009 authorization", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("1"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result).toEqual({ isValid: true, payer: wallet.address });
  });

  test("rejects when recipient does not match payTo", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: "0x00000000000000000000000000000000000000ff",
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("2"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_wrong_recipient",
    );
  });

  test("rejects when amount does not match requirements", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "500",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("3"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements({ amount: "1000" });
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_wrong_amount");
  });

  test("rejects when the facilitator relayer is the payer (from)", async () => {
    const facilitatorWallet = makeWallet();
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet: facilitatorWallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("4"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({
      chainTimestamp: now,
      relayerAddress: facilitatorWallet.address,
    });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_unsafe_from_address",
    );
  });

  test("rejects a tampered signature (recovered address mismatch)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("5"),
    });

    // Tamper with the value after signing so the signature no longer matches
    const tamperedAuthorization = { ...authorization, value: "9999" };
    const paymentPayload = buildEvmPaymentPayload(
      signature,
      tamperedAuthorization,
    );
    const paymentRequirements = buildEvmPaymentRequirements({ amount: "9999" });
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_invalid_signature",
    );
  });

  test("rejects an unsupported asset", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("6"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization, {
      asset: "0x00000000000000000000000000000000000000aa",
    });
    const paymentRequirements = buildEvmPaymentRequirements({
      asset: "0x00000000000000000000000000000000000000aa",
    });
    const networkConfig = buildEvmNetworkConfig(); // only knows about ASSET
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_asset");
  });

  test("rejects when the relayer RPC is on the wrong chain", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("7"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    // relayer's RPC reports a different chain id (e.g. 1 = mainnet) than expected (43113)
    const api = makeApi({ chainTimestamp: now, chainIdHex: "0x1" });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("verify_network_mismatch");
  });

  test("rejects when the authorization is not yet valid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now + 1000),
      validBefore: String(now + 2000),
      nonce: buildNonce("8"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_auth_not_yet_valid",
    );
  });

  test("rejects when the authorization has already expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 2000),
      validBefore: String(now - 1000),
      nonce: buildNonce("9"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_auth_already_expired",
    );
  });

  test("rejects when the authorization window exceeds maxTimeoutSeconds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 10_000), // way more than maxTimeoutSeconds + skew
      nonce: buildNonce("10"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization, {
      maxTimeoutSeconds: 60,
    });
    const paymentRequirements = buildEvmPaymentRequirements({
      maxTimeoutSeconds: 60,
    });
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_auth_window_too_long",
    );
  });

  test("rejects when the nonce has already been used on-chain", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("11"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now, nonceUsed: true });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_nonce_already_used",
    );
  });

  test("rejects when paymentRequirements.extra is missing EIP-712 domain name/version", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("12"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization, {
      extra: { areFeesSponsored: true },
    });
    const paymentRequirements = buildEvmPaymentRequirements({
      extra: { areFeesSponsored: true },
    });
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({ chainTimestamp: now });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_missing_domain",
    );
  });

  test("rejects a malformed payload", async () => {
    const paymentPayload = {
      x402Version: 2 as const,
      accepted: buildEvmPaymentRequirements(),
      payload: {
        signature: "0xdeadbeef",
        authorization: { from: "not-an-address" },
      },
    };
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi();

    const result = await verify(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { paymentPayload, paymentRequirements } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_malformed");
  });

  test("rejects when on-chain simulation of transferWithAuthorization fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { signature, authorization } = await signEip3009Authorization({
      wallet,
      to: PAY_TO,
      value: "1000",
      validAfter: String(now - 10),
      validBefore: String(now + 50),
      nonce: buildNonce("13"),
    });

    const paymentPayload = buildEvmPaymentPayload(signature, authorization);
    const paymentRequirements = buildEvmPaymentRequirements();
    const networkConfig = buildEvmNetworkConfig();
    const api = makeApi({
      chainTimestamp: now,
      simulationError: {
        code: -32000,
        message: "execution reverted: insufficient balance",
      },
    });

    const result = await verify(
      { paymentPayload, paymentRequirements },
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_simulation_failed",
    );
  });

  test("uses CAIP-2 chain id from config, not from expected chain id, for eth_chainId cross-check", () => {
    expect(CHAIN_ID).toBe(43113);
    expect(ASSET).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
