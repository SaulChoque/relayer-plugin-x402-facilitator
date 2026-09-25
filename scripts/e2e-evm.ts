/*
 x402 Facilitator Plugin — EVM end-to-end script

 What it does
 - Calls /supported and checks the EVM network and relayer signer are listed
 - Signs an EIP-3009 TransferWithAuthorization exactly like an x402 EVM client
 - Calls /verify for a valid payment and for tampered payments (must be rejected)
 - Calls /settle, then checks balances and the authorization nonce on-chain
 - Replays the same payment and checks it is rejected (nonce already used)

 Prerequisites
 - A running OpenZeppelin Relayer with this plugin configured for NETWORK
 - An EIP-3009 token (e.g. USDC) at ASSET, and a payer holding at least AMOUNT
   (on a local anvil node the script can mint with --mint, using a mock token
   that exposes `mint(address,uint256)`)

 Usage (tsx, or plain `node` on Node.js 22.18+ which strips TypeScript types)

   tsx scripts/e2e-evm.ts \
     --base-url http://localhost:8080/api/v1/plugins/x402/call \
     --api-key YOUR_RELAYER_API_KEY \
     --rpc-url http://localhost:8545 \
     --network eip155:31337 \
     --asset 0x5FbDB2315678afecb367f032d93F642f64180aa3 \
     --payer-key 0x... \
     --pay-to 0x... \
     [--amount 10000] [--domain-name USDC] [--domain-version 2] [--mint]
*/
import {
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TOKEN_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address,bytes32) view returns (bool)",
  "function mint(address,uint256)",
]);

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const env = process.env[name.toUpperCase().replace(/-/g, "_")];
  if (env) return env;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

const baseUrl = arg("base-url");
const apiKey = arg("api-key");
const rpcUrl = arg("rpc-url");
const network = arg("network");
const asset = getAddress(arg("asset"));
const payTo = getAddress(arg("pay-to"));
const amount = arg("amount", "10000");
const domainName = arg("domain-name", "USDC");
const domainVersion = arg("domain-version", "2");
const shouldMint = process.argv.includes("--mint");
const payer = privateKeyToAccount(arg("payer-key") as Hex);
const chainId = Number(network.split(":")[1]);

const chain = {
  id: chainId,
  name: network,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
} as const;
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("      ", JSON.stringify(detail));
  }
}

async function call(route: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, raw: text };
  }
}

async function buildPayment(overrides: { value?: string; to?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const nonce =
    `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex;
  const authorization = {
    from: payer.address,
    to: getAddress(overrides.to ?? payTo),
    value: overrides.value ?? amount,
    validAfter: String(now - 600),
    validBefore: String(now + 300),
    nonce,
  };
  const signature = await payer.signTypedData({
    domain: {
      name: domainName,
      version: domainVersion,
      chainId,
      verifyingContract: asset,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });

  const requirements = {
    scheme: "exact",
    network,
    amount,
    payTo,
    asset,
    maxTimeoutSeconds: 60,
    extra: { name: domainName, version: domainVersion },
  };
  return {
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { signature, authorization },
    },
    paymentRequirements: requirements,
  };
}

async function main() {
  if (shouldMint) {
    const wallet = createWalletClient({
      account: payer,
      chain,
      transport: http(rpcUrl),
    });
    const hash = await wallet.writeContract({
      address: asset,
      abi: TOKEN_ABI,
      functionName: "mint",
      args: [payer.address, BigInt(amount) * 10n],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`Minted ${BigInt(amount) * 10n} to payer ${payer.address}`);
  }

  // /supported
  const supported = await call("/supported");
  const kind = supported.kinds?.find((k: any) => k.network === network);
  check("/supported lists the EVM network", !!kind, supported);
  const signers: string[] = supported.signers?.[network] ?? [];
  check(
    "/supported returns the relayer signer",
    signers.length === 1,
    supported,
  );

  // /verify — valid payment
  const payment = await buildPayment();
  const verified = await call("/verify", payment);
  check(
    "/verify accepts a valid payment",
    verified.isValid === true && getAddress(verified.payer) === payer.address,
    verified,
  );

  // /verify — tampered payments
  const wrongAmount = await buildPayment({ value: "1" });
  const wrongAmountResult = await call("/verify", wrongAmount);
  check(
    "/verify rejects a different amount",
    wrongAmountResult.invalidReason ===
      "invalid_exact_evm_payload_authorization_value",
    wrongAmountResult,
  );

  const tampered = await buildPayment();
  (tampered.paymentPayload.payload.authorization as any).validBefore = String(
    Math.floor(Date.now() / 1000) + 200,
  );
  const tamperedResult = await call("/verify", tampered);
  check(
    "/verify rejects a tampered authorization (bad signature)",
    tamperedResult.invalidReason === "invalid_exact_evm_payload_signature",
    tamperedResult,
  );

  // /settle
  const payerBefore = await publicClient.readContract({
    address: asset,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [payer.address],
  });
  const payToBefore = await publicClient.readContract({
    address: asset,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [payTo],
  });

  const settled = await call("/settle", payment);
  check(
    "/settle succeeds and returns a transaction hash",
    settled.success === true && /^0x[0-9a-fA-F]{64}$/.test(settled.transaction),
    settled,
  );

  if (settled.success) {
    const receipt = await publicClient.getTransactionReceipt({
      hash: settled.transaction,
    });
    check("settlement receipt status is success", receipt.status === "success");
    check(
      "settlement was sent by the relayer signer",
      getAddress(receipt.from) === getAddress(signers[0] ?? "0x0"),
      { from: receipt.from, signers },
    );
    check(
      "settlement targeted the token contract",
      getAddress(receipt.to!) === asset,
    );
  }

  const payerAfter = await publicClient.readContract({
    address: asset,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [payer.address],
  });
  const payToAfter = await publicClient.readContract({
    address: asset,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [payTo],
  });
  check(
    "payer balance decreased by exactly the amount",
    payerBefore - payerAfter === BigInt(amount),
    { payerBefore: String(payerBefore), payerAfter: String(payerAfter) },
  );
  check(
    "payTo balance increased by exactly the amount",
    payToAfter - payToBefore === BigInt(amount),
    { payToBefore: String(payToBefore), payToAfter: String(payToAfter) },
  );

  const nonceUsed = await publicClient.readContract({
    address: asset,
    abi: TOKEN_ABI,
    functionName: "authorizationState",
    args: [payer.address, payment.paymentPayload.payload.authorization.nonce],
  });
  check("authorization nonce is marked as used on-chain", nonceUsed === true);

  // Replay
  const replay = await call("/settle", payment);
  check(
    "/settle rejects a replayed payment",
    replay.success === false &&
      replay.errorReason === "invalid_exact_evm_payload_nonce_used",
    replay,
  );

  console.log(
    failures === 0 ? "\nAll checks passed" : `\n${failures} check(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
