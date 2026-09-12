import { AbiCoder, Wallet, keccak256, toUtf8Bytes } from "ethers";

// Real Avalanche Fuji testnet USDC (Circle), confirmed on-chain to implement
// EIP-3009 (authorizationState/transferWithAuthorization) with domain
// name="USD Coin", version="2". Used only as a realistic fixture in tests.
export const CHAIN_ID = 43113;
export const NETWORK = "eip155:43113";
export const ASSET = "0x5425890298aed601595a70AB815c96711a31Bc65";
export const DOMAIN_NAME = "USD Coin";
export const DOMAIN_VERSION = "2";

export const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";

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

export function makeWallet(privateKey?: string): Wallet {
  return privateKey
    ? new Wallet(privateKey)
    : (Wallet.createRandom() as Wallet);
}

export function buildNonce(seed: string): string {
  return keccak256(toUtf8Bytes(`nonce-${seed}`));
}

export async function signEip3009Authorization(opts: {
  wallet: Wallet;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  chainId?: number;
  verifyingContract?: string;
  domainName?: string;
  domainVersion?: string;
}): Promise<{
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}> {
  const {
    wallet,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    chainId = CHAIN_ID,
    verifyingContract = ASSET,
    domainName = DOMAIN_NAME,
    domainVersion = DOMAIN_VERSION,
  } = opts;

  const domain = {
    name: domainName,
    version: domainVersion,
    chainId,
    verifyingContract,
  };
  const message = {
    from: wallet.address,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  };
  const signature = await wallet.signTypedData(domain, EIP3009_TYPES, message);

  return { signature, authorization: message };
}

export function encodeAuthorizationStateResult(used: boolean): string {
  return AbiCoder.defaultAbiCoder().encode(["bool"], [used]);
}

export function buildEvmNetworkConfig(
  overrides: Partial<{
    network: string;
    relayer_id: string;
    assets: string[];
    channel_service_fund_relayer_address: string;
  }> = {},
) {
  return {
    network: NETWORK,
    type: "evm" as const,
    relayer_id: "relayer-1",
    assets: [ASSET],
    ...overrides,
  };
}

export function buildEvmPaymentRequirements(
  overrides: Partial<{
    network: string;
    asset: string;
    payTo: string;
    amount: string;
    maxTimeoutSeconds: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra: Record<string, any>;
  }> = {},
) {
  return {
    scheme: "exact" as const,
    network: NETWORK,
    amount: "1000",
    payTo: "0x0000000000000000000000000000000000000f00",
    maxTimeoutSeconds: 60,
    asset: ASSET,
    extra: {
      areFeesSponsored: true,
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
    },
    ...overrides,
  };
}

export function buildEvmPaymentPayload(
  signature: string,
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  acceptedOverrides: Partial<Record<string, any>> = {},
) {
  const accepted = buildEvmPaymentRequirements(acceptedOverrides);
  return {
    x402Version: 2 as const,
    accepted,
    payload: { signature, authorization },
  };
}
