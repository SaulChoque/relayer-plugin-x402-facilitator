/**
 * Verifies an EVM payment payload (x402 `exact` scheme, EIP-3009) against payment requirements.
 *
 * Verification steps:
 * 1. Validate protocol version, scheme, and network (CAIP-2 `eip155:<chainId>`)
 * 2. Validate the asset is allowed and the payload shape is correct
 * 3. Validate the relayer is an EVM relayer on the same chain (`eth_chainId`)
 * 4. Validate recipient, amount, and that the payer is not the facilitator
 * 5. Validate the authorization validity window
 * 6. Recover the EIP-712 signer and ensure it matches `authorization.from`
 *    (smart contract wallets fall back to on-chain ERC-1271 validation via simulation)
 * 7. Check payer balance and that the authorization nonce is unused
 * 8. Simulate `transferWithAuthorization` to ensure it will succeed
 *
 * The client only signs the EIP-3009 authorization. The relayer builds, signs,
 * and pays for the settlement transaction.
 */
import {
  type Hex,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  recoverTypedDataAddress,
} from "viem";
import type { PluginAPI, Relayer } from "@openzeppelin/relayer-sdk";
import type {
  ExactEvmPayload,
  NetworkConfig,
  VerifyRequest,
  VerifyResponse,
} from "../types";
import {
  EIP3009_ABI,
  MIN_VALIDITY_BUFFER_SECONDS,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  addressesEqual,
  callObject,
  encodeTransferWithAuthorization,
  evmRpc,
  isValidExactEvmPayload,
  parseEvmChainId,
} from "./utils";

type ErrorReason =
  | "invalid_x402_version"
  | "invalid_scheme"
  | "invalid_network"
  | "unsupported_asset"
  | "verify_network_mismatch"
  | "invalid_exact_evm_payload_malformed"
  | "invalid_exact_evm_payload_missing_eip712_domain"
  | "invalid_exact_evm_payload_recipient_mismatch"
  | "invalid_exact_evm_payload_authorization_value"
  | "invalid_exact_evm_payload_unsafe_from_address"
  | "invalid_exact_evm_payload_authorization_valid_after"
  | "invalid_exact_evm_payload_authorization_valid_before"
  | "invalid_exact_evm_payload_signature"
  | "invalid_exact_evm_payload_nonce_used"
  | "insufficient_funds"
  | "invalid_exact_evm_payload_simulation_failed"
  | "unexpected_verify_error";

function invalidResponse(reason: ErrorReason, payer?: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer };
}

/**
 * Returns the current time in seconds. Exposed for deterministic testing.
 */
export const clock = {
  nowSeconds: (): number => Math.floor(Date.now() / 1000),
};

export async function verify(
  params: VerifyRequest,
  api: PluginAPI,
  networkConfig: NetworkConfig,
): Promise<VerifyResponse> {
  let payer: string | undefined;

  try {
    const { paymentPayload, paymentRequirements } = params;

    // 1. Protocol version, scheme and network
    if (paymentPayload.x402Version !== 2 || !paymentPayload.accepted) {
      return invalidResponse("invalid_x402_version");
    }

    if (
      paymentPayload.accepted.scheme !== "exact" ||
      paymentRequirements.scheme !== "exact"
    ) {
      return invalidResponse("invalid_scheme");
    }

    const chainId = parseEvmChainId(paymentRequirements.network);
    if (chainId === null) {
      return invalidResponse("invalid_network");
    }

    if (
      paymentPayload.accepted.network !== paymentRequirements.network ||
      paymentRequirements.network !== networkConfig.network
    ) {
      return invalidResponse("invalid_network");
    }

    // 2. Asset allow-list and payload shape
    const asset = paymentRequirements.asset;
    if (
      !networkConfig.assets.some((allowed) => addressesEqual(allowed, asset))
    ) {
      return invalidResponse("unsupported_asset");
    }

    if (!isValidExactEvmPayload(paymentPayload.payload)) {
      return invalidResponse("invalid_exact_evm_payload_malformed");
    }
    const evmPayload = paymentPayload.payload as ExactEvmPayload;
    const { authorization } = evmPayload;
    const payerAddress = getAddress(authorization.from);
    payer = payerAddress;

    const domainName = paymentRequirements.extra?.name;
    const domainVersion = paymentRequirements.extra?.version;
    if (typeof domainName !== "string" || typeof domainVersion !== "string") {
      return invalidResponse(
        "invalid_exact_evm_payload_missing_eip712_domain",
        payer,
      );
    }

    // 3. Relayer must be an EVM relayer on the requested chain
    const relayer = api.useRelayer(networkConfig.relayer_id);
    const relayerInfo = await relayer.getRelayer();

    if (relayerInfo.network_type && relayerInfo.network_type !== "evm") {
      console.error(
        `Relayer ${networkConfig.relayer_id} is not an EVM relayer (${relayerInfo.network_type})`,
      );
      return invalidResponse("verify_network_mismatch", payer);
    }

    const chainIdResult = await evmRpc<string>(relayer, "eth_chainId", []);
    if (!chainIdResult.ok || Number(chainIdResult.result) !== chainId) {
      console.error(
        `Relayer chain mismatch: ${chainIdResult.ok ? chainIdResult.result : "rpc error"} !== ${chainId}`,
      );
      return invalidResponse("verify_network_mismatch", payer);
    }

    // 4. Recipient, amount and facilitator safety
    if (!addressesEqual(authorization.to, paymentRequirements.payTo)) {
      return invalidResponse(
        "invalid_exact_evm_payload_recipient_mismatch",
        payer,
      );
    }

    if (BigInt(authorization.value) !== BigInt(paymentRequirements.amount)) {
      return invalidResponse(
        "invalid_exact_evm_payload_authorization_value",
        payer,
      );
    }

    // The facilitator must never be tricked into moving its own funds
    if (addressesEqual(payer, relayerInfo.address)) {
      console.error(
        `Security violation: from address is the facilitator: ${payer}`,
      );
      return invalidResponse(
        "invalid_exact_evm_payload_unsafe_from_address",
        payer,
      );
    }

    // 5. Validity window
    const now = BigInt(clock.nowSeconds());
    if (BigInt(authorization.validAfter) > now) {
      return invalidResponse(
        "invalid_exact_evm_payload_authorization_valid_after",
        payer,
      );
    }
    if (
      BigInt(authorization.validBefore) <
      now + BigInt(MIN_VALIDITY_BUFFER_SECONDS)
    ) {
      return invalidResponse(
        "invalid_exact_evm_payload_authorization_valid_before",
        payer,
      );
    }

    // 6. Signature
    const signatureValid = await verifySignature(
      evmPayload,
      { name: domainName, version: domainVersion, chainId, asset },
      relayer,
    );
    if (!signatureValid) {
      return invalidResponse("invalid_exact_evm_payload_signature", payer);
    }

    // 7 + 8. Balance, nonce and simulation are independent RPC calls
    const transferData = encodeTransferWithAuthorization(evmPayload);
    const [balanceResult, nonceResult, simulationResult] = await Promise.all([
      evmRpc<Hex>(relayer, "eth_call", [
        callObject(
          asset,
          encodeFunctionData({
            abi: EIP3009_ABI,
            functionName: "balanceOf",
            args: [payerAddress],
          }),
        ),
        "latest",
      ]),
      evmRpc<Hex>(relayer, "eth_call", [
        callObject(
          asset,
          encodeFunctionData({
            abi: EIP3009_ABI,
            functionName: "authorizationState",
            args: [payerAddress, authorization.nonce as Hex],
          }),
        ),
        "latest",
      ]),
      evmRpc<Hex>(relayer, "eth_call", [
        callObject(asset, transferData, relayerInfo.address),
        "latest",
      ]),
    ]);

    if (!balanceResult.ok) {
      console.error("balanceOf call failed:", balanceResult.error);
      return invalidResponse(
        "invalid_exact_evm_payload_simulation_failed",
        payer,
      );
    }
    const balance = decodeFunctionResult({
      abi: EIP3009_ABI,
      functionName: "balanceOf",
      data: balanceResult.result,
    });
    if (balance < BigInt(authorization.value)) {
      return invalidResponse("insufficient_funds", payer);
    }

    if (!nonceResult.ok) {
      console.error("authorizationState call failed:", nonceResult.error);
      return invalidResponse(
        "invalid_exact_evm_payload_simulation_failed",
        payer,
      );
    }
    const nonceUsed = decodeFunctionResult({
      abi: EIP3009_ABI,
      functionName: "authorizationState",
      data: nonceResult.result,
    });
    if (nonceUsed) {
      return invalidResponse("invalid_exact_evm_payload_nonce_used", payer);
    }

    if (!simulationResult.ok) {
      console.error(
        "transferWithAuthorization simulation failed:",
        simulationResult.error,
      );
      return invalidResponse(
        "invalid_exact_evm_payload_simulation_failed",
        payer,
      );
    }

    console.log("EVM verification successful for payer:", payer);
    return { isValid: true, payer };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected EVM verification error:", errorMessage);
    return invalidResponse("unexpected_verify_error", payer);
  }
}

/**
 * Verifies the EIP-712 `TransferWithAuthorization` signature.
 *
 * For EOAs the recovered signer must equal `authorization.from`. If recovery
 * does not match (or fails) and `from` is a smart contract, the signature is
 * accepted here and validated on-chain (ERC-1271) by the token during the
 * mandatory `transferWithAuthorization` simulation.
 */
async function verifySignature(
  payload: ExactEvmPayload,
  domain: { name: string; version: string; chainId: number; asset: string },
  relayer: Relayer,
): Promise<boolean> {
  const { authorization } = payload;
  const signature = payload.signature as Hex;

  if (signature.length === 132) {
    try {
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId,
          verifyingContract: getAddress(domain.asset),
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: getAddress(authorization.from),
          to: getAddress(authorization.to),
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce as Hex,
        },
        signature,
      });
      if (addressesEqual(recovered, authorization.from)) {
        return true;
      }
    } catch (error) {
      console.error("Signature recovery failed:", error);
    }
  }

  // Not a valid EOA signature: only acceptable if `from` is a contract wallet
  const codeResult = await evmRpc<Hex>(relayer, "eth_getCode", [
    getAddress(authorization.from),
    "latest",
  ]);
  const hasCode =
    codeResult.ok &&
    typeof codeResult.result === "string" &&
    codeResult.result !== "0x" &&
    codeResult.result !== "0x0";
  return hasCode;
}
