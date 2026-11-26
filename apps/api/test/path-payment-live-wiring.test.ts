import { Keypair, Networks, type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPathPaymentXdr, type PlannedPathPayment } from "../../web/lib/payment-build";

// apps/api/test/live/path-payment.live.test.ts only runs with
// RUN_LIVE_PATH_TESTS=1, which CI never sets, so a wiring mistake there would
// first show up in the nightly probe. This builds the same transaction offline,
// through the same builder, so the ordinary test run fails instead.
describe("live path-payment probe wiring (issue 5.51)", () => {
  const plan: PlannedPathPayment = {
    sourceAsset: { code: "XLM", issuer: null },
    sourceAmount: "15.4133304",
    path: [],
    maxSourceAmount: "15.5674638",
    priceImpactBps: 121,
  };

  it("builds the path payment the probe submits, capped at the buyer's accepted sendMax", async () => {
    const buyer = Keypair.random();
    const xdr = await buildPathPaymentXdr({
      address: buyer.publicKey(),
      sequence: "0",
      destination: Keypair.random().publicKey(),
      destAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      destAmount: "10",
      networkPassphrase: Networks.TESTNET,
      memo: "probe-reference",
      plan,
    });

    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0]!;
    expect(op.type).toBe("pathPaymentStrictReceive");
    if (op.type !== "pathPaymentStrictReceive") throw new Error("unreachable");
    expect(op.sendAsset.isNative()).toBe(true);
    // Never the fresh quote: the cap the buyer accepted is what protects them.
    expect(op.sendMax).toBe(plan.maxSourceAmount);
    expect(Number(op.destAmount)).toBe(10);
    expect(op.destAsset.getCode()).toBe("USDC");
    expect(tx.memo.value?.toString()).toBe("probe-reference");
  });

  it("the live probe is opt-in and needs the path-payments flag", () => {
    const source = readFileSync(
      new URL("./live/path-payment.live.test.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('process.env.RUN_LIVE_PATH_TESTS === "1"');
    expect(source).toContain("describe.skipIf(!LIVE_PATH)");
    expect(source).toContain("PATH_PAYMENTS_ENABLED is not true in this process");
  });
});
