/**
 * Settles an EVM payment by submitting a `transferWithAuthorization` (EIP-3009)
 * transaction on-chain via the relayer.
 *
 * Settlement flow:
 * 1. Verify payment is valid (re-runs all `verify` checks defense-in-depth)
 * 2. Build the `transferWithAuthorization` calldata from the signed authorization
 * 3. Submit via the relayer, targeting the asset (token) contract
 * 4. Wait for confirmation
 *
 * Unlike Stellar, the relayer does not need to rebuild anything: the payload
 * is an off-chain EIP-712 signature, and the relayer is simply the address
 * that broadcasts the `transferWithAuthorization` call (any address may do so).
 */
import type {
  EvmTransactionResponse,
  PluginAPI,
} from "@openzeppelin/relayer-sdk";
import {
  ExactEvmPayload,
  NetworkConfig,
  SettleRequest,
  SettleResponse,
} from "../types";
import { DEFAULT_TIMEOUT_SECONDS, networksMatch } from "./utils";
import { encodeTransferWithAuthorization, verify } from "./verify";

type ErrorReason =
  | "invalid_exact_evm_payload_malformed"
  | "settle_exact_evm_transaction_failed"
  | "settle_exact_evm_network_mismatch"
  | "unexpected_settle_error";

const BUFFER_MS = 2_000;

function successResponse(
  txHash: string,
  network: string,
  payer?: string,
): SettleResponse {
  return { success: true, transaction: txHash, network, payer };
}

function errorResponse(
  reason: ErrorReason | string,
  network: string,
  payer?: string,
  txHash?: string,
): SettleResponse {
  return {
    success: false,
    errorReason: reason,
    transaction: txHash ?? "",
    network,
    payer,
  };
}

export async function settle(
  params: SettleRequest,
  api: PluginAPI,
  networkConfig: NetworkConfig,
): Promise<SettleResponse> {
  const { paymentPayload, paymentRequirements } = params;
  const timeoutMs =
    (paymentRequirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const bufferMs = Math.min(BUFFER_MS, timeoutMs / 2);
  const deadlineMs = Date.now() + timeoutMs - bufferMs;

  if (!paymentPayload.accepted) {
    return errorResponse("invalid_exact_evm_payload_malformed", "");
  }
  const network = paymentPayload.accepted.network;

  // Validate incoming request network matches requirements and config.
  // Also validated in verify(), but checking here provides defense-in-depth
  // against future code changes.
  if (
    !networksMatch(network, paymentRequirements.network) ||
    !networksMatch(network, networkConfig.network)
  ) {
    return errorResponse("settle_exact_evm_network_mismatch", network);
  }

  let payer: string | undefined;

  try {
    // 1. Verify payment before settlement
    const verifyResult = await verify(params, api, networkConfig);
    if (!verifyResult.isValid) {
      return errorResponse(
        verifyResult.invalidReason!,
        network,
        verifyResult.payer,
      );
    }
    payer = verifyResult.payer;

    // 2. Build the transferWithAuthorization calldata
    const evmPayload = paymentPayload.payload as ExactEvmPayload;
    const data = encodeTransferWithAuthorization(
      evmPayload.authorization,
      evmPayload.signature,
    );

    // 3. Submit via the relayer
    const relayer = api.useRelayer(networkConfig.relayer_id);
    const txResult = await relayer.sendTransaction({
      to: paymentRequirements.asset,
      data,
      value: 0,
    });

    // 4. Wait for confirmation using the remaining time budget
    const remainingMs = deadlineMs - Date.now();
    const confirmedTx = (await txResult.wait({
      interval: 500,
      timeout: Math.max(remainingMs, 0),
    })) as EvmTransactionResponse;

    const txHash = confirmedTx.hash;

    if (confirmedTx.status === "confirmed") {
      console.log("Transaction confirmed:", txHash);
      return successResponse(txHash!, network, payer);
    } else {
      console.error(
        `Transaction failed with status: ${confirmedTx.status}`,
        confirmedTx,
      );
      return errorResponse(
        "settle_exact_evm_transaction_failed",
        network,
        payer,
        txHash,
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected settlement error:", errorMessage);
    return errorResponse("unexpected_settle_error", network, payer);
  }
}
