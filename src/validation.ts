/**
 * Structural validation of x402 v2 verify/settle requests (network-agnostic).
 */
import type { VerifyRequest, SettleRequest } from "./types";

/**
 * Validates common structure shared by verify and settle requests.
 */
function validateBaseRequestParams(params: unknown): params is {
  paymentPayload: Record<string, unknown>;
  paymentRequirements: Record<string, unknown>;
} {
  if (
    typeof params !== "object" ||
    params === null ||
    !("paymentPayload" in params) ||
    !("paymentRequirements" in params)
  ) {
    return false;
  }

  const { paymentPayload, paymentRequirements } = params as Record<
    string,
    unknown
  >;

  if (
    typeof paymentPayload !== "object" ||
    paymentPayload === null ||
    typeof paymentRequirements !== "object" ||
    paymentRequirements === null
  ) {
    return false;
  }

  const req = paymentRequirements as Record<string, unknown>;
  const payload = paymentPayload as Record<string, unknown>;

  if (!isValidPaymentRequirementsObject(req)) {
    return false;
  }

  // Validate paymentPayload required fields
  if (
    typeof payload.x402Version !== "number" ||
    typeof payload.accepted !== "object" ||
    payload.accepted === null ||
    typeof payload.payload !== "object" ||
    payload.payload === null
  ) {
    return false;
  }

  // Validate accepted has full PaymentRequirements shape
  const accepted = payload.accepted as Record<string, unknown>;
  if (!isValidPaymentRequirementsObject(accepted)) {
    return false;
  }

  return true;
}

function isValidPaymentRequirementsObject(
  value: Record<string, unknown>,
): boolean {
  if (
    typeof value.scheme !== "string" ||
    typeof value.network !== "string" ||
    typeof value.amount !== "string" ||
    typeof value.payTo !== "string" ||
    typeof value.asset !== "string" ||
    typeof value.maxTimeoutSeconds !== "number"
  ) {
    return false;
  }

  if (typeof value.extra !== "object" || value.extra === null) {
    return false;
  }

  const extra = value.extra as Record<string, unknown>;

  // Stellar requirements must declare fee sponsorship explicitly. Other
  // networks (e.g. EVM, whose `extra` carries the EIP-712 domain) may omit it.
  if ((value.network as string).startsWith("stellar:")) {
    return typeof extra.areFeesSponsored === "boolean";
  }
  return (
    extra.areFeesSponsored === undefined ||
    typeof extra.areFeesSponsored === "boolean"
  );
}

/**
 * Validates verify request params.
 */
export function validateVerifyRequest(
  params: unknown,
): params is VerifyRequest {
  return validateBaseRequestParams(params);
}

/**
 * Validates settle request params.
 */
export function validateSettleRequest(
  params: unknown,
): params is SettleRequest {
  return validateBaseRequestParams(params);
}
