import { Keypair, type Asset, type Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import type { PaymentLink } from "@checkout/core";
import type { HorizonClient } from "@checkout/stellar";
import {
  createPayOptionsQuoter,
  PAY_OPTIONS_TTL_MS,
  type PayOptionsQuoterDeps,
} from "../src/services/pay-options";

const USDC_ISSUER = Keypair.random().publicKey();
const USDC = { code: "USDC", issuer: USDC_ISSUER };
const BUYER = Keypair.random().publicKey();
const NOW = 1_800_000_000_000;

type PathRecord = Horizon.ServerApi.PaymentPathRecord;

/** Horizon strict-receive stub: one canned record list per destination amount. */
class FakePaths {
  calls: Array<{ source: string | Asset[]; destAmount: string }> = [];
  private readonly byAmount = new Map<string, PathRecord[]>();
  private failure: unknown = null;

  set(destAmount: string, records: PathRecord[]): void {
    this.byAmount.set(destAmount, records);
  }

  fail(err: unknown): void {
    this.failure = err;
  }

  strictReceivePaths(source: string | Asset[], _dest: Asset, destAmount: string) {
    this.calls.push({ source, destAmount });
    return {
      call: async () => {
        if (this.failure) throw this.failure;
        return { records: [...(this.byAmount.get(destAmount) ?? [])] };
      },
    };
  }

  payments(): never {
    throw new Error("payments() is not used by the quoter");
  }

  loadAccount(): never {
    throw new Error("loadAccount() is not used by the quoter");
  }
}

function xlmRecord(sourceAmount: string): PathRecord {
  return {
    _links: { self: { href: "" } },
    path: [],
    source_amount: sourceAmount,
    source_asset_type: "native",
    source_asset_code: "",
    source_asset_issuer: "",
    destination_amount: "10",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: USDC_ISSUER,
  };
}

function link(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "ref_1",
    sellerId: "sel_1",
    destination: "GDEST",
    muxedId: null,
    title: "T-shirt",
    amount: "10",
    asset: USDC,
    status: "active",
    txHash: null,
    payer: null,
    paidAmount: null,
    overpaidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    offrampIndicativeRate: null,
    offrampRate: null,
    offrampRateDelta: null,
    offrampFeeAmount: null,
    offrampFeeCurrency: null,
    offrampFeeSource: null,
    offrampNetTargetAmount: null,
    expiresAt: null,
    isDemo: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function quoter(fake: FakePaths, over: Partial<PayOptionsQuoterDeps> = {}) {
  return createPayOptionsQuoter({
    client: fake as unknown as HorizonClient,
    maxSlippageBps: 100,
    now: () => NOW,
    ...over,
  });
}

describe("createPayOptionsQuoter (issue 4.64)", () => {
  it("quotes the buyer's own account and adds sendMax plus an expiry", async () => {
    const fake = new FakePaths();
    fake.set("10", [xlmRecord("24.12")]);

    const result = await quoter(fake)({ link: link(), account: BUYER });

    expect(result).toEqual({
      options: [
        { asset: { code: "XLM", issuer: null }, sourceAmount: "24.12", maxSourceAmount: "24.3612" },
      ],
      expiresAt: NOW + PAY_OPTIONS_TTL_MS,
    });
    // One Horizon quote per request, whatever the panel will end up showing.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.source).toBe(BUYER);
    expect(fake.calls[0]?.destAmount).toBe("10");
  });

  it("quotes every asset from a single Horizon call", async () => {
    const fake = new FakePaths();
    fake.set("10", [
      xlmRecord("24.12"),
      {
        ...xlmRecord("3.5"),
        source_asset_type: "credit_alphanum4",
        source_asset_code: "AQUA",
        source_asset_issuer: Keypair.random().publicKey(),
      },
    ]);

    const result = await quoter(fake)({ link: link(), account: BUYER });

    expect(fake.calls).toHaveLength(1);
    expect(result.options.map((option) => option.asset.code)).toEqual(["AQUA", "XLM"]);
  });

  it("applies the deployment's slippage to every maxSourceAmount", async () => {
    const fake = new FakePaths();
    fake.set("10", [xlmRecord("24.12")]);

    const result = await quoter(fake, { maxSlippageBps: 500 })({ link: link(), account: BUYER });

    expect(result.options[0]?.maxSourceAmount).toBe("25.326");
  });

  it("never offers the link asset itself", async () => {
    const fake = new FakePaths();
    // Horizon echoes the destination asset back as a plain payment; the shared
    // quote helper drops it, so the checkout keeps listing it separately.
    fake.set("10", [
      {
        ...xlmRecord("10"),
        source_asset_type: "credit_alphanum4",
        source_asset_code: "USDC",
        source_asset_issuer: USDC_ISSUER,
      },
    ]);

    const result = await quoter(fake)({ link: link(), account: BUYER });

    expect(result).toEqual({ options: [] });
  });

  it("quotes only the remainder of an underpaid link", async () => {
    const fake = new FakePaths();
    fake.set("6", [xlmRecord("14.4")]);

    const result = await quoter(fake)({
      link: link({ status: "underpaid", paidAmount: "4" }),
      account: BUYER,
    });

    expect(fake.calls[0]?.destAmount).toBe("6");
    expect(result.options[0]?.sourceAmount).toBe("14.4");
  });

  it("offers nothing once an underpaid link is fully covered", async () => {
    const fake = new FakePaths();

    const result = await quoter(fake)({
      link: link({ status: "underpaid", paidAmount: "10" }),
      account: BUYER,
    });

    expect(result).toEqual({ options: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["paid", "cancelled", "expired", "offramp_pending"] as const)(
    "offers nothing for a %s link, without asking Horizon",
    async (status) => {
      const fake = new FakePaths();

      const result = await quoter(fake)({ link: link({ status }), account: BUYER });

      expect(result).toEqual({ options: [] });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("caps the quote's expiry at the link's own expiry", async () => {
    const fake = new FakePaths();
    fake.set("10", [xlmRecord("24.12")]);

    const result = await quoter(fake)({ link: link({ expiresAt: NOW + 5_000 }), account: BUYER });

    expect(result.expiresAt).toBe(NOW + 5_000);
  });

  it("offers nothing for a link whose expiry has passed", async () => {
    const fake = new FakePaths();

    const result = await quoter(fake)({ link: link({ expiresAt: NOW }), account: BUYER });

    expect(result).toEqual({ options: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("does not hide an expensive option — price impact belongs to 5.48", async () => {
    const fake = new FakePaths();
    fake.set("10", [xlmRecord("30")]);

    const result = await quoter(fake)({ link: link(), account: BUYER });

    // The quote is advisory; the payment builder re-quotes and enforces the cap.
    expect(result.options).toEqual([
      { asset: { code: "XLM", issuer: null }, sourceAmount: "30", maxSourceAmount: "30.3" },
    ]);
  });

  it("degrades to no options when Horizon fails, and reports the failure", async () => {
    const fake = new FakePaths();
    // 400 is terminal for the retry helper, so this test does not sleep.
    fake.fail(Object.assign(new Error("bad request"), { response: { status: 400 } }));
    const onError = vi.fn();

    const result = await quoter(fake, { onError })({ link: link(), account: BUYER });

    expect(result).toEqual({ options: [] });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "lnk_1");
  });
});
