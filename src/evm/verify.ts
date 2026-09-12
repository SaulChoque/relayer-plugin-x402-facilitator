/**
 * Verifies an EVM payment payload against payment requirements.
 *
 * Implements the x402 "exact" scheme for EVM using EIP-3009
 * (`transferWithAuthorization`), the same mechanism used by USDC and other
 * EIP-3009-compliant tokens.
 *
 * Verification steps:
 * 1. Validate protocol version, scheme, and network (CAIP-2 "eip155:<chainId>")
 * 2. Validate the asset is configured/supported for this network
 * 3. Validate the relayer's RPC node is actually on the expected chain
 * 4. Parse and validate the EIP-3009 authorization payload
 * 5. Security check: facilitator/relayer must not be the payer ("from")
 * 6. Validate recipient and amount match the payment requirements
 * 7. Recover the EIP-712 signature and confirm it was signed by "from"
 * 8. Validate the validAfter/validBefore window using the chain's own clock
 * 9. Validate the authorization nonce has not already been used on-chain
 * 10. Re-simulate `transferWithAuthorization` to ensure it will succeed
 *
 * Note: unlike Stellar (where the client signs auth entries and the relayer
 * rebuilds the transaction), for EVM the client signs an EIP-712 typed message
 * off-chain. No on-chain transaction exists yet — the facilitator submits one
 * in `settle` by calling `transferWithAuthorization` with the signature.
 */
import { Interface, Signature, verifyTypedData } from "ethers";
import {
  ExactEvmPayload,
  ExactEvmPayloadAuthorization,
  NetworkConfig,
  VerifyRequest,
  VerifyResponse,
} from "../types";
import type { PluginAPI } from "@openzeppelin/relayer-sdk";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  addressesEqual,
  ethCall,
  getChainIdFromNetwork,
  getChainTimestampSeconds,
  getRelayerChainId,
  isValidBytes32,
  isValidEvmNetwork,
  isValidHexAddress,
  isValidUintString,
  networksMatch,
} from "./utils";

type ErrorReason =
  | "invalid_x402_version"
  | "invalid_scheme"
  | "invalid_network"
  | "invalid_exact_evm_payload_malformed"
  | "invalid_exact_evm_payload_missing_domain"
  | "invalid_exact_evm_payload_wrong_recipient"
  | "invalid_exact_evm_payload_wrong_amount"
  | "invalid_exact_evm_payload_invalid_signature"
  | "invalid_exact_evm_payload_unsafe_from_address"
  | "invalid_exact_evm_payload_auth_not_yet_valid"
  | "invalid_exact_evm_payload_auth_already_expired"
  | "invalid_exact_evm_payload_auth_window_too_long"
  | "invalid_exact_evm_payload_nonce_already_used"
  | "invalid_exact_evm_payload_simulation_failed"
  | "verify_network_mismatch"
  | "unexpected_verify_error"
  | "unsupported_asset";

/** EIP-712 type definition for EIP-3009's TransferWithAuthorization message. */
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const AUTHORIZATION_STATE_ABI = [
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
];

export const TRANSFER_WITH_AUTHORIZATION_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
];

function invalidResponse(
  reason: ErrorReason | string,
  payer?: string,
): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer };
}

function validResponse(payer: string): VerifyResponse {
  return { isValid: true, payer };
}

function isMalformedAuthorization(auth: unknown): boolean {
  if (!auth || typeof auth !== "object") return true;
  const a = auth as ExactEvmPayloadAuthorization;
  return (
    !isValidHexAddress(a.from) ||
    !isValidHexAddress(a.to) ||
    !isValidUintString(a.value) ||
    !isValidUintString(a.validAfter) ||
    !isValidUintString(a.validBefore) ||
    !isValidBytes32(a.nonce)
  );
}

/** Builds the calldata for a `transferWithAuthorization` call. */
export function encodeTransferWithAuthorization(
  authorization: ExactEvmPayloadAuthorization,
  signature: string,
): string {
  const sig = Signature.from(signature);
  return new Interface(TRANSFER_WITH_AUTHORIZATION_ABI).encodeFunctionData(
    "transferWithAuthorization",
    [
      authorization.from,
      authorization.to,
      authorization.value,
      authorization.validAfter,
      authorization.validBefore,
      authorization.nonce,
      sig.v,
      sig.r,
      sig.s,
    ],
  );
}

export async function verify(
  params: VerifyRequest,
  api: PluginAPI,
  networkConfig: NetworkConfig,
): Promise<VerifyResponse> {
  try {
    const { paymentPayload, paymentRequirements } = params;

    // 1. Validate protocol version - only v2 is supported
    if (paymentPayload.x402Version !== 2 || !paymentPayload.accepted) {
      return invalidResponse("invalid_x402_version");
    }

    const scheme = paymentPayload.accepted.scheme;
    const network = paymentPayload.accepted.network;

    if (scheme !== "exact" || paymentRequirements.scheme !== "exact") {
      return invalidResponse("invalid_scheme");
    }

    // Validate network is a recognized CAIP-2 EVM network identifier
    if (!isValidEvmNetwork(paymentRequirements.network)) {
      return invalidResponse("invalid_network");
    }

    if (
      !networksMatch(network, paymentRequirements.network) ||
      !networksMatch(network, networkConfig.network)
    ) {
      return invalidResponse("invalid_network");
    }

    // 2. Check if asset is supported in the network config
    const asset = paymentRequirements.asset;
    if (!networkConfig.assets.some((a) => addressesEqual(a, asset))) {
      return invalidResponse("unsupported_asset");
    }

    // 3. Parse and validate the EIP-3009 authorization payload
    const evmPayload = paymentPayload.payload as ExactEvmPayload;
    if (
      !evmPayload ||
      typeof evmPayload.signature !== "string" ||
      isMalformedAuthorization(evmPayload.authorization)
    ) {
      return invalidResponse("invalid_exact_evm_payload_malformed");
    }
    const { authorization, signature } = evmPayload;

    // Domain name/version are required to reconstruct the EIP-712 domain the
    // client signed over (per x402 EVM exact scheme spec: paymentRequirements.extra).
    const domainName = paymentRequirements.extra?.name;
    const domainVersion = paymentRequirements.extra?.version;
    if (typeof domainName !== "string" || typeof domainVersion !== "string") {
      return invalidResponse("invalid_exact_evm_payload_missing_domain");
    }

    // 4. Security check: facilitator MUST NOT be the from address in the transfer
    const channelServiceFundRelayerAddress =
      networkConfig.channel_service_fund_relayer_address;

    // 5. Validate recipient and amount match requirements
    if (!addressesEqual(authorization.to, paymentRequirements.payTo)) {
      return invalidResponse(
        "invalid_exact_evm_payload_wrong_recipient",
        authorization.from,
      );
    }

    if (!paymentRequirements.amount) {
      return invalidResponse(
        "invalid_exact_evm_payload_wrong_amount",
        authorization.from,
      );
    }
    if (BigInt(authorization.value) !== BigInt(paymentRequirements.amount)) {
      return invalidResponse(
        "invalid_exact_evm_payload_wrong_amount",
        authorization.from,
      );
    }

    // Get relayer info and validate the RPC node is actually on the expected chain
    const relayer = api.useRelayer(networkConfig.relayer_id);
    const [relayerInfo, chainId] = await Promise.all([
      relayer.getRelayer(),
      getRelayerChainId(relayer),
    ]);

    const expectedChainId = getChainIdFromNetwork(paymentRequirements.network);
    if (expectedChainId === null || chainId !== expectedChainId) {
      console.error(
        `Relayer chain id mismatch: relayer=${chainId} expected=${expectedChainId}`,
      );
      return invalidResponse("verify_network_mismatch");
    }

    if (
      addressesEqual(authorization.from, relayerInfo.address) ||
      addressesEqual(authorization.from, channelServiceFundRelayerAddress)
    ) {
      console.error(
        `Security violation: from address is the facilitator: ${authorization.from}`,
      );
      return invalidResponse(
        "invalid_exact_evm_payload_unsafe_from_address",
        authorization.from,
      );
    }

    // 6. Verify the EIP-712 signature recovers to authorization.from
    let recovered: string;
    try {
      recovered = verifyTypedData(
        {
          name: domainName,
          version: domainVersion,
          chainId,
          verifyingContract: asset,
        },
        EIP3009_TYPES,
        {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value,
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          nonce: authorization.nonce,
        },
        signature,
      );
    } catch (error) {
      console.error("Error recovering signature:", error);
      return invalidResponse(
        "invalid_exact_evm_payload_invalid_signature",
        authorization.from,
      );
    }

    if (!addressesEqual(recovered, authorization.from)) {
      console.error(
        `Signature recovery mismatch: recovered=${recovered} expected=${authorization.from}`,
      );
      return invalidResponse(
        "invalid_exact_evm_payload_invalid_signature",
        authorization.from,
      );
    }

    // 7. Validate the validAfter/validBefore window using the chain's own clock
    // and check the nonce hasn't already been consumed on-chain, in parallel.
    const maxTimeoutSeconds =
      paymentRequirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

    const [chainTimestamp, usedRaw] = await Promise.all([
      getChainTimestampSeconds(relayer),
      ethCall(
        relayer,
        asset,
        new Interface(AUTHORIZATION_STATE_ABI).encodeFunctionData(
          "authorizationState",
          [authorization.from, authorization.nonce],
        ),
      ),
    ]);

    const validAfter = BigInt(authorization.validAfter);
    const validBefore = BigInt(authorization.validBefore);
    const skew = BigInt(CLOCK_SKEW_TOLERANCE_SECONDS);

    if (chainTimestamp + skew < validAfter) {
      return invalidResponse(
        "invalid_exact_evm_payload_auth_not_yet_valid",
        authorization.from,
      );
    }
    if (chainTimestamp >= validBefore) {
      return invalidResponse(
        "invalid_exact_evm_payload_auth_already_expired",
        authorization.from,
      );
    }
    if (validBefore - validAfter > BigInt(maxTimeoutSeconds) + skew) {
      return invalidResponse(
        "invalid_exact_evm_payload_auth_window_too_long",
        authorization.from,
      );
    }

    const [used] = new Interface(AUTHORIZATION_STATE_ABI).decodeFunctionResult(
      "authorizationState",
      usedRaw,
    );
    if (used) {
      return invalidResponse(
        "invalid_exact_evm_payload_nonce_already_used",
        authorization.from,
      );
    }

    // 8. Final defense-in-depth: simulate the on-chain call to catch balance,
    // paused/blacklisted-contract, or other failures the checks above can't see.
    try {
      const data = encodeTransferWithAuthorization(authorization, signature);
      await ethCall(relayer, asset, data);
    } catch (error) {
      console.error("Simulation of transferWithAuthorization failed:", error);
      return invalidResponse(
        "invalid_exact_evm_payload_simulation_failed",
        authorization.from,
      );
    }

    console.log("Verification successful for payer:", authorization.from);
    return validResponse(authorization.from);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected verification error:", errorMessage);
    return invalidResponse("unexpected_verify_error");
  }
}
