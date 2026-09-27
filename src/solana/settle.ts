/**
 * Settles a Solana payment (x402 `exact` scheme on SVM).
 *
 * Settlement flow:
 * 1. Verify payment is valid (full re-verification, defense-in-depth)
 * 2. Reject duplicate settlements of the same transaction (shared KV store)
 * 3. Ask the relayer to add its fee payer signature (`signTransaction`)
 * 4. Check the relayer only filled its own signature slot
 * 5. Send the fully signed transaction through the relayer RPC
 * 6. Poll `getSignatureStatuses` until the transaction is confirmed
 *
 * Signing a v0 transaction needs an OpenZeppelin Relayer that supports
 * versioned Solana transactions; legacy transactions work on any version.
 */
import { createHash } from "crypto";
import { getPublicKeyFromAddress, verifySignature } from "@solana/kit";
import type { PluginAPI, PluginKVStore } from "@openzeppelin/relayer-sdk";
import type {
  ExactSvmPayload,
  NetworkConfig,
  SettleRequest,
  SettleResponse,
} from "../types";
import {
  DEFAULT_TIMEOUT_SECONDS,
  SETTLEMENT_CACHE_TTL_SECONDS,
  bytesEqual,
  decodeTransaction,
  getFeePayer,
  signatureToBase58,
  solanaRpc,
} from "./utils";
import { verify } from "./verify";

type ErrorReason =
  | "invalid_exact_svm_payload_malformed"
  | "settle_exact_svm_network_mismatch"
  | "duplicate_settlement"
  | "settle_exact_svm_signing_failed"
  | "settle_exact_svm_relayer_modified_transaction"
  | "settle_exact_svm_transaction_failed"
  | "settle_exact_svm_transaction_timeout"
  | "unexpected_settle_error";

const BUFFER_MS = 2_000;
const POLL_INTERVAL_MS = 500;
const SETTLE_KEY_PREFIX = "x402:svm:settle:";

type SignatureStatus = {
  err: unknown;
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
} | null;

function successResponse(
  signature: string,
  network: string,
  payer?: string,
): SettleResponse {
  return { success: true, transaction: signature, network, payer };
}

function errorResponse(
  reason: ErrorReason | string,
  network: string,
  payer?: string,
  signature?: string,
): SettleResponse {
  return {
    success: false,
    errorReason: reason,
    transaction: signature ?? "",
    network,
    payer,
  };
}

/**
 * Claims the settlement of a transaction. Returns false when the same
 * transaction was already claimed within the TTL (duplicate settlement).
 */
async function claimSettlement(
  kv: PluginKVStore | undefined,
  transaction: string,
): Promise<boolean> {
  if (!kv) {
    console.warn("KV store unavailable: duplicate settlement guard disabled");
    return true;
  }
  const key =
    SETTLE_KEY_PREFIX + createHash("sha256").update(transaction).digest("hex");
  const claimed = await kv.withLock(
    `${key}:lock`,
    async () => {
      if (await kv.exists(key)) return false;
      await kv.set(
        key,
        { claimedAt: Date.now() },
        { ttlSec: SETTLEMENT_CACHE_TTL_SECONDS },
      );
      return true;
    },
    { ttlSec: 10, onBusy: "skip" },
  );
  return claimed === true;
}

export async function settle(
  params: SettleRequest,
  api: PluginAPI,
  networkConfig: NetworkConfig,
  kv?: PluginKVStore,
): Promise<SettleResponse> {
  const { paymentPayload, paymentRequirements } = params;
  const startTime = Date.now();
  const timeoutMs =
    (paymentRequirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const bufferMs = Math.min(BUFFER_MS, timeoutMs / 2);
  const deadlineMs = startTime + timeoutMs - bufferMs;

  if (!paymentPayload.accepted) {
    return errorResponse("invalid_exact_svm_payload_malformed", "");
  }
  const network = paymentPayload.accepted.network;
  if (
    network !== paymentRequirements.network ||
    network !== networkConfig.network
  ) {
    return errorResponse("settle_exact_svm_network_mismatch", network);
  }

  let payer: string | undefined;
  let signature: string | undefined;

  try {
    // 1. Verify
    const verifyResult = await verify(params, api, networkConfig);
    if (!verifyResult.isValid) {
      return errorResponse(
        verifyResult.invalidReason!,
        network,
        verifyResult.payer,
      );
    }
    payer = verifyResult.payer;

    const clientTransaction = (paymentPayload.payload as ExactSvmPayload)
      .transaction;

    // 2. Duplicate settlement guard
    if (!(await claimSettlement(kv, clientTransaction))) {
      return errorResponse("duplicate_settlement", network, payer);
    }

    // 3. Relayer adds the fee payer signature
    const relayer = api.useRelayer(networkConfig.relayer_id);
    let signedTransaction: string;
    try {
      const signed = (await relayer.signTransaction({
        transaction: clientTransaction,
      })) as unknown as { transaction?: string; signature?: string };
      if (!signed?.transaction)
        throw new Error("empty signTransaction response");
      signedTransaction = signed.transaction;
    } catch (error) {
      console.error("Relayer failed to sign the transaction:", error);
      return errorResponse("settle_exact_svm_signing_failed", network, payer);
    }

    // 4. The relayer must only have filled its own signature slot
    const original = decodeTransaction(clientTransaction);
    let signedDecoded: ReturnType<typeof decodeTransaction>;
    try {
      signedDecoded = decodeTransaction(signedTransaction);
    } catch (error) {
      console.error("Relayer returned an undecodable transaction:", error);
      return errorResponse(
        "settle_exact_svm_relayer_modified_transaction",
        network,
        payer,
      );
    }
    const feePayer = getFeePayer(original.compiled);
    const feePayerSignature = signedDecoded.signatures[feePayer];
    const clientSignaturesKept = Object.entries(original.signatures).every(
      ([signer, sig]) =>
        signer === feePayer ||
        (sig !== null &&
          signedDecoded.signatures[
            signer as keyof typeof signedDecoded.signatures
          ] !== null &&
          bytesEqual(
            sig,
            signedDecoded.signatures[
              signer as keyof typeof signedDecoded.signatures
            ]!,
          )),
    );
    if (
      !bytesEqual(original.messageBytes, signedDecoded.messageBytes) ||
      !clientSignaturesKept ||
      !feePayerSignature ||
      !(await verifySignature(
        await getPublicKeyFromAddress(feePayer),
        feePayerSignature,
        signedDecoded.messageBytes as never,
      ))
    ) {
      console.error(
        "Relayer returned a transaction that differs from the verified one",
      );
      return errorResponse(
        "settle_exact_svm_relayer_modified_transaction",
        network,
        payer,
      );
    }
    // A Solana transaction id is its first (fee payer) signature
    signature = signatureToBase58(feePayerSignature);

    // 5. Send
    const sent = await solanaRpc<string>(relayer, "sendTransaction", [
      signedTransaction,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
      },
    ]);
    if (!sent.ok && !sent.unserializableResult) {
      console.error("sendTransaction failed:", sent.error);
      return errorResponse(
        "settle_exact_svm_transaction_failed",
        network,
        payer,
      );
    }
    if (sent.ok && sent.result !== signature) {
      console.warn(
        `Node returned signature ${sent.result}, expected ${signature}`,
      );
    }

    // 6. Confirm
    console.log(
      "Solana transaction sent, waiting for confirmation:",
      signature,
    );
    while (Date.now() < deadlineMs) {
      const statuses = await solanaRpc<{ value?: SignatureStatus[] }>(
        relayer,
        "getSignatureStatuses",
        [[signature], { searchTransactionHistory: false }],
      );
      const status = statuses.ok ? statuses.result?.value?.[0] : null;
      if (status) {
        if (status.err) {
          console.error("Solana transaction failed on-chain:", status.err);
          return errorResponse(
            "settle_exact_svm_transaction_failed",
            network,
            payer,
            signature,
          );
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          console.log("Solana transaction confirmed:", signature);
          return successResponse(signature, network, payer);
        }
      }
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
      );
    }

    return errorResponse(
      "settle_exact_svm_transaction_timeout",
      network,
      payer,
      signature,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected Solana settlement error:", errorMessage);
    return errorResponse("unexpected_settle_error", network, payer, signature);
  }
}
