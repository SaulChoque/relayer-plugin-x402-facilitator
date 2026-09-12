/*
 x402 Facilitator Plugin — EVM Smoke Test Script

 What it does
 - Checks /supported endpoint to verify plugin is running and returns expected signers
 - Signs an EIP-3009 `transferWithAuthorization` payload with a local wallet
 - Submits it via /verify and /settle
 - Verifies the settlement response includes a transaction hash

 Prerequisites
 - Node.js 22+ or Bun (global fetch available)
 - A funded EVM private key (payer). On Avalanche Fuji, fund it with:
   - AVAX (only needed if the payer ever pays gas directly — not required here,
     the relayer pays gas) and the test asset (e.g. Fuji USDC from the Circle faucet).

 Usage Examples

   # Avalanche Fuji testnet (chain id 43113), default Circle testnet USDC
   tsx scripts/smoke-evm.ts \
     --api-key YOUR_API_KEY \
     --base-url https://your-relayer/api/v1/plugins/x402/call \
     --private-key 0xYOUR_PAYER_PRIVATE_KEY

   # HSK (HashKey Chain) testnet (chain id 133) with a custom EIP-3009 asset
   tsx scripts/smoke-evm.ts \
     --api-key YOUR_API_KEY \
     --base-url https://your-relayer/api/v1/plugins/x402/call \
     --private-key 0xYOUR_PAYER_PRIVATE_KEY \
     --network eip155:133 \
     --rpc-url https://testnet.hsk.xyz \
     --asset 0xYourEip3009TokenAddress \
     --domain-name "Your Token" \
     --domain-version 1

   # Run specific test
   tsx scripts/smoke-evm.ts --api-key YOUR_API_KEY --base-url ... --private-key ... --test-id supported

 Flags / env (args > env > defaults)
   --api-key (API_KEY)               required: API key for authentication
   --base-url (BASE_URL)              required: x402 plugin call URL (e.g. https://.../call/x402)
   --private-key (PRIVATE_KEY)        required: payer EVM private key (0x-prefixed)
   --pay-to (PAY_TO)                  default: same as payer address (self-payment for testing)
   --amount (AMOUNT)                  default: 1 (smallest unit of the asset)
   --asset (ASSET)                    default: 0x5425890298aed601595a70AB815c96711a31Bc65 (Fuji USDC)
   --network (NETWORK)                default: eip155:43113 (Avalanche Fuji)
   --rpc-url (RPC_URL)                default: https://api.avax-test.network/ext/bc/C/rpc
   --domain-name (DOMAIN_NAME)        default: USD Coin
   --domain-version (DOMAIN_VERSION)  default: 2
   --test-id (TEST_ID)                optional: run only one test (supported, verify, settle)
   --max-timeout (MAX_TIMEOUT)        default: 60 (seconds)
   --debug                            optional: print full responses
*/

import { Wallet } from "ethers";

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.includes("=") ? a.split("=") : [a, undefined];
    const key = k.replace(/^--/, "").trim();
    if (v !== undefined) out[key] = v;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

/**
 * Call x402 plugin endpoint
 */
async function callEndpoint(
  baseUrl: string,
  path: string,
  apiKey: string,
  body?: unknown,
  method: string = "POST",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; data: any }> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, data };
}

/**
 * Fetches the latest block timestamp from a public JSON-RPC endpoint, used to
 * pick a validAfter/validBefore window that the facilitator's own chain-time
 * check will accept.
 */
async function getChainTimestampSeconds(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  });
  const json = (await res.json()) as { result?: { timestamp: string } };
  if (!json.result) {
    throw new Error(`Failed to fetch latest block from ${rpcUrl}`);
  }
  return parseInt(json.result.timestamp, 16);
}

async function getChainId(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
  });
  const json = (await res.json()) as { result?: string };
  if (!json.result) {
    throw new Error(`Failed to fetch chain id from ${rpcUrl}`);
  }
  return parseInt(json.result, 16);
}

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

async function signAuthorization(opts: {
  wallet: Wallet;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  chainId: number;
  verifyingContract: string;
  domainName: string;
  domainVersion: string;
}) {
  const {
    wallet,
    to,
    value,
    validAfter,
    validBefore,
    chainId,
    verifyingContract,
    domainName,
    domainVersion,
  } = opts;

  const nonce =
    "0x" +
    Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, "0"),
    ).join("");

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = String(args["api-key"] || process.env.API_KEY || "");
  const baseUrl = String(args["base-url"] || process.env.BASE_URL || "");
  const privateKey = String(
    args["private-key"] || process.env.PRIVATE_KEY || "",
  );
  const network = String(
    args["network"] || process.env.NETWORK || "eip155:43113",
  );
  const rpcUrl = String(
    args["rpc-url"] ||
      process.env.RPC_URL ||
      "https://api.avax-test.network/ext/bc/C/rpc",
  );
  const asset = String(
    args["asset"] ||
      process.env.ASSET ||
      "0x5425890298aed601595a70AB815c96711a31Bc65",
  );
  const domainName = String(
    args["domain-name"] || process.env.DOMAIN_NAME || "USD Coin",
  );
  const domainVersion = String(
    args["domain-version"] || process.env.DOMAIN_VERSION || "2",
  );
  const amount = String(args["amount"] || process.env.AMOUNT || "1");
  const maxTimeout = parseInt(
    String(args["max-timeout"] || process.env.MAX_TIMEOUT || "60"),
    10,
  );
  const testId = (args["test-id"] || process.env.TEST_ID) as string | undefined;
  const debug = Boolean(args["debug"] || process.env.DEBUG);

  if (!apiKey) {
    console.error("Set --api-key or API_KEY");
    process.exit(1);
  }
  if (!baseUrl) {
    console.error("Set --base-url or BASE_URL");
    process.exit(1);
  }
  if (!privateKey) {
    console.error("Set --private-key or PRIVATE_KEY");
    process.exit(1);
  }

  const wallet = new Wallet(privateKey);
  const payTo = String(args["pay-to"] || process.env.PAY_TO || wallet.address);

  const chainId = await getChainId(rpcUrl);
  const expectedChainId = Number(network.replace(/^eip155:/, ""));
  if (chainId !== expectedChainId) {
    console.error(
      `RPC chain id (${chainId}) does not match --network (${network} = ${expectedChainId})`,
    );
    process.exit(1);
  }

  const paymentRequirements = {
    scheme: "exact" as const,
    network,
    amount,
    payTo,
    maxTimeoutSeconds: maxTimeout,
    asset,
    extra: { areFeesSponsored: true, name: domainName, version: domainVersion },
  };

  type Ctx = {
    baseUrl: string;
    apiKey: string;
    rpcUrl: string;
    wallet: Wallet;
    payTo: string;
    amount: string;
    asset: string;
    network: string;
    chainId: number;
    maxTimeout: number;
    domainName: string;
    domainVersion: string;
    debug: boolean;
    paymentRequirements: typeof paymentRequirements;
  };

  const ctx: Ctx = {
    baseUrl,
    apiKey,
    rpcUrl,
    wallet,
    payTo,
    amount,
    asset,
    network,
    chainId,
    maxTimeout,
    domainName,
    domainVersion,
    debug,
    paymentRequirements,
  };

  async function buildSignedPayload(c: Ctx) {
    const chainTimestamp = await getChainTimestampSeconds(c.rpcUrl);
    const { signature, authorization } = await signAuthorization({
      wallet: c.wallet,
      to: c.payTo,
      value: c.amount,
      validAfter: String(chainTimestamp - 10),
      validBefore: String(chainTimestamp + c.maxTimeout - 5),
      chainId: c.chainId,
      verifyingContract: c.asset,
      domainName: c.domainName,
      domainVersion: c.domainVersion,
    });

    return {
      paymentPayload: {
        x402Version: 2,
        accepted: c.paymentRequirements,
        payload: { signature, authorization },
      },
      paymentRequirements: c.paymentRequirements,
    };
  }

  const TESTS: {
    id: string;
    label: string;
    run: (ctx: Ctx) => Promise<void>;
  }[] = [
    {
      id: "supported",
      label: "GET /supported — verify plugin is running",
      run: async ({ baseUrl, apiKey, debug }) => {
        const res = await callEndpoint(
          baseUrl,
          "/supported",
          apiKey,
          undefined,
          "GET",
        );
        if (res.status !== 200) {
          throw new Error(
            `/supported returned ${res.status}: ${JSON.stringify(res.data)}`,
          );
        }
        const kinds = res.data?.kinds || res.data?.data?.kinds;
        const signers = res.data?.signers || res.data?.data?.signers;
        if (debug) console.log(JSON.stringify(res.data, null, 2));
        console.log(`   kinds: ${JSON.stringify(kinds)}`);
        if (signers) console.log(`   signers: ${JSON.stringify(signers)}`);
        console.log("   /supported OK");
      },
    },
    {
      id: "verify",
      label: "POST /verify — verify an EIP-3009 payload",
      run: async (c) => {
        const body = await buildSignedPayload(c);
        const res = await callEndpoint(c.baseUrl, "/verify", c.apiKey, body);
        if (c.debug) console.log(JSON.stringify(res.data, null, 2));

        const result = res.data?.data || res.data;
        if (result?.isValid) {
          console.log(`   payer: ${result.payer}`);
          console.log("   /verify OK — payload is valid");
        } else {
          throw new Error(
            `/verify rejected: ${result?.invalidReason || JSON.stringify(result)}`,
          );
        }
      },
    },
    {
      id: "settle",
      label: "POST /settle — settle an EIP-3009 payment on-chain",
      run: async (c) => {
        const body = await buildSignedPayload(c);
        const res = await callEndpoint(c.baseUrl, "/settle", c.apiKey, body);
        if (c.debug) console.log(JSON.stringify(res.data, null, 2));

        const result = res.data?.data || res.data;
        if (result?.success && result?.transaction) {
          console.log(`   tx: ${result.transaction}`);
          console.log(`   network: ${result.network}`);
          if (result.payer) console.log(`   payer: ${result.payer}`);
          console.log("   /settle OK");
        } else {
          throw new Error(
            `/settle failed: ${result?.errorReason || JSON.stringify(result)}`,
          );
        }
      },
    },
  ];

  const selected = testId ? TESTS.filter((t) => t.id === testId) : TESTS;
  if (selected.length === 0) {
    console.error(
      `Unknown --test-id '${testId}'. Available: ${TESTS.map((t) => t.id).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    "================================================================",
  );
  console.log("  x402 Facilitator Plugin — EVM Smoke Tests");
  console.log(
    "================================================================\n",
  );
  console.log(`  base-url:  ${baseUrl}`);
  console.log(`  network:   ${network} (chain id ${chainId})`);
  console.log(`  payer:     ${wallet.address}`);
  console.log(`  pay-to:    ${payTo}`);
  console.log(`  asset:     ${asset}`);
  console.log(`  amount:    ${amount}`);
  console.log("");

  const start = Date.now();
  let failed = 0;

  for (const t of selected) {
    console.log(`> ${t.label}...`);
    try {
      await t.run(ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      failed++;
      console.error(`   FAILED: ${err?.message || err}`);
      if (debug && err?.stack) console.error(err.stack);
    }
    console.log("");
  }

  const elapsed = Date.now() - start;
  console.log(
    "================================================================",
  );
  if (failed > 0) {
    console.log(`  ${failed} test(s) FAILED (${elapsed}ms)`);
    process.exit(1);
  } else {
    console.log(`  All tests passed (${elapsed}ms)`);
  }
  console.log(
    "================================================================",
  );
}

main().catch((e) => {
  console.error("Fatal:", e?.message || String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
