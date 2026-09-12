# x402 Facilitator Relayer Plugin

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/OpenZeppelin/relayer-plugin-x402-facilitator)

OpenZeppelin Relayer plugin that implements the x402 facilitator API so you can serve x402 payments directly from a Relayer instance. Works with the Coinbase x402 ecosystem (e.g., `@x402/express`) and exposes the expected `/verify`, `/settle`, and `/supported` endpoints under the Relayer plugin router.

**This version supports x402 v2 specification.** For x402 v1 support, please use a previous version of this plugin (check git history for v1-compatible releases).

## What you get

- x402 facilitator API implemented as a Relayer plugin (Stellar and EVM support)
- Uses your Relayer accounts/signers to verify and settle payments
- Supports multiple networks via config, including allowed assets per network
- EVM networks use the EIP-3009 (`transferWithAuthorization`) "exact" scheme — no gas held by the payer, no on-chain approval step
- Optional channel service integration for Stellar throughput

## Prerequisites

- Node.js 22.18+
- pnpm 10+
- An OpenZeppelin Relayer with at least one configured relayer account for each network you plan to serve

## Install

```bash
# inside your relayer repo
pnpm add @openzeppelin/relayer-plugin-x402-facilitator
```

For local development of the plugin itself:

```bash
pnpm install
pnpm build
```

## Wire it into the Relayer

1. Create a plugin wrapper (example path).

```
plugins/x402/index.ts
```

```ts
export { handler } from "@openzeppelin/relayer-plugin-x402-facilitator";
```

2. Add the plugin entry to your Relayer `config.json` (adjust `path` to your wrapper location or to the provided example file if you copied it, e.g., `examples/x402-facilitator/handler.ts`):

```json
{
  "plugins": [
    {
      "id": "x402",
      "path": "plugins/x402/index.ts",
      "emit_logs": false,
      "emit_traces": false,
      "raw_response": true,
      "forward_logs": true,
      "allow_get_invocation": true,
      "timeout": 30,
      "config": {
        "networks": [
          {
            "network": "stellar:testnet",
            "type": "stellar",
            "relayer_id": "stellar-example",
            "assets": [
              "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
            ]
          }
        ]
      }
    }
  ]
}
```

### Network config reference

Each object in `config.networks`:

- `network`: x402 network identifier (e.g., `stellar:testnet`, or `eip155:<chainId>` for EVM)
- `type`: `"stellar"` or `"evm"`
- `relayer_id`: ID of the Relayer account to use for this network
- `assets`: list of allowed assets (issuer addresses for Stellar, ERC-20 token contract addresses for EVM)
- `channel_service_api_url` / `channel_service_api_key` (optional, Stellar only): enable channel service acceleration
- `channel_service_fund_relayer_address` (optional, Stellar only): on-chain signer address of the channel service fund relayer, used in `/supported` response and security checks

### EVM networks (EIP-3009 "exact" scheme)

EVM networks use `type: "evm"` and are identified with the CAIP-2 `eip155:<chainId>` format. The asset must be an EIP-3009-compliant token (e.g., USDC) — the plugin calls `transferWithAuthorization` on it directly, so no on-chain approval step or gas from the payer is required.

Example: Avalanche Fuji testnet (chain id `43113`) and HSK (HashKey Chain) testnet (chain id `133`):

```json
{
  "config": {
    "networks": [
      {
        "network": "eip155:43113",
        "type": "evm",
        "relayer_id": "avalanche-fuji-relayer",
        "assets": ["0x5425890298aed601595a70AB815c96711a31Bc65"]
      },
      {
        "network": "eip155:133",
        "type": "evm",
        "relayer_id": "hsk-testnet-relayer",
        "assets": ["0xYourEip3009TokenAddress"]
      }
    ]
  }
}
```

`paymentRequirements.extra` must include the token's EIP-712 domain `name` and `version` (read them from the token contract's `name()`/`version()` functions, or a block explorer) so the facilitator can reconstruct the signed message and verify signatures:

```json
{
  "scheme": "exact",
  "network": "eip155:43113",
  "amount": "1000",
  "payTo": "0xYourReceivingAddress",
  "maxTimeoutSeconds": 60,
  "asset": "0x5425890298aed601595a70AB815c96711a31Bc65",
  "extra": {
    "areFeesSponsored": true,
    "name": "USD Coin",
    "version": "2"
  }
}
```

The `payload` for EVM `verify`/`settle` requests carries the EIP-3009 authorization instead of a signed transaction:

```json
{
  "signature": "0x...",
  "authorization": {
    "from": "0xPayerAddress",
    "to": "0xYourReceivingAddress",
    "value": "1000",
    "validAfter": "1740672089",
    "validBefore": "1740672154",
    "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f1348"
  }
}
```

`verify` cross-checks the relayer's own RPC connection is on the expected chain (`eth_chainId`), recovers the EIP-712 signature, checks the `validAfter`/`validBefore` window against the chain's own clock, checks `authorizationState` on-chain to reject replayed nonces, and re-simulates the call before `settle` broadcasts it.

### Exposed routes

Routes are called through the Relayer plugin call endpoint: `POST /api/v1/plugins/{plugin_id}/call{route}`.

- `/` or ``: info
- `/verify`: x402 v2 verify
- `/settle`: x402 v2 settle
- `/supported`: discovery of supported payment kinds (returns v2 format)

### x402 v2 Specification

This plugin implements the x402 v2 specification, which includes:

- **PaymentPayload v2**: Uses `accepted` field instead of top-level `scheme` and `network`
- **PaymentRequirements v2**: Uses `amount` instead of `maxAmountRequired`, removed `resource`/`description`/`mimeType` (moved to top-level `PaymentRequired`)
- **Supported endpoint v2**: Returns version-grouped `kinds`, `signers`, and `extensions` fields

The `/supported` endpoint returns data in the following v2 format:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "stellar:testnet",
      "extra": {
        "areFeesSponsored": true
      }
    }
  ],
  "signers": {
    "stellar:testnet": ["G-RELAYER-ADDRESS"]
  },
  "extensions": []
}
```

## Using with x402 packages (e.g., x402-express)

Point the facilitator to your Relayer plugin URL and pass the Relayer API key via `createAuthHeaders`.

```text
STELLAR_ADDRESS=
FACILITATOR_URL=http://localhost:8080/api/v1/plugins/x402/call
```

```typescript
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

const stellarAddress = process.env.STELLAR_ADDRESS as string | undefined;

// Validate stellar address is provided
if (!stellarAddress) {
  console.error("❌ STELLAR_ADDRESS is required");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  createAuthHeaders: async () => ({
    // Use your Relayer API key for the plugin
    verify: { Authorization: "Bearer RELAYER_API_KEY" },
    settle: { Authorization: "Bearer RELAYER_API_KEY" },
    supported: { Authorization: "Bearer RELAYER_API_KEY" },
  }),
});

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "stellar:testnet",
            payTo: stellarAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      "stellar:testnet",
      new ExactStellarScheme(),
    ),
  ),
);

app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
```

## Calls and auth

- **Auth:** The plugin uses standard Relayer auth. Send `Authorization: Bearer <RELAYER_API_KEY>` to each endpoint.
- **Verify:** `POST /api/v1/plugins/x402/call/verify`
- **Settle:** `POST /api/v1/plugins/x402/call/settle`
- **Supported:** `POST /api/v1/plugins/x402/call/supported` (or `GET` if `allow_get_invocation` is enabled)

## Using with Stellar Channels Service

For high-throughput x402 payment settlement, you can connect the plugin with the [OpenZeppelin Stellar Channels Service](https://docs.openzeppelin.com/relayer/guides/stellar-channels-guide). The Channels service provides managed infrastructure for parallel transaction submission on Stellar, handling fee management and sequence number coordination automatically.

**Benefits:**

- **Parallel settlement**: Multiple x402 payments can be settled concurrently using a pool of channel accounts
- **Automatic fee management**: The Channels service pays transaction fees on your behalf
- **Zero infrastructure overhead**: No need to manage channel accounts or fund accounts yourself
- **Higher throughput**: Avoids sequence number conflicts that can occur when settling many payments through a single relayer account

Add `channel_service_api_url` and `channel_service_api_key` to your network config:

```json
{
  "config": {
    "networks": [
      {
        "network": "stellar:testnet",
        "type": "stellar",
        "relayer_id": "stellar-example",
        "assets": ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
        "channel_service_api_url": "https://channels.openzeppelin.com/testnet",
        "channel_service_api_key": "YOUR_CHANNELS_API_KEY",
        "channel_service_fund_relayer_address": "G..."
      }
    ]
  }
}
```

**Key fields:**

- **`channel_service_api_url`**: The URL of the Channels service. Use `https://channels.openzeppelin.com/testnet` for testnet or the appropriate endpoint for your environment.
- **`channel_service_api_key`**: Your API key for the Channels service.
- **`channel_service_fund_relayer_address`** (optional): The on-chain signer address of the Channels service fund relayer. When set, the `/supported` endpoint reports this address instead of the RPC relayer address, and verify security checks also protect this address from being used as a transfer source.

When these fields are present, the plugin routes settlement through the Channels service instead of submitting transactions directly via the relayer. The plugin sends the Soroban function XDR and authorization entries to the Channels service, which handles transaction building, simulation, and submission using its pool of channel accounts.

## Adding Trustlines for Token Support

> **Note:** This is only needed if the relayer address needs to hold tokens like USDC. If the relayer is only used for transaction submission and does not receive or hold the asset, no trustline is required.

Before a Stellar account can hold or receive tokens like USDC, it must establish a **trustline** to the token's contract. You can create a trustline using [Stellar Laboratory](https://lab.stellar.org) to build a `Change Trust` transaction, then submit the XDR via the relayer:

```
POST /api/v1/relayers/{relayer-id}/transactions
```

```json
{
  "params": {
    "network": "testnet",
    "transaction_xdr": "<XDR_VALUE>"
  }
}
```

## Development & testing

```bash
pnpm test
pnpm lint
pnpm build
```

## License

AGPL-3.0
