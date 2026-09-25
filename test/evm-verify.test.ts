import { describe, expect, test } from "vitest";
import { getAddress } from "viem";
import { verify } from "../src/evm/verify";
import {
  AMOUNT,
  PAY_TO,
  RELAYER_ADDRESS,
  SELECTORS,
  USDC,
  createEvmApi,
  createEvmRequest,
  decodeTransferCall,
  networkConfig,
  nowSeconds,
  otherAccount,
  payerAccount,
} from "./helpers/evm";

describe("EVM verify (exact / EIP-3009)", () => {
  test("accepts a correctly signed authorization", async () => {
    const request = await createEvmRequest();
    const { api, rpcCalls } = createEvmApi();

    const result = await verify(request, api, networkConfig);

    expect(result).toEqual({ isValid: true, payer: payerAccount.address });
    // chain check + balance + nonce + simulation all go through the relayer RPC
    const methods = rpcCalls.map((c) => c.method);
    expect(methods).toContain("eth_chainId");
    expect(methods.filter((m) => m === "eth_call")).toHaveLength(3);
  });

  test("simulates transferWithAuthorization from the relayer with the exact authorization", async () => {
    const request = await createEvmRequest();
    const { api, rpcCalls } = createEvmApi();

    await verify(request, api, networkConfig);

    const simulation = rpcCalls.find(
      (c) =>
        c.method === "eth_call" &&
        c.params[0].data.startsWith(SELECTORS.transferVRS),
    )!;
    expect(simulation.params[0].from).toBe(RELAYER_ADDRESS);
    expect(getAddress(simulation.params[0].to)).toBe(getAddress(USDC));
    const decoded = decodeTransferCall(simulation.params[0].data);
    expect(decoded.args[0]).toBe(payerAccount.address);
    expect(decoded.args[1]).toBe(getAddress(PAY_TO));
    expect(decoded.args[2]).toBe(BigInt(AMOUNT));
  });

  test("accepts asset and payTo with different address casing", async () => {
    const request = await createEvmRequest({
      requirements: { asset: USDC.toLowerCase(), payTo: PAY_TO.toLowerCase() },
    });
    const { api } = createEvmApi();

    const result = await verify(request, api, {
      ...networkConfig,
      assets: [USDC.toUpperCase().replace("0X", "0x")],
    });
    expect(result.isValid).toBe(true);
  });

  test("rejects x402 v1 payloads", async () => {
    const request = await createEvmRequest();
    (request.paymentPayload as any).x402Version = 1;
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_x402_version",
    });
  });

  test("rejects non-exact scheme", async () => {
    const request = await createEvmRequest({
      requirements: { scheme: "upto" },
    });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_scheme");
  });

  test("rejects non-CAIP-2 EVM networks", async () => {
    const request = await createEvmRequest({
      requirements: { network: "base-sepolia" },
    });
    const { api } = createEvmApi();

    const result = await verify(request, api, {
      ...networkConfig,
      network: "base-sepolia",
    });
    expect(result.invalidReason).toBe("invalid_network");
  });

  test("rejects when accepted network differs from requirements", async () => {
    const request = await createEvmRequest();
    request.paymentPayload.accepted = {
      ...request.paymentPayload.accepted,
      network: "eip155:8453",
    };
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_network");
  });

  test("rejects assets not in the network allow-list", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi();

    const result = await verify(request, api, {
      ...networkConfig,
      assets: ["0x0000000000000000000000000000000000000001"],
    });
    expect(result.invalidReason).toBe("unsupported_asset");
  });

  test("rejects malformed payloads", async () => {
    const request = await createEvmRequest();
    (request.paymentPayload.payload as any).authorization.nonce = "0x1234";
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_malformed");
  });

  test("rejects a Stellar-shaped payload on an EVM network", async () => {
    const request = await createEvmRequest();
    (request.paymentPayload as any).payload = { transaction: "AAAA" };
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_malformed");
  });

  test("requires the EIP-712 domain (extra.name / extra.version)", async () => {
    const request = await createEvmRequest({
      requirements: { extra: { areFeesSponsored: true } },
    });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_missing_eip712_domain",
    );
  });

  test("rejects when the configured relayer is not an EVM relayer", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ networkType: "stellar" });

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("verify_network_mismatch");
  });

  test("rejects when the relayer is on a different chain", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ chainId: 8453 });

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("verify_network_mismatch");
  });

  test("rejects authorizations to a different recipient", async () => {
    const request = await createEvmRequest({
      auth: { to: "0x000000000000000000000000000000000000dEaD" },
    });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_recipient_mismatch",
    );
  });

  test("rejects authorizations for a different amount", async () => {
    const request = await createEvmRequest({ auth: { value: "9999" } });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_authorization_value",
    );
  });

  test("rejects when the payer is the facilitator itself", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ address: payerAccount.address });

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_unsafe_from_address",
    );
  });

  test("rejects authorizations that are not yet valid", async () => {
    const request = await createEvmRequest({
      auth: { validAfter: String(nowSeconds() + 120) },
    });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_authorization_valid_after",
    );
  });

  test("rejects authorizations that expire too soon", async () => {
    const request = await createEvmRequest({
      auth: { validBefore: String(nowSeconds() + 2) },
    });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    );
  });

  test("rejects signatures from a different key", async () => {
    const request = await createEvmRequest({ signer: otherAccount });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_signature");
  });

  test("rejects signatures for a different EIP-712 domain (chain replay)", async () => {
    const request = await createEvmRequest({ chainId: 8453 });
    const { api } = createEvmApi();

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_signature");
  });

  test("defers non-ECDSA signatures of contract wallets to on-chain simulation", async () => {
    const request = await createEvmRequest({
      signature: ("0x" + "12".repeat(100)) as `0x${string}`,
    });
    const { api, rpcCalls } = createEvmApi({ code: "0x6080604052" });

    const result = await verify(request, api, networkConfig);
    expect(result.isValid).toBe(true);
    const simulation = rpcCalls.find(
      (c) =>
        c.method === "eth_call" &&
        c.params[0].data.startsWith(SELECTORS.transferBytes),
    );
    expect(simulation).toBeDefined();
  });

  test("rejects non-ECDSA signatures from EOAs", async () => {
    const request = await createEvmRequest({
      signature: ("0x" + "12".repeat(100)) as `0x${string}`,
    });
    const { api } = createEvmApi({ code: "0x" });

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_signature");
  });

  test("rejects payers with insufficient balance", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ balance: 9_999n });

    const result = await verify(request, api, networkConfig);
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "insufficient_funds",
      payer: payerAccount.address,
    });
  });

  test("rejects already used nonces", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ nonceUsed: true });

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("invalid_exact_evm_payload_nonce_used");
  });

  test("rejects when the transfer simulation reverts", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ simulationError: true });

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe(
      "invalid_exact_evm_payload_simulation_failed",
    );
  });

  test("returns unexpected_verify_error when the relayer throws", async () => {
    const request = await createEvmRequest();
    const { api, relayer } = createEvmApi();
    relayer.getRelayer.mockRejectedValueOnce(new Error("relayer down"));

    const result = await verify(request, api, networkConfig);
    expect(result.invalidReason).toBe("unexpected_verify_error");
  });
});
