import { describe, expect, test } from "vitest";
import { settle } from "../src/solana/settle";
import { handler } from "../src/handler";
import {
  NETWORK,
  actors,
  createKv,
  createSolanaApi,
  createSvmRequest,
  firstSignature,
  networkConfig,
} from "./helpers/solana";

describe("Solana settle (exact / SVM)", () => {
  test("signs through the relayer, sends and confirms", async () => {
    const { payer } = await actors();
    const request = await createSvmRequest();
    const { api, rpcCalls, signTransaction } = await createSolanaApi();

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );

    expect(result.success).toBe(true);
    expect(result.payer).toBe(payer.address);
    expect(result.network).toBe(NETWORK);

    // The relayer receives the client transaction untouched
    expect(signTransaction).toHaveBeenCalledWith({
      transaction: (request.paymentPayload.payload as any).transaction,
    });
    const sent = rpcCalls.find((c) => c.method === "sendTransaction")!;
    expect(sent.params[1]).toMatchObject({
      encoding: "base64",
      skipPreflight: false,
    });
    // The transaction id is the fee payer signature added by the relayer
    expect(result.transaction).toBe(firstSignature(sent.params[0]));
  });

  test("settles legacy transactions", async () => {
    const request = await createSvmRequest({ version: "legacy" });
    const { api } = await createSolanaApi();

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result.success).toBe(true);
  });

  test("works with relayers that cannot serialize the sendTransaction result", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi({ sendUnserializable: true });

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result.success).toBe(true);
  });

  test("waits until the transaction is confirmed", async () => {
    const request = await createSvmRequest();
    const { api, rpcCalls } = await createSolanaApi({
      statuses: [
        null,
        { err: null, confirmationStatus: "processed" },
        { err: null, confirmationStatus: "confirmed" },
      ],
    });

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result.success).toBe(true);
    expect(
      rpcCalls.filter((c) => c.method === "getSignatureStatuses"),
    ).toHaveLength(3);
  });

  test("does not sign when verification fails", async () => {
    const request = await createSvmRequest({ amount: 1n });
    const { api, signTransaction } = await createSolanaApi();

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result).toMatchObject({
      success: false,
      errorReason: "invalid_exact_svm_payload_amount_mismatch",
      transaction: "",
    });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  test("rejects duplicate settlements of the same transaction", async () => {
    const request = await createSvmRequest();
    const kv = createKv();
    const first = await createSolanaApi();
    const second = await createSolanaApi();

    expect(
      (await settle(request, first.api, await networkConfig(), kv)).success,
    ).toBe(true);
    const duplicate = await settle(
      request,
      second.api,
      await networkConfig(),
      kv,
    );
    expect(duplicate.errorReason).toBe("duplicate_settlement");
    expect(second.signTransaction).not.toHaveBeenCalled();
  });

  test("rejects concurrent duplicate settlements", async () => {
    const request = await createSvmRequest();
    const kv = createKv();
    const { api } = await createSolanaApi();

    const results = await Promise.all([
      settle(request, api, await networkConfig(), kv),
      settle(request, api, await networkConfig(), kv),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(
      results.filter((r) => r.errorReason === "duplicate_settlement"),
    ).toHaveLength(1);
  });

  for (const tamper of [
    "message",
    "client-signature",
    "no-signature",
  ] as const) {
    test(`refuses to send when the relayer returns a tampered transaction (${tamper})`, async () => {
      const request = await createSvmRequest();
      const { api, rpcCalls } = await createSolanaApi({ tamper });

      const result = await settle(
        request,
        api,
        await networkConfig(),
        createKv(),
      );
      expect(result.errorReason).toBe(
        "settle_exact_svm_relayer_modified_transaction",
      );
      expect(rpcCalls.some((c) => c.method === "sendTransaction")).toBe(false);
    });
  }

  test("returns signing failure when the relayer cannot sign (e.g. v0 on an old relayer)", async () => {
    const request = await createSvmRequest();
    const { api, signTransaction } = await createSolanaApi();
    signTransaction.mockRejectedValueOnce(
      new Error(
        "Signer error: Failed to sign transaction: Signer public key not found in transaction signers",
      ),
    );

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result.errorReason).toBe("settle_exact_svm_signing_failed");
  });

  test("returns failure when sendTransaction is rejected", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi({
      sendError: {
        code: -32002,
        message: "Transaction simulation failed: Blockhash not found",
      },
    });

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result.errorReason).toBe("settle_exact_svm_transaction_failed");
  });

  test("returns failure with the signature when the transaction fails on-chain", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi({
      statuses: [
        {
          err: { InstructionError: [2, { Custom: 1 }] },
          confirmationStatus: "confirmed",
        },
      ],
    });

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_exact_svm_transaction_failed");
    expect(result.transaction).not.toBe("");
  });

  test("times out with the signature when the transaction never confirms", async () => {
    const request = await createSvmRequest();
    request.paymentRequirements.maxTimeoutSeconds = 2;
    const { api } = await createSolanaApi({ statuses: [null] });

    const result = await settle(
      request,
      api,
      await networkConfig(),
      createKv(),
    );
    expect(result.errorReason).toBe("settle_exact_svm_transaction_timeout");
    expect(result.transaction).not.toBe("");
  });

  test("returns network mismatch when config network differs", async () => {
    const request = await createSvmRequest();
    const { api, signTransaction } = await createSolanaApi();

    const result = await settle(
      request,
      api,
      {
        ...(await networkConfig()),
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      },
      createKv(),
    );
    expect(result.errorReason).toBe("settle_exact_svm_network_mismatch");
    expect(signTransaction).not.toHaveBeenCalled();
  });
});

describe("handler Solana routing", () => {
  function context(
    route: string,
    params: unknown,
    api: any,
    config: any,
    kv?: any,
  ) {
    return {
      route,
      params,
      api,
      config,
      kv,
      headers: {},
      method: "POST",
      query: {},
    } as any;
  }

  test("/verify and /settle dispatch solana networks, /settle uses the plugin KV", async () => {
    const config = { networks: [await networkConfig()] };
    const request = await createSvmRequest();
    const { api } = await createSolanaApi();
    const kv = createKv();

    expect(
      await handler(context("/verify", request, api, config, kv)),
    ).toMatchObject({ isValid: true });
    expect(
      await handler(context("/settle", request, api, config, kv)),
    ).toMatchObject({ success: true });
    expect(
      await handler(context("/settle", request, api, config, kv)),
    ).toMatchObject({
      errorReason: "duplicate_settlement",
    });
  });

  test("/supported advertises the relayer as feePayer", async () => {
    const { relayer } = await actors();
    const config = { networks: [await networkConfig()] };
    const { api } = await createSolanaApi();

    const result: any = await handler(context("/supported", {}, api, config));
    expect(result.kinds).toEqual([
      {
        x402Version: 2,
        scheme: "exact",
        network: NETWORK,
        extra: { feePayer: relayer.address },
      },
    ]);
    expect(result.signers[NETWORK]).toEqual([relayer.address]);
  });
});
