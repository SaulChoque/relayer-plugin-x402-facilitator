import { describe, expect, test } from "vitest";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  type Instruction,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { verify } from "../src/solana/verify";
import {
  NETWORK,
  DEVNET_GENESIS,
  actors,
  createSolanaApi,
  createSvmRequest,
  memoInstruction,
  networkConfig,
} from "./helpers/solana";

const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

describe("Solana verify (exact / SVM)", () => {
  test("accepts a v0 transaction built like the x402 client", async () => {
    const { payer } = await actors();
    const request = await createSvmRequest();
    const { api, rpcCalls } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());

    expect(result).toEqual({ isValid: true, payer: payer.address });
    const simulation = rpcCalls.find(
      (c) => c.method === "simulateTransaction",
    )!;
    expect(simulation.params[1]).toMatchObject({
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
  });

  test("accepts legacy transactions", async () => {
    const request = await createSvmRequest({ version: "legacy" });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.isValid).toBe(true);
  });

  test("accepts wallet-injected Lighthouse instructions", async () => {
    const request = await createSvmRequest({
      instructions: (defaults) => [
        ...defaults.slice(0, 3),
        {
          programAddress: address(LIGHTHOUSE),
          data: new Uint8Array([1]),
        } as Instruction,
        {
          programAddress: address(LIGHTHOUSE),
          data: new Uint8Array([2]),
        } as Instruction,
        defaults[3],
      ],
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.isValid).toBe(true);
  });

  test("checks the cluster with getGenesisHash when the relayer supports it", async () => {
    const request = await createSvmRequest();
    const ok = await createSolanaApi({ genesis: DEVNET_GENESIS });
    expect((await verify(request, ok.api, await networkConfig())).isValid).toBe(
      true,
    );

    const mainnet = await createSolanaApi({
      genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    });
    const result = await verify(request, mainnet.api, await networkConfig());
    expect(result.invalidReason).toBe("verify_network_mismatch");
  });

  test("falls back to the relayer network name on older relayers", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi({ relayerNetwork: "mainnet-beta" });

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe("verify_network_mismatch");
  });

  test("rejects x402 v1 payloads", async () => {
    const request = await createSvmRequest();
    (request.paymentPayload as any).x402Version = 1;
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe("invalid_x402_version");
  });

  test("rejects non CAIP-2 networks", async () => {
    const request = await createSvmRequest();
    request.paymentRequirements.network = "solana-devnet";
    request.paymentPayload.accepted.network = "solana-devnet";
    const { api } = await createSolanaApi();

    const result = await verify(request, api, {
      ...(await networkConfig()),
      network: "solana-devnet",
    });
    expect(result.invalidReason).toBe("invalid_network");
  });

  test("rejects assets that are not allowed", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi();

    const result = await verify(request, api, {
      ...(await networkConfig()),
      assets: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    });
    expect(result.invalidReason).toBe("unsupported_asset");
  });

  test("rejects relayers that are not Solana relayers", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi({ networkType: "evm" });

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe("verify_network_mismatch");
  });

  test("requires the relayer to sponsor fees (fee_payment_strategy relayer)", async () => {
    const request = await createSvmRequest();
    for (const feePaymentStrategy of ["user", null]) {
      const { api } = await createSolanaApi({ feePaymentStrategy });
      const result = await verify(request, api, await networkConfig());
      expect(result.invalidReason).toBe(
        "unsupported_relayer_fee_payment_strategy",
      );
    }
  });

  test("requires extra.feePayer", async () => {
    const request = await createSvmRequest();
    request.paymentRequirements.extra = {};
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_missing_fee_payer",
    );
  });

  test("rejects a feePayer that is not the relayer", async () => {
    const request = await createSvmRequest({
      extra: { feePayer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe("fee_payer_not_managed_by_facilitator");
  });

  test("rejects undecodable transactions", async () => {
    const request = await createSvmRequest();
    (request.paymentPayload.payload as any).transaction = "bm90IGEgdHg=";
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_could_not_be_decoded",
    );
  });

  test("rejects transactions whose fee payer is not the relayer", async () => {
    const { payer } = await actors();
    const request = await createSvmRequest({ feePayer: payer.address });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_fee_payer_mismatch",
    );
  });

  test("rejects too few or too many instructions", async () => {
    const { api } = await createSolanaApi();
    const tooFew = await createSvmRequest({
      memo: null,
      instructions: (d) => d.slice(0, 2),
    });
    expect(
      (await verify(tooFew, api, await networkConfig())).invalidReason,
    ).toBe("invalid_exact_svm_payload_transaction_instructions_length");

    const memo = memoInstruction("x");
    const tooMany = await createSvmRequest({
      instructions: (d) => [...d, memo, memo, memo],
    });
    expect(
      (await verify(tooMany, api, await networkConfig())).invalidReason,
    ).toBe("invalid_exact_svm_payload_transaction_instructions_length");
  });

  test("requires compute limit then compute price", async () => {
    const request = await createSvmRequest({
      instructions: (d) => [d[1], d[0], d[2], d[3]],
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
    );
  });

  test("rejects a compute unit price above 5 lamports", async () => {
    const request = await createSvmRequest({ microLamports: 5_000_001n });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
    );
  });

  test("requires a TransferChecked as third instruction", async () => {
    const request = await createSvmRequest({
      instructions: (d) => [d[0], d[1], d[3], d[3]],
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_no_transfer_instruction",
    );
  });

  test("rejects a different mint", async () => {
    const request = await createSvmRequest({
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_mint_mismatch",
    );
  });

  test("rejects a destination that is not payTo's associated token account", async () => {
    const attacker = await generateKeyPairSigner();
    const request = await createSvmRequest({
      destinationOwner: attacker.address,
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_recipient_mismatch",
    );
  });

  test("rejects a different amount", async () => {
    const request = await createSvmRequest({ amount: 9_999n });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_amount_mismatch",
    );
  });

  test("rejects transfers of the facilitator's own funds", async () => {
    const { relayer } = await actors();
    const request = await createSvmRequest({ authority: relayer });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
    );
  });

  test("rejects instructions that reference the fee payer", async () => {
    const { relayer } = await actors();
    const request = await createSvmRequest({
      instructions: (d) => [
        ...d.slice(0, 3),
        memoInstruction("x", [
          { address: relayer.address, role: AccountRole.READONLY },
        ]),
      ],
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
    );
  });

  test("rejects unknown optional instructions", async () => {
    const { payer, payTo } = await actors();
    const extraTransfer = getTransferCheckedInstruction({
      source: payer.address,
      mint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
      destination: payTo.address,
      authority: payer,
      amount: 1n,
      decimals: 6,
    });
    const request = await createSvmRequest({
      instructions: (d) => [...d, extraTransfer],
    });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_unknown_optional_instruction",
    );
  });

  test("enforces extra.memo", async () => {
    const { api } = await createSolanaApi();

    const matching = await createSvmRequest({
      memo: "pi_3abc123",
      extra: { memo: "pi_3abc123" },
    });
    expect((await verify(matching, api, await networkConfig())).isValid).toBe(
      true,
    );

    const different = await createSvmRequest({
      memo: "pi_other",
      extra: { memo: "pi_3abc123" },
    });
    expect(
      (await verify(different, api, await networkConfig())).invalidReason,
    ).toBe("invalid_exact_svm_payload_memo_mismatch");

    const missing = await createSvmRequest({
      memo: null,
      extra: { memo: "pi_3abc123" },
    });
    expect(
      (await verify(missing, api, await networkConfig())).invalidReason,
    ).toBe("invalid_exact_svm_payload_memo_count");
  });

  test("rejects unsigned transactions", async () => {
    const request = await createSvmRequest({ signers: "none" });
    const { api } = await createSolanaApi();

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_missing_signature",
    );
  });

  test("rejects signatures over a different message", async () => {
    const signed = await createSvmRequest({ amount: BigInt(10000) });
    const other = await createSvmRequest({ memo: "another-nonce-0123456789" });
    // Same signer, signature taken from another transaction
    const {
      getTransactionDecoder,
      getTransactionEncoder,
      getBase64Encoder,
      getBase64Decoder,
    } = await import("@solana/kit");
    const a = getTransactionDecoder().decode(
      getBase64Encoder().encode(
        (signed.paymentPayload.payload as any).transaction,
      ),
    );
    const b = getTransactionDecoder().decode(
      getBase64Encoder().encode(
        (other.paymentPayload.payload as any).transaction,
      ),
    );
    const forged = getBase64Decoder().decode(
      getTransactionEncoder().encode({
        messageBytes: a.messageBytes,
        signatures: b.signatures,
      } as never),
    );
    (signed.paymentPayload.payload as any).transaction = forged;
    const { api } = await createSolanaApi();

    const result = await verify(signed, api, await networkConfig());
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_invalid_signature",
    );
  });

  test("rejects when simulation fails", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi({
      simulationErr: { InstructionError: [2, { Custom: 1 }] },
    });

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe("transaction_simulation_failed");
  });

  test("rejects when the simulation RPC call errors", async () => {
    const request = await createSvmRequest();
    const { api } = await createSolanaApi({ simulationRpcError: true });

    const result = await verify(request, api, await networkConfig());
    expect(result.invalidReason).toBe("transaction_simulation_failed");
  });

  test("network constant is devnet", () => {
    expect(NETWORK).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });
});
