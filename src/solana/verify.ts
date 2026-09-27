/**
 * Verifies a Solana payment payload (x402 `exact` scheme on SVM) against payment requirements.
 *
 * Verification steps:
 * 1. Validate protocol version, scheme, network (CAIP-2 `solana:<genesis hash>`) and asset
 * 2. Validate the relayer: Solana relayer, relayer-paid fees, same cluster, and it is `extra.feePayer`
 * 3. Decode the partially signed transaction (legacy or v0, no address lookup tables)
 * 4. Instruction layout: ComputeUnitLimit, ComputeUnitPrice (bounded), TransferChecked,
 *    then up to 3 Lighthouse/Memo instructions
 * 5. Transfer: SPL Token or Token-2022, mint = asset, destination = ATA(payTo, asset),
 *    exact amount, and the fee payer is not the authority/source
 * 6. Fee payer safety: it must not appear in any instruction's accounts
 * 7. Memo must match `extra.memo` when present
 * 8. Every required signer except the fee payer has a valid signature
 * 9. Simulate the transaction through the relayer RPC
 *
 * The relayer only adds its fee payer signature at settlement.
 */
import {
  type Address,
  type Instruction,
  decompileTransactionMessage,
  getPublicKeyFromAddress,
  getUtf8Decoder,
  verifySignature,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  parseTransferCheckedInstruction as parseTransferCheckedToken,
} from "@solana-program/token";
import { parseTransferCheckedInstruction as parseTransferChecked2022 } from "@solana-program/token-2022";
import {
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type { PluginAPI, Relayer } from "@openzeppelin/relayer-sdk";
import type {
  ExactSvmPayload,
  NetworkConfig,
  VerifyRequest,
  VerifyResponse,
} from "../types";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
  SOLANA_CLUSTER_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  type DecodedTransaction,
  caip2FromGenesisHash,
  decodeTransaction,
  getFeePayer,
  isEmptySignature,
  isValidSolanaNetwork,
  solanaRpc,
} from "./utils";

type ErrorReason =
  | "invalid_x402_version"
  | "invalid_scheme"
  | "invalid_network"
  | "unsupported_asset"
  | "verify_network_mismatch"
  | "unsupported_relayer_fee_payment_strategy"
  | "invalid_exact_svm_payload_missing_fee_payer"
  | "fee_payer_not_managed_by_facilitator"
  | "invalid_exact_svm_payload_transaction_could_not_be_decoded"
  | "invalid_exact_svm_payload_address_lookup_tables_unsupported"
  | "invalid_exact_svm_payload_fee_payer_mismatch"
  | "invalid_exact_svm_payload_transaction_instructions_length"
  | "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction"
  | "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction"
  | "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high"
  | "invalid_exact_svm_payload_no_transfer_instruction"
  | "invalid_exact_svm_payload_mint_mismatch"
  | "invalid_exact_svm_payload_recipient_mismatch"
  | "invalid_exact_svm_payload_amount_mismatch"
  | "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds"
  | "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts"
  | "invalid_exact_svm_payload_unknown_optional_instruction"
  | "invalid_exact_svm_payload_memo_count"
  | "invalid_exact_svm_payload_memo_mismatch"
  | "invalid_exact_svm_payload_fee_payer_already_signed"
  | "invalid_exact_svm_payload_missing_signature"
  | "invalid_exact_svm_payload_invalid_signature"
  | "transaction_simulation_failed"
  | "unexpected_verify_error";

function invalidResponse(reason: ErrorReason, payer?: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer };
}

export async function verify(
  params: VerifyRequest,
  api: PluginAPI,
  networkConfig: NetworkConfig,
): Promise<VerifyResponse> {
  let payer: string | undefined;

  try {
    const { paymentPayload, paymentRequirements } = params;

    // 1. Protocol version, scheme, network and asset
    if (paymentPayload.x402Version !== 2 || !paymentPayload.accepted) {
      return invalidResponse("invalid_x402_version");
    }
    if (
      paymentPayload.accepted.scheme !== "exact" ||
      paymentRequirements.scheme !== "exact"
    ) {
      return invalidResponse("invalid_scheme");
    }
    if (
      !isValidSolanaNetwork(paymentRequirements.network) ||
      paymentPayload.accepted.network !== paymentRequirements.network ||
      paymentRequirements.network !== networkConfig.network
    ) {
      return invalidResponse("invalid_network");
    }
    if (!networkConfig.assets.includes(paymentRequirements.asset)) {
      return invalidResponse("unsupported_asset");
    }

    // 2. Relayer checks
    const relayer = api.useRelayer(networkConfig.relayer_id);
    const relayerInfo = await relayer.getRelayer();

    if (relayerInfo.network_type && relayerInfo.network_type !== "solana") {
      console.error(
        `Relayer ${networkConfig.relayer_id} is not a Solana relayer (${relayerInfo.network_type})`,
      );
      return invalidResponse("verify_network_mismatch");
    }

    // x402 transactions never pay the relayer back in tokens, so the relayer
    // must sponsor fees itself ("user" is the relayer default).
    const policies = relayerInfo.policies as
      | { fee_payment_strategy?: string }
      | undefined;
    if (policies?.fee_payment_strategy !== "relayer") {
      console.error(
        `Relayer ${networkConfig.relayer_id} must use fee_payment_strategy "relayer" (got ${policies?.fee_payment_strategy ?? "default (user)"})`,
      );
      return invalidResponse("unsupported_relayer_fee_payment_strategy");
    }

    if (
      !(await relayerOnNetwork(
        relayer,
        relayerInfo.network,
        networkConfig.network,
      ))
    ) {
      return invalidResponse("verify_network_mismatch");
    }

    const feePayer = paymentRequirements.extra?.feePayer;
    if (typeof feePayer !== "string" || feePayer.length === 0) {
      return invalidResponse("invalid_exact_svm_payload_missing_fee_payer");
    }
    if (feePayer !== relayerInfo.address) {
      return invalidResponse("fee_payer_not_managed_by_facilitator");
    }

    // 3. Decode the transaction
    const svmPayload = paymentPayload.payload as ExactSvmPayload;
    let decoded: DecodedTransaction;
    try {
      if (typeof svmPayload?.transaction !== "string")
        throw new Error("missing");
      decoded = decodeTransaction(svmPayload.transaction);
    } catch {
      return invalidResponse(
        "invalid_exact_svm_payload_transaction_could_not_be_decoded",
      );
    }

    const { compiled } = decoded;
    if (
      "addressTableLookups" in compiled &&
      (compiled.addressTableLookups?.length ?? 0) > 0
    ) {
      return invalidResponse(
        "invalid_exact_svm_payload_address_lookup_tables_unsupported",
      );
    }
    if (getFeePayer(compiled) !== feePayer) {
      return invalidResponse("invalid_exact_svm_payload_fee_payer_mismatch");
    }

    const instructions = decompileTransactionMessage(compiled).instructions;

    // 4. Instruction layout
    if (instructions.length < 3 || instructions.length > 6) {
      return invalidResponse(
        "invalid_exact_svm_payload_transaction_instructions_length",
      );
    }

    const computeError = verifyComputeBudget(instructions[0], instructions[1]);
    if (computeError) {
      return invalidResponse(computeError);
    }

    // 5. Transfer instruction
    const transferIx = instructions[2];
    const tokenProgram = transferIx.programAddress as string;
    if (
      tokenProgram !== TOKEN_PROGRAM_ADDRESS &&
      tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS
    ) {
      return invalidResponse(
        "invalid_exact_svm_payload_no_transfer_instruction",
      );
    }

    let transfer;
    try {
      transfer =
        tokenProgram === TOKEN_PROGRAM_ADDRESS
          ? parseTransferCheckedToken(transferIx as never)
          : parseTransferChecked2022(transferIx as never);
    } catch {
      return invalidResponse(
        "invalid_exact_svm_payload_no_transfer_instruction",
      );
    }

    payer = transfer.accounts.authority.address as string;

    if (
      (transfer.accounts.mint.address as string) !== paymentRequirements.asset
    ) {
      return invalidResponse("invalid_exact_svm_payload_mint_mismatch", payer);
    }

    const [expectedDestination] = await findAssociatedTokenPda({
      owner: paymentRequirements.payTo as Address,
      mint: paymentRequirements.asset as Address,
      tokenProgram: tokenProgram as Address,
    });
    if (transfer.accounts.destination.address !== expectedDestination) {
      return invalidResponse(
        "invalid_exact_svm_payload_recipient_mismatch",
        payer,
      );
    }

    if (transfer.data.amount !== BigInt(paymentRequirements.amount)) {
      return invalidResponse(
        "invalid_exact_svm_payload_amount_mismatch",
        payer,
      );
    }

    // The facilitator must never move its own funds
    const [feePayerTokenAccount] = await findAssociatedTokenPda({
      owner: feePayer as Address,
      mint: paymentRequirements.asset as Address,
      tokenProgram: tokenProgram as Address,
    });
    if (
      payer === feePayer ||
      transfer.accounts.source.address === feePayerTokenAccount
    ) {
      return invalidResponse(
        "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
        payer,
      );
    }

    // 6. Fee payer must not be referenced by any instruction
    const feePayerInAccounts = instructions.some((ix) =>
      (ix.accounts ?? []).some((account) => account.address === feePayer),
    );
    if (feePayerInAccounts) {
      return invalidResponse(
        "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
        payer,
      );
    }

    // 7. Optional instructions and memo
    const optional = instructions.slice(3);
    for (const ix of optional) {
      const program = ix.programAddress as string;
      if (
        program !== LIGHTHOUSE_PROGRAM_ADDRESS &&
        program !== MEMO_PROGRAM_ADDRESS
      ) {
        return invalidResponse(
          "invalid_exact_svm_payload_unknown_optional_instruction",
          payer,
        );
      }
    }

    const memoInstructions = optional.filter(
      (ix) => ix.programAddress === MEMO_PROGRAM_ADDRESS,
    );
    const expectedMemo = paymentRequirements.extra?.memo;
    if (typeof expectedMemo === "string") {
      if (memoInstructions.length !== 1) {
        return invalidResponse("invalid_exact_svm_payload_memo_count", payer);
      }
      const memoData = memoInstructions[0].data ?? new Uint8Array();
      if (
        memoData.length > MAX_MEMO_BYTES ||
        getUtf8Decoder().decode(memoData) !== expectedMemo
      ) {
        return invalidResponse(
          "invalid_exact_svm_payload_memo_mismatch",
          payer,
        );
      }
    }

    // 8. Signatures: the client signs everything except the fee payer slot
    const signatureError = await verifyClientSignatures(decoded, feePayer);
    if (signatureError) {
      return invalidResponse(signatureError, payer);
    }

    // 9. Simulation (without signature verification: the fee payer has not signed yet)
    const simulation = await solanaRpc<{
      value?: { err: unknown; logs?: string[] };
    }>(relayer, "simulateTransaction", [
      svmPayload.transaction,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
      },
    ]);
    if (!simulation.ok || !simulation.result?.value) {
      console.error(
        "Simulation RPC error:",
        simulation.ok ? simulation.result : simulation.error,
      );
      return invalidResponse("transaction_simulation_failed", payer);
    }
    if (simulation.result.value.err) {
      console.error(
        "Simulation failed:",
        simulation.result.value.err,
        simulation.result.value.logs,
      );
      return invalidResponse("transaction_simulation_failed", payer);
    }

    console.log("Solana verification successful for payer:", payer);
    return { isValid: true, payer };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected Solana verification error:", errorMessage);
    return invalidResponse("unexpected_verify_error", payer);
  }
}

/**
 * Checks the relayer serves the requested cluster.
 *
 * Uses `getGenesisHash` when the relayer can return it (older relayer versions
 * fail to serialize string RPC results), then falls back to the relayer's
 * network name for the public clusters. Custom networks that cannot be checked
 * are accepted: a transaction's blockhash already ties it to one cluster.
 */
async function relayerOnNetwork(
  relayer: Relayer,
  relayerNetwork: string,
  network: string,
): Promise<boolean> {
  const genesis = await solanaRpc<string>(relayer, "getGenesisHash", []);
  if (genesis.ok && typeof genesis.result === "string") {
    const matches = caip2FromGenesisHash(genesis.result) === network;
    if (!matches) {
      console.error(
        `Relayer cluster mismatch: genesis ${genesis.result} is not ${network}`,
      );
    }
    return matches;
  }

  const known = SOLANA_CLUSTER_CAIP2[relayerNetwork];
  if (known) {
    if (known !== network) {
      console.error(
        `Relayer network mismatch: ${relayerNetwork} (${known}) !== ${network}`,
      );
    }
    return known === network;
  }

  console.warn(
    `Cannot verify that relayer network "${relayerNetwork}" is ${network}; continuing`,
  );
  return true;
}

function verifyComputeBudget(
  limitIx: Instruction,
  priceIx: Instruction,
): ErrorReason | null {
  if (
    limitIx.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    limitIx.data?.[0] !== 2
  ) {
    return "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction";
  }
  try {
    parseSetComputeUnitLimitInstruction(limitIx as never);
  } catch {
    return "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction";
  }

  if (
    priceIx.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    priceIx.data?.[0] !== 3
  ) {
    return "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction";
  }
  let microLamports: bigint;
  try {
    microLamports = BigInt(
      parseSetComputeUnitPriceInstruction(priceIx as never).data.microLamports,
    );
  } catch {
    return "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction";
  }
  if (microLamports > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
    return "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high";
  }
  return null;
}

/**
 * Every required signer except the fee payer must have signed the message;
 * the fee payer slot must still be empty.
 */
async function verifyClientSignatures(
  decoded: DecodedTransaction,
  feePayer: string,
): Promise<ErrorReason | null> {
  const { compiled, signatures, messageBytes } = decoded;
  const signers = compiled.staticAccounts.slice(
    0,
    compiled.header.numSignerAccounts,
  );

  for (const signer of signers) {
    const signature = signatures[signer];
    if (signer === feePayer) {
      if (!isEmptySignature(signature)) {
        return "invalid_exact_svm_payload_fee_payer_already_signed";
      }
      continue;
    }
    if (isEmptySignature(signature)) {
      return "invalid_exact_svm_payload_missing_signature";
    }
    const publicKey = await getPublicKeyFromAddress(signer);
    const valid = await verifySignature(
      publicKey,
      signature!,
      messageBytes as never,
    );
    if (!valid) {
      return "invalid_exact_svm_payload_invalid_signature";
    }
  }
  return null;
}
