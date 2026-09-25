/**
 * Settles an EVM payment (x402 `exact` scheme, EIP-3009) by submitting
 * `transferWithAuthorization` through the relayer.
 *
 * Settlement flow:
 * 1. Verify payment is valid (full re-verification, defense-in-depth)
 * 2. Encode `transferWithAuthorization` with the client's signature
 * 3. Estimate gas through the relayer RPC
 * 4. Submit via `relayer.sendTransaction` (relayer signs and pays gas)
 * 5. Wait until the transaction is mined/confirmed
 */
import type {
  PluginAPI,
  Speed,
  TransactionResponse,
} from "@openzeppelin/relayer-sdk";
import type { Hex } from "viem";
import type {
  ExactEvmPayload,
  NetworkConfig,
  SettleRequest,
  SettleResponse,
} from "../types";
import {
  DEFAULT_TIMEOUT_SECONDS,
  GAS_LIMIT_BUFFER_PERCENT,
  callObject,
  encodeTransferWithAuthorization,
  evmRpc,
} from "./utils";
import { verify } from "./verify";

type ErrorReason =
  | "invalid_exact_evm_payload_malformed"
  | "settle_exact_evm_network_mismatch"
  | "settle_exact_evm_gas_estimation_failed"
  | "settle_exact_evm_transaction_failed"
  | "settle_exact_evm_transaction_timeout"
  | "unexpected_settle_error";

const BUFFER_MS = 2_000;
const WAIT_INTERVAL_MS = 1_000;
const DEFAULT_SPEED = "fast";

// Terminal statuses reported by the relayer for EVM transactions.
// `mined` means included with a successful receipt (reverts become `failed`).
const SUCCESS_STATUSES = new Set(["mined", "confirmed"]);

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
  txHash?: string | null,
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
  const startTime = Date.now();
  const timeoutMs =
    (paymentRequirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const bufferMs = Math.min(BUFFER_MS, timeoutMs / 2);
  const deadlineMs = startTime + timeoutMs - bufferMs;

  if (!paymentPayload.accepted) {
    return errorResponse("invalid_exact_evm_payload_malformed", "");
  }
  const network = paymentPayload.accepted.network;

  if (
    network !== paymentRequirements.network ||
    network !== networkConfig.network
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

    const relayer = api.useRelayer(networkConfig.relayer_id);
    const relayerInfo = await relayer.getRelayer();

    // 2. Encode the call with the client's authorization and signature
    const evmPayload = paymentPayload.payload as ExactEvmPayload;
    const asset = paymentRequirements.asset;
    const data = encodeTransferWithAuthorization(evmPayload);

    // 3. Estimate gas (required when the relayer's gas_limit_estimation policy is disabled)
    const estimate = await evmRpc<Hex>(relayer, "eth_estimateGas", [
      callObject(asset, data, relayerInfo.address),
    ]);
    if (!estimate.ok) {
      console.error("Gas estimation failed:", estimate.error);
      return errorResponse(
        "settle_exact_evm_gas_estimation_failed",
        network,
        payer,
      );
    }
    const estimatedGas = BigInt(estimate.result);
    const gasLimit = Number(
      (estimatedGas * (100n + GAS_LIMIT_BUFFER_PERCENT)) / 100n,
    );

    // The authorization cannot be executed after validBefore, so the relayer
    // must not (re)submit it after that point either.
    const validUntil = new Date(
      Number(evmPayload.authorization.validBefore) * 1000,
    ).toISOString();

    const speed = (networkConfig.evm_speed ?? DEFAULT_SPEED) as Speed;

    console.log("Settling EVM payment via relayer:", {
      asset,
      payer,
      gasLimit,
      speed,
      validUntil,
    });

    // 4. Submit through the relayer
    const txResult = await relayer.sendTransaction({
      to: asset,
      data,
      value: 0,
      gas_limit: gasLimit,
      speed,
      valid_until: validUntil,
    });

    // 5. Wait for inclusion using the remaining time budget
    const remainingMs = Math.max(deadlineMs - Date.now(), 0);
    let confirmedTx: TransactionResponse;
    try {
      confirmedTx = await txResult.wait({
        interval: WAIT_INTERVAL_MS,
        timeout: remainingMs,
      });
    } catch (waitError) {
      console.error("Timed out waiting for EVM transaction:", waitError);
      return errorResponse(
        "settle_exact_evm_transaction_timeout",
        network,
        payer,
        txResult.hash,
      );
    }

    const txHash =
      (confirmedTx as { hash?: string | null }).hash ?? txResult.hash;

    if (SUCCESS_STATUSES.has(confirmedTx.status) && txHash) {
      console.log("EVM transaction mined:", txHash);
      return successResponse(txHash, network, payer);
    }

    console.error(
      `EVM transaction failed with status: ${confirmedTx.status}`,
      confirmedTx,
    );
    return errorResponse(
      "settle_exact_evm_transaction_failed",
      network,
      payer,
      txHash,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected EVM settlement error:", errorMessage);
    return errorResponse("unexpected_settle_error", network, payer);
  }
}
