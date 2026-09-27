/*
 x402 Facilitator Plugin — Solana end-to-end script

 What it does
 - Calls /supported and reads the facilitator fee payer from `extra.feePayer`
 - Builds payments with the official x402 SVM client (`@x402/svm` ExactSvmScheme)
 - Calls /verify for a valid payment and for mismatching requirements
 - Calls /settle, then checks on-chain: fee payer = relayer, v0 transaction,
   exact token balance changes, and that the payer spent no SOL
 - Replays the payment and settles another one twice concurrently
   (both must be rejected as duplicate settlements)

 Prerequisites
 - A running OpenZeppelin Relayer with this plugin configured for NETWORK, and a
   Solana relayer with `fee_payment_strategy: "relayer"`. Official x402 clients
   send v0 transactions, which need a relayer that can sign versioned Solana
   transactions.
 - An SPL token mint (ASSET), a payer keypair holding at least 2 * AMOUNT of it,
   and an existing token account for PAY_TO.

 Usage (tsx, or plain `node` on Node.js 22.18+ which strips TypeScript types)

   tsx scripts/e2e-solana.ts \
     --base-url http://localhost:8080/api/v1/plugins/x402/call \
     --api-key YOUR_RELAYER_API_KEY \
     --rpc-url http://127.0.0.1:8899 \
     --network solana:<first 32 chars of the genesis hash> \
     --asset <mint address> \
     --payer-keypair ./payer.json \
     --pay-to <recipient wallet address> \
     [--amount 10000] [--client-network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1]

 `--client-network` only selects which cluster id the x402 client accepts (it
 supports the public clusters); the client always talks to `--rpc-url`. Use it
 when testing against a local validator.
*/
import { readFileSync } from "fs";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64Encoder,
  getTransactionDecoder,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { ExactSvmScheme } from "@x402/svm/exact/client";

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
const clientNetwork = arg("client-network", network);
const asset = address(arg("asset"));
const payTo = address(arg("pay-to"));
const amount = arg("amount", "10000");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const rpc = createSolanaRpc(rpcUrl);

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined)
      console.log(
        "      ",
        JSON.stringify(detail, (_, v) =>
          typeof v === "bigint" ? String(v) : v,
        ),
      );
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

async function tokenBalance(owner: string): Promise<bigint> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: asset,
    tokenProgram: TOKEN_PROGRAM,
  });
  const { value } = await rpc
    .getTokenAccountBalance(ata, { commitment: "confirmed" })
    .send();
  return BigInt(value.amount);
}

async function main() {
  const payer = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(arg("payer-keypair"), "utf8"))),
  );
  const client = new ExactSvmScheme(payer as never, { rpcUrl });

  // /supported
  const supported = await call("/supported");
  const kind = supported.kinds?.find((k: any) => k.network === network);
  const feePayer: string | undefined = kind?.extra?.feePayer;
  check(
    "/supported lists the Solana network with extra.feePayer",
    !!feePayer,
    supported,
  );
  check(
    "/supported signer is the fee payer",
    supported.signers?.[network]?.[0] === feePayer,
    supported.signers,
  );

  const requirements = {
    scheme: "exact",
    network,
    amount,
    payTo,
    asset,
    maxTimeoutSeconds: 60,
    extra: { feePayer },
  };

  async function pay() {
    const built = await client.createPaymentPayload(2, {
      ...requirements,
      network: clientNetwork,
    } as never);
    return {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: built.payload,
      },
      paymentRequirements: requirements,
    };
  }

  // /verify
  const payment = await pay();
  const txBase64 = (payment.paymentPayload.payload as { transaction: string })
    .transaction;
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(txBase64),
  );
  check(
    "x402 client produced a v0 transaction",
    (decoded.messageBytes[0] & 0x80) !== 0,
  );

  const verified = await call("/verify", payment);
  check(
    "/verify accepts a payment from the official x402 client",
    verified.isValid === true && verified.payer === payer.address,
    verified,
  );

  const wrongAmount = await call("/verify", {
    ...payment,
    paymentRequirements: {
      ...requirements,
      amount: String(BigInt(amount) + 1n),
    },
    paymentPayload: {
      ...payment.paymentPayload,
      accepted: { ...requirements, amount: String(BigInt(amount) + 1n) },
    },
  });
  check(
    "/verify rejects a different amount",
    wrongAmount.invalidReason === "invalid_exact_svm_payload_amount_mismatch",
    wrongAmount,
  );

  const memoRequired = {
    ...requirements,
    extra: { ...requirements.extra, memo: "invoice-42" },
  };
  const wrongMemo = await call("/verify", {
    paymentPayload: { ...payment.paymentPayload, accepted: memoRequired },
    paymentRequirements: memoRequired,
  });
  check(
    "/verify rejects a missing seller memo",
    wrongMemo.invalidReason === "invalid_exact_svm_payload_memo_mismatch" ||
      wrongMemo.invalidReason === "invalid_exact_svm_payload_memo_count",
    wrongMemo,
  );

  // /settle
  const payerBefore = await tokenBalance(payer.address);
  const payToBefore = await tokenBalance(payTo);
  const { value: payerLamportsBefore } = await rpc
    .getBalance(payer.address, { commitment: "confirmed" })
    .send();

  const settled = await call("/settle", payment);
  check(
    "/settle succeeds and returns a transaction signature",
    settled.success === true &&
      typeof settled.transaction === "string" &&
      settled.transaction.length > 80,
    settled,
  );

  if (settled.success) {
    const tx = await rpc
      .getTransaction(settled.transaction, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      })
      .send();
    check(
      "transaction is on-chain without errors",
      !!tx && tx.meta?.err === null,
      tx?.meta?.err,
    );
    check("transaction version is 0", tx?.version === 0, tx?.version);
    check(
      "fee payer is the relayer",
      tx?.transaction.message.accountKeys[0] === feePayer,
      tx?.transaction.message.accountKeys[0],
    );
  }

  const payerAfter = await tokenBalance(payer.address);
  const payToAfter = await tokenBalance(payTo);
  const { value: payerLamportsAfter } = await rpc
    .getBalance(payer.address, { commitment: "confirmed" })
    .send();
  check(
    "payer token balance decreased by exactly the amount",
    payerBefore - payerAfter === BigInt(amount),
    { payerBefore, payerAfter },
  );
  check(
    "payTo token balance increased by exactly the amount",
    payToAfter - payToBefore === BigInt(amount),
    { payToBefore, payToAfter },
  );
  check(
    "payer spent no SOL (fees sponsored by the relayer)",
    payerLamportsAfter === payerLamportsBefore,
    { payerLamportsBefore, payerLamportsAfter },
  );

  // Replay and concurrent duplicate settlement. A replay of a transaction that
  // already landed fails re-verification (simulation: AlreadyProcessed) or hits
  // the duplicate guard; concurrent in-flight settlements hit the guard.
  const replay = await call("/settle", payment);
  check(
    "/settle rejects a replayed payment",
    replay.success === false &&
      ["duplicate_settlement", "transaction_simulation_failed"].includes(
        replay.errorReason,
      ),
    replay,
  );

  const second = await pay();
  const [a, b] = await Promise.all([
    call("/settle", second),
    call("/settle", second),
  ]);
  check(
    "concurrent /settle of the same payment: exactly one succeeds",
    [a, b].filter((r) => r.success).length === 1 &&
      [a, b].filter((r) => r.errorReason === "duplicate_settlement").length ===
        1,
    [a, b],
  );
  const payToFinal = await tokenBalance(payTo);
  check(
    "payTo received exactly two payments in total",
    payToFinal - payToBefore === 2n * BigInt(amount),
    { payToBefore, payToFinal },
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
