import { describe, expect, test } from "vitest";
import { getAddress } from "viem";
import { settle } from "../src/evm/settle";
import {
  AMOUNT,
  NETWORK,
  PAY_TO,
  SELECTORS,
  TX_HASH,
  USDC,
  createEvmApi,
  createEvmRequest,
  decodeTransferCall,
  networkConfig,
  payerAccount,
} from "./helpers/evm";

describe("EVM settle (exact / EIP-3009)", () => {
  test("submits transferWithAuthorization through the relayer and returns the hash", async () => {
    const request = await createEvmRequest();
    const { api, sendTransaction, wait } = createEvmApi({
      estimatedGas: 100_000n,
    });

    const result = await settle(request, api, networkConfig);

    expect(result).toEqual({
      success: true,
      transaction: TX_HASH,
      network: NETWORK,
      payer: payerAccount.address,
    });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const txRequest = (sendTransaction.mock.calls[0] as any[])[0];

    // Shape accepted by the relayer's EvmTransactionRequest validation:
    // `to`/`data` set, `value` numeric, exactly one pricing mode (speed)
    expect(txRequest).toMatchObject({
      to: USDC,
      value: 0,
      speed: "fast",
      gas_limit: 120_000,
    });
    expect(txRequest.gas_price).toBeUndefined();
    expect(txRequest.max_fee_per_gas).toBeUndefined();
    expect(txRequest).not.toHaveProperty("network");

    // valid_until mirrors the authorization's validBefore (RFC 3339)
    const validBefore = Number(
      (request.paymentPayload.payload as any).authorization.validBefore,
    );
    expect(Date.parse(txRequest.valid_until)).toBe(validBefore * 1000);

    // calldata is the client's authorization, unmodified
    expect(txRequest.data.startsWith(SELECTORS.transferVRS)).toBe(true);
    const decoded = decodeTransferCall(txRequest.data);
    expect(decoded.functionName).toBe("transferWithAuthorization");
    expect(decoded.args[0]).toBe(payerAccount.address);
    expect(decoded.args[1]).toBe(getAddress(PAY_TO));
    expect(decoded.args[2]).toBe(BigInt(AMOUNT));

    expect(wait).toHaveBeenCalledWith(
      expect.objectContaining({ interval: 1000 }),
    );
  });

  test("treats a confirmed transaction as success", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ finalStatus: "confirmed" });

    const result = await settle(request, api, networkConfig);
    expect(result.success).toBe(true);
  });

  test("uses the configured evm_speed", async () => {
    const request = await createEvmRequest();
    const { api, sendTransaction } = createEvmApi();

    await settle(request, api, { ...networkConfig, evm_speed: "fastest" });
    expect((sendTransaction.mock.calls[0] as any[])[0].speed).toBe("fastest");
  });

  test("does not submit when verification fails", async () => {
    const request = await createEvmRequest({ auth: { value: "1" } });
    const { api, sendTransaction } = createEvmApi();

    const result = await settle(request, api, networkConfig);
    expect(result).toMatchObject({
      success: false,
      errorReason: "invalid_exact_evm_payload_authorization_value",
      transaction: "",
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("does not submit when the nonce was already used (replay)", async () => {
    const request = await createEvmRequest();
    const { api, sendTransaction } = createEvmApi({ nonceUsed: true });

    const result = await settle(request, api, networkConfig);
    expect(result.errorReason).toBe("invalid_exact_evm_payload_nonce_used");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("returns an error when gas estimation fails", async () => {
    const request = await createEvmRequest();
    const { api, sendTransaction } = createEvmApi({ estimateError: true });

    const result = await settle(request, api, networkConfig);
    expect(result.errorReason).toBe("settle_exact_evm_gas_estimation_failed");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("returns failure with the hash when the transaction reverts", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ finalStatus: "failed" });

    const result = await settle(request, api, networkConfig);
    expect(result).toMatchObject({
      success: false,
      errorReason: "settle_exact_evm_transaction_failed",
      transaction: TX_HASH,
      payer: payerAccount.address,
    });
  });

  test("returns failure when the transaction expires", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({ finalStatus: "expired" });

    const result = await settle(request, api, networkConfig);
    expect(result.errorReason).toBe("settle_exact_evm_transaction_failed");
  });

  test("returns a timeout error when waiting exceeds the budget", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi({
      waitError: new Error("Transaction tx-1 timed out after 58000ms"),
    });

    const result = await settle(request, api, networkConfig);
    expect(result).toMatchObject({
      success: false,
      errorReason: "settle_exact_evm_transaction_timeout",
    });
  });

  test("returns network mismatch when config network differs", async () => {
    const request = await createEvmRequest();
    const { api, sendTransaction } = createEvmApi();

    const result = await settle(request, api, {
      ...networkConfig,
      network: "eip155:8453",
    });
    expect(result.errorReason).toBe("settle_exact_evm_network_mismatch");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("returns unexpected_settle_error when sendTransaction throws", async () => {
    const request = await createEvmRequest();
    const { api, sendTransaction } = createEvmApi();
    sendTransaction.mockRejectedValueOnce(
      new Error("Transaction target address is not whitelisted"),
    );

    const result = await settle(request, api, networkConfig);
    expect(result).toMatchObject({
      success: false,
      errorReason: "unexpected_settle_error",
      payer: payerAccount.address,
    });
  });
});
