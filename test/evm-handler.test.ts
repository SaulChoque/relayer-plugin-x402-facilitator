import { describe, expect, test } from "vitest";
import { getAddress } from "viem";
import { handler } from "../src/handler";
import {
  addressesEqual,
  encodeTransferWithAuthorization,
  isValidEvmNetwork,
  isValidExactEvmPayload,
  parseEvmChainId,
} from "../src/evm/utils";
import { validateVerifyRequest } from "../src/validation";
import {
  NETWORK,
  RELAYER_ADDRESS,
  SELECTORS,
  TX_HASH,
  createEvmApi,
  createEvmRequest,
  decodeTransferCall,
  networkConfig,
  payerAccount,
} from "./helpers/evm";

function context(route: string, params: unknown, api: any, config: any) {
  return {
    route,
    params,
    api,
    config,
    kv: {} as any,
    headers: {},
    method: "POST",
    query: {},
  } as any;
}

const mixedConfig = {
  networks: [
    {
      network: "stellar:testnet",
      type: "stellar",
      relayer_id: "stellar-relayer",
      assets: ["CASSET"],
    },
    networkConfig,
    {
      network: "eip155:42161",
      type: "evm",
      relayer_id: "arbitrum-relayer",
      assets: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
    },
  ],
};

describe("EVM utils", () => {
  test("parses CAIP-2 eip155 identifiers", () => {
    expect(parseEvmChainId("eip155:8453")).toBe(8453);
    expect(parseEvmChainId("eip155:43114")).toBe(43114);
    expect(parseEvmChainId("eip155:5042002")).toBe(5042002);
    expect(parseEvmChainId("eip155:0")).toBeNull();
    expect(parseEvmChainId("eip155:01")).toBeNull();
    expect(parseEvmChainId("base")).toBeNull();
    expect(parseEvmChainId("stellar:testnet")).toBeNull();
    expect(isValidEvmNetwork("eip155:42161")).toBe(true);
  });

  test("compares addresses case-insensitively", () => {
    const addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    expect(addressesEqual(addr, addr.toLowerCase())).toBe(true);
    expect(
      addressesEqual(addr, "0x0000000000000000000000000000000000000001"),
    ).toBe(false);
    expect(addressesEqual(addr, "not-an-address")).toBe(false);
    expect(addressesEqual(undefined, addr)).toBe(false);
  });

  test("validates payload shape", async () => {
    const request = await createEvmRequest();
    expect(isValidExactEvmPayload(request.paymentPayload.payload)).toBe(true);
    expect(isValidExactEvmPayload({ transaction: "AAAA" })).toBe(false);
    expect(
      isValidExactEvmPayload({
        ...(request.paymentPayload.payload as any),
        signature: "nothex",
      }),
    ).toBe(false);
    expect(
      isValidExactEvmPayload({
        ...(request.paymentPayload.payload as any),
        authorization: {
          ...(request.paymentPayload.payload as any).authorization,
          value: "-1",
        },
      }),
    ).toBe(false);
  });

  test("encodes the (v,r,s) overload for 65-byte signatures", async () => {
    const request = await createEvmRequest();
    const data = encodeTransferWithAuthorization(
      request.paymentPayload.payload as any,
    );
    expect(data.startsWith(SELECTORS.transferVRS)).toBe(true);
    const decoded = decodeTransferCall(data);
    expect([27, 28]).toContain(Number(decoded.args[6]));
  });

  test("encodes the bytes overload for other signatures", async () => {
    const request = await createEvmRequest({
      signature: ("0x" + "12".repeat(100)) as `0x${string}`,
    });
    const data = encodeTransferWithAuthorization(
      request.paymentPayload.payload as any,
    );
    expect(data.startsWith(SELECTORS.transferBytes)).toBe(true);
  });
});

describe("request validation", () => {
  test("accepts EVM requirements without areFeesSponsored", async () => {
    const request = await createEvmRequest();
    expect(validateVerifyRequest(request)).toBe(true);
  });

  test("still requires areFeesSponsored for Stellar requirements", async () => {
    const request = await createEvmRequest({
      requirements: { network: "stellar:testnet" },
    });
    expect(validateVerifyRequest(request)).toBe(false);
  });

  test("rejects non-boolean areFeesSponsored on EVM", async () => {
    const request = await createEvmRequest({
      requirements: {
        extra: { name: "USDC", version: "2", areFeesSponsored: "yes" },
      },
    });
    expect(validateVerifyRequest(request)).toBe(false);
  });
});

describe("handler EVM routing", () => {
  test("/verify dispatches evm networks", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi();

    const result = await handler(context("/verify", request, api, mixedConfig));
    expect(result).toEqual({ isValid: true, payer: payerAccount.address });
  });

  test("/settle dispatches evm networks", async () => {
    const request = await createEvmRequest();
    const { api, sendTransaction } = createEvmApi();

    const result = await handler(context("/settle", request, api, mixedConfig));
    expect(result).toMatchObject({
      success: true,
      transaction: TX_HASH,
      network: NETWORK,
    });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  test("/verify uses the relayer configured for the requested chain", async () => {
    const request = await createEvmRequest();
    const { api } = createEvmApi();

    await handler(context("/verify", request, api, mixedConfig));
    expect((api.useRelayer as any).mock.calls[0][0]).toBe(
      networkConfig.relayer_id,
    );
  });

  test("/verify returns unsupported_network for unconfigured chains", async () => {
    const request = await createEvmRequest({
      requirements: { network: "eip155:1" },
    });
    const { api } = createEvmApi();

    const result = await handler(context("/verify", request, api, mixedConfig));
    expect(result).toEqual({
      isValid: false,
      invalidReason: "unsupported_network",
    });
  });

  test("/supported lists EVM kinds and relayer signers", async () => {
    const { api } = createEvmApi();

    const result: any = await handler(
      context("/supported", {}, api, mixedConfig),
    );

    const evmKinds = result.kinds.filter((k: any) =>
      k.network.startsWith("eip155:"),
    );
    expect(evmKinds).toEqual([
      { x402Version: 2, scheme: "exact", network: NETWORK },
      { x402Version: 2, scheme: "exact", network: "eip155:42161" },
    ]);
    const stellarKind = result.kinds.find(
      (k: any) => k.network === "stellar:testnet",
    );
    expect(stellarKind.extra).toEqual({ areFeesSponsored: true });
    expect(getAddress(result.signers[NETWORK][0])).toBe(RELAYER_ADDRESS);
  });
});
