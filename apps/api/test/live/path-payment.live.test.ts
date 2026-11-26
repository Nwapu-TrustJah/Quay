import {
  BASE_FEE,
  Keypair,
  Networks,
  type Operation,
  type Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HorizonWatcher, realHorizonClient } from "@checkout/stellar";
import { createPayOptionsQuoter } from "../../src/services/pay-options";
import { linkRoutes } from "../../src/routes/links";
import { publicRoutes } from "../../src/routes/public";
import { WatcherLoop } from "../../src/worker/watcher-loop";
import { createTestContainer, type TestContainer } from "../setup";
import { buildPathPaymentXdr, planPathPayment } from "../../../web/lib/payment-build";
import {
  FRIENDBOT_TESTNET,
  HORIZON_TESTNET,
  ProbeFundingError,
  USDC_TESTNET_ISSUER,
  ensureProbeAccount,
  loadAccount,
  mergeProbeTelemetry,
  pollUntil,
  type HorizonAccount,
} from "../../../../packages/offramp/test/live-probe";

/**
 * Testnet end-to-end path-payment probe (issue 5.51).
 *
 * The live proof that a buyer can pay a link in an asset the seller did not ask
 * for. A 10 USDC link is created for a throwaway seller, the buyer quotes it
 * with `GET /links/:id/pay-options`, gets priced in XLM, builds a real
 * `pathPaymentStrictReceive` through the checkout's own builder (5.48), submits
 * it through `POST /links/:id/submit`, and the probe's watcher has to mark the
 * link `paid`. The receipt and the seller's CSV export must then say what the
 * buyer actually spent.
 *
 * Why USDC link / XLM buyer: the link asset has to be something the seller can
 * hold (USDC, Circle's testnet issuer — the API's default `USDC_ISSUER_TESTNET`),
 * and testnet already has an SDEX market between XLM and it, so the probe needs
 * to create no offers of its own. XLM is what Friendbot hands out, so the buyer
 * needs no faucet, no trustline and no secret: every run uses throwaway keys.
 *
 * Gated on `RUN_LIVE_PATH_TESTS=1` (the flag itself must be on as well, because
 * `pay-options` reads `PATH_PAYMENTS_ENABLED` from the environment): without it
 * the whole file is skipped, never failed. When live, each `it` is one stage
 * and is skipped once an earlier stage has not completed, so the first red test
 * names where the flow broke. The last stage completed is written to
 * `path-payment-probe-telemetry.json` for the job summary, together with the
 * Horizon path-call timings measured here.
 *
 * The only keys involved are throwaway testnet probe keys. The test process
 * signs the buyer's payment in the test process, standing in for the wallet;
 * no code under `src/` gains a key, and `pnpm check:no-server-signing` still
 * passes because it does not scan `test/`.
 */
const LIVE_PATH = process.env.RUN_LIVE_PATH_TESTS === "1";

/** The link is denominated in USDC; the buyer pays it in XLM. */
const LINK_AMOUNT = "10";
/** The cap the API serves when the deployment does not override it. */
const DEFAULT_MAX_PRICE_IMPACT_BPS = 300;
/** Spare XLM kept back for fees and the account's own reserve. */
const XLM_HEADROOM = 2;

const PREPARE_TIMEOUT_MS = 180_000;
const BOOT_TIMEOUT_MS = 60_000;
const OPTIONS_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 60_000;
const PAY_TIMEOUT_MS = 300_000;
const RECEIPT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;

/** Stages of the probe, in order. The first one not reached is where it failed. */
const PATH_STAGES = ["prepare", "boot", "options", "build", "pay", "receipt"] as const;
type PathStage = (typeof PATH_STAGES)[number];

/** Which stage failed, given the last one completed (null = none), or null when all completed. */
function failedPathStage(lastCompleted: PathStage | null): PathStage | null {
  const next = lastCompleted === null ? 0 : PATH_STAGES.indexOf(lastCompleted) + 1;
  return PATH_STAGES[next] ?? null;
}

function keypairFromEnv(name: string): Keypair | null {
  const secret = process.env[name];
  return secret ? Keypair.fromSecret(secret) : null;
}

/** XLM balance in lumens, from a Horizon account record. */
function xlmBalance(account: HorizonAccount): number {
  const line = account.balances.find((b) => b.asset_type === "native");
  return line ? Number(line.balance) : 0;
}

/**
 * Make sure `keypair` exists and holds XLM. Friendbot funds a new account with
 * 10,000 XLM, which is all this buyer needs — it spends XLM and receives
 * nothing, so it needs no trustline at all.
 */
async function ensureXlmAccount(keypair: Keypair): Promise<HorizonAccount> {
  const id = keypair.publicKey();
  let account = await loadAccount(HORIZON_TESTNET, id);
  if (!account) {
    const res = await fetch(`${FRIENDBOT_TESTNET}/?addr=${id}`);
    if (!res.ok) throw new ProbeFundingError(`Friendbot could not fund ${id} (${res.status})`);
    account = await loadAccount(HORIZON_TESTNET, id);
    if (!account) throw new ProbeFundingError(`${id} still does not exist on testnet after Friendbot`);
  }
  return account;
}

interface HorizonTransaction {
  hash: string;
  successful: boolean;
  memo_type: string | null;
  memo: string | null;
}

async function horizonTransaction(hash: string): Promise<HorizonTransaction> {
  const res = await fetch(`${HORIZON_TESTNET}/transactions/${hash}`);
  if (!res.ok) throw new Error(`Horizon GET /transactions/${hash} returned ${res.status}`);
  return (await res.json()) as HorizonTransaction;
}

interface HorizonPaymentOperation {
  type: string;
  from: string;
  to: string;
  amount: string;
  asset_code?: string;
  asset_issuer?: string;
  source_asset_type?: string;
  source_amount?: string;
  send_max?: string;
}

async function transactionOperations(txHash: string): Promise<HorizonPaymentOperation[]> {
  const res = await fetch(`${HORIZON_TESTNET}/transactions/${txHash}/operations`);
  if (!res.ok) throw new Error(`Horizon GET /transactions/${txHash}/operations returned ${res.status}`);
  const body = (await res.json()) as { _embedded: { records: HorizonPaymentOperation[] } };
  return body._embedded.records;
}

interface PayOption {
  asset: { code: string; issuer: string | null };
  sourceAmount: string;
  maxSourceAmount: string;
}

interface LinkView {
  link: { id: string; reference: string; status: string };
  request: { destination: string };
  pay?: { pathPayments: boolean; maxSlippageBps: number; maxPriceImpactBps?: number };
}

interface ReceiptView {
  reference: string;
  paidWith: { asset: { code: string; issuer: string | null }; amount: string }[] | null;
}

describe.skipIf(!LIVE_PATH)("Path payment end-to-end (live)", () => {
  const buyer = keypairFromEnv("PATH_PAYMENT_PROBE_BUYER_SECRET") ?? Keypair.random();
  const sellerKey = keypairFromEnv("PATH_PAYMENT_PROBE_SELLER_SECRET") ?? Keypair.random();

  let container: TestContainer;
  let app: Hono;
  let token = "";
  let loop: WatcherLoop;
  let linkId = "";
  let reference = "";
  let linkDestination = "";
  let payOption: PayOption | undefined;
  let maxPriceImpactBps = DEFAULT_MAX_PRICE_IMPACT_BPS;
  let sendMax = "";
  let signedXdr = "";
  let payTxHash = "";
  let spentXlm = "";
  let lastCompleted: PathStage | null = null;

  /** Skip (not fail) a stage whose predecessor did not complete; record the ones that do. */
  const after = (previous: PathStage | null, skip: () => void) => {
    if (lastCompleted !== previous) skip();
  };
  const done = (stage: PathStage, timings: Record<string, unknown> = {}) => {
    lastCompleted = stage;
    mergeProbeTelemetry({ pathLastStage: stage, ...timings }, "path-payment-probe-telemetry.json");
  };

  const api = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });

  /**
   * Assert a response status, including the body in the failure message.
   * Reads the body only on mismatch: `expect(res.status, await res.text())`
   * would drain the stream before the caller can read the JSON.
   */
  async function expectStatus(res: Response, status: number): Promise<void> {
    if (res.status !== status) {
      throw new Error(`expected HTTP ${status}, got ${res.status}: ${await res.text()}`);
    }
  }

  beforeAll(() => {
    mergeProbeTelemetry(
      {
        pathLastStage: null,
        pathFailedStage: null,
        pathPayTxHash: null,
        pathPayOptionsMs: null,
        pathPlanMs: null,
        pathPriceImpactBps: null,
        pathSourceAmount: null,
        pathSendMax: null,
      },
      "path-payment-probe-telemetry.json",
    );
  });

  afterAll(() => {
    loop?.stop();
    mergeProbeTelemetry({ pathFailedStage: failedPathStage(lastCompleted) }, "path-payment-probe-telemetry.json");
  });

  it("stage 1/6 prepare: buyer funds itself XLM and the seller holds a testnet USDC trustline", async (t) => {
    const skip = (message: string): never => {
      t.skip(message);
      throw new Error(`unreachable after t.skip(): ${message}`);
    };

    // The seller receives the link asset, so it needs the trustline (and the
    // XLM for the reserve). `ensureProbeAccount` creates the account through
    // Friendbot and adds the trustline; 0 USDC is required to hold it.
    await ensureProbeAccount({ keypair: sellerKey, minUsdc: 0 });

    const buyerAccount = await ensureXlmAccount(buyer).catch((err: unknown) => {
      if (!(err instanceof ProbeFundingError)) throw err;
      return skip(`the buyer probe account could not be funded (${err.message}) — Friendbot may be rate limiting`);
    });
    // The buyer spends XLM and receives nothing into its own account, so a
    // trustline is not needed on this side.
    const xlm = xlmBalance(buyerAccount);
    expect(xlm).toBeGreaterThan(XLM_HEADROOM);
    done("prepare", { pathBuyerXlm: xlm });
  }, PREPARE_TIMEOUT_MS);

  it("stage 2/6 boot: the API runs in-process and a 10 USDC link exists for the seller probe wallet", async (t) => {
    after("prepare", () => t.skip());
    container = await createTestContainer();
    const seller = await container.sellers.createIfAbsent(sellerKey.publicKey());
    token = await container.tokenFor(seller.id, seller.wallet);

    app = new Hono();
    // The real routes, mounted the way src/index.ts mounts them, with a
    // pass-through strict limiter (rate limits are not what this probe tests).
    app.route("/links", linkRoutes(container, async (_c, next) => next()));
    // The public receipt is what the buyer sees after paying.
    app.route("/r", publicRoutes(container));

    // The real polling watcher over Horizon testnet, driven by hand: the test
    // process runs no server, so nothing ticks the loop for it.
    const watcher = new HorizonWatcher({ primaryServer: HORIZON_TESTNET });
    loop = new WatcherLoop({
      watcher,
      links: container.links,
      state: container.state,
      service: container.service,
      pollMs: POLL_INTERVAL_MS,
    });

    const res = await api("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Path payment probe link", amount: LINK_AMOUNT, assetCode: "USDC" }),
    });
    await expectStatus(res, 201);
    const body = (await res.json()) as { link: { id: string; reference: string; destination: string } };
    linkId = body.link.id;
    reference = body.link.reference;
    linkDestination = body.link.destination;
    expect(linkDestination).toBe(sellerKey.publicKey());

    // The watcher seeds a destination's cursor to "now" on its first tick and
    // deliberately never replays history, so a payment that landed before that
    // tick stays invisible forever. A deployed API has been ticking since it
    // booted; this probe has not, so it seeds now - before the buyer pays -
    // exactly as that first tick would have.
    await container.state.setCursor(linkDestination, (await watcher.latestCursor(linkDestination)) ?? "");

    // The checkout only offers other assets when the deployment enables them;
    // without the flag this probe has nothing to quote.
    const view = (await (await app.request(`/links/${linkId}`)).json()) as LinkView;
    if (view.pay?.pathPayments !== true) {
      throw new Error(
        "PATH_PAYMENTS_ENABLED is not true in this process, so GET /links/:id/pay-options would answer " +
          "`{ options: [] }` without asking Horizon. Run the probe with PATH_PAYMENTS_ENABLED=true.",
      );
    }
    maxPriceImpactBps = view.pay.maxPriceImpactBps ?? DEFAULT_MAX_PRICE_IMPACT_BPS;
    expect(view.pay.maxSlippageBps).toBeGreaterThan(0);

    // `createTestContainer` is a minimal container and wires no pay-options port
    // (the route reads a missing port as "link asset only"), so this probe wires
    // the real quoter itself — exactly what `createContainer()` does when
    // PATH_PAYMENTS_ENABLED is on, with the slippage the API just advertised.
    container.payOptions = createPayOptionsQuoter({
      client: realHorizonClient(HORIZON_TESTNET),
      maxSlippageBps: view.pay.maxSlippageBps,
      onError: (err, id) => console.warn({ event: "pay_options.quote_failed", linkId: id, err }),
    });
    done("boot", { pathLinkId: linkId, pathMaxPriceImpactBps: maxPriceImpactBps });
  }, BOOT_TIMEOUT_MS);

  it("stage 3/6 options: the API quotes the 10 USDC link in XLM for this buyer", async (t) => {
    after("boot", () => t.skip());
    const startedAt = Date.now();
    const res = await app.request(`/links/${linkId}/pay-options?account=${buyer.publicKey()}`);
    await expectStatus(res, 200);
    const body = (await res.json()) as { options: PayOption[]; expiresAt?: number };
    const optionsMs = Date.now() - startedAt;

    if (body.options.length === 0) {
      throw new Error(
        "GET /links/:id/pay-options returned no options with PATH_PAYMENTS_ENABLED=true. Either Horizon " +
          "testnet has no path from a spendable asset to USDC right now, or /paths/strict-receive failed. " +
          "The payer's own asset is never in the list, so an empty list is never 'already the link asset'.",
      );
    }
    // XLM is the asset Friendbot hands out, so it is the one this probe can fund.
    payOption = body.options.find((o) => o.asset.code === "XLM" && o.asset.issuer === null);
    if (!payOption) {
      throw new Error(
        `pay-options offered no XLM quote; the buyer cannot be funded for ${body.options
          .map((o) => o.asset.code)
          .join(", ")}`,
      );
    }
    expect(Number(payOption.sourceAmount)).toBeGreaterThan(0);
    // The slippage cap is applied server-side: the max is above the estimate.
    expect(Number(payOption.maxSourceAmount)).toBeGreaterThan(Number(payOption.sourceAmount));
    done("options", {
      pathPayOptionsMs: optionsMs,
      pathPriceImpactCapBps: maxPriceImpactBps,
      pathSourceAmount: payOption.sourceAmount,
      pathMaxSourceAmount: payOption.maxSourceAmount,
    });
  }, OPTIONS_TIMEOUT_MS);

  it("stage 4/6 build: the checkout re-quotes and builds a pathPaymentStrictReceive capped at the accepted max", async (t) => {
    after("options", () => t.skip());
    const option = payOption!;

    // Re-quoting happens at build time in the real checkout (5.48); the probe
    // uses that same builder so a regression there fails here, live.
    const startedAt = Date.now();
    const plan = await planPathPayment({
      client: realHorizonClient(HORIZON_TESTNET),
      buyer: buyer.publicKey(),
      destAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      destAmount: LINK_AMOUNT,
      option: { asset: option.asset, maxSourceAmount: option.maxSourceAmount },
      maxPriceImpactBps,
    });
    const planMs = Date.now() - startedAt;

    expect(plan.sourceAsset).toEqual({ code: "XLM", issuer: null });
    expect(plan.priceImpactBps).toBeLessThanOrEqual(maxPriceImpactBps);
    // The buyer accepted this cap; the fresh quote may not exceed it.
    expect(plan.maxSourceAmount).toBe(option.maxSourceAmount);
    expect(Number(plan.sourceAmount)).toBeLessThanOrEqual(Number(plan.maxSourceAmount));

    const buyerAccount = await loadAccount(HORIZON_TESTNET, buyer.publicKey());
    if (!buyerAccount) throw new Error("buyer probe account disappeared from Horizon testnet");
    expect(xlmBalance(buyerAccount)).toBeGreaterThan(Number(plan.sourceAmount) + XLM_HEADROOM);

    signedXdr = await buildPathPaymentXdr({
      address: buyer.publicKey(),
      sequence: buyerAccount.sequence,
      destination: linkDestination,
      destAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      destAmount: LINK_AMOUNT,
      networkPassphrase: Networks.TESTNET,
      memo: reference,
      feeStroops: BigInt(BASE_FEE),
      plan,
    });

    const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(buyer.publicKey());
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as Operation.PathPaymentStrictReceive;
    expect(op.type).toBe("pathPaymentStrictReceive");
    expect(op.sendAsset.isNative()).toBe(true);
    // sendMax is the buyer's accepted cap, never the fresh quote.
    expect(op.sendMax).toBe(plan.maxSourceAmount);
    expect(Number(op.destAmount)).toBe(Number(LINK_AMOUNT));
    expect(op.destAsset.getCode()).toBe("USDC");
    expect(op.destAsset.getIssuer()).toBe(USDC_TESTNET_ISSUER);
    expect(op.destination).toBe(linkDestination);
    expect(op.path.map((hop) => hop.getCode())).toEqual(plan.path.map((hop) => hop.code));
    expect(tx.memo.type).toBe("text");
    expect(tx.memo.value?.toString()).toBe(reference);

    sendMax = plan.maxSourceAmount;
    done("build", {
      pathPlanMs: planMs,
      pathPriceImpactBps: plan.priceImpactBps,
      pathSourceAmount: plan.sourceAmount,
      pathSendMax: sendMax,
    });
  }, BUILD_TIMEOUT_MS);

  it("stage 5/6 pay: the buyer-signed path payment lands on the ledger and the watcher marks the link paid", async (t) => {
    after("build", () => t.skip());

    // The buyer's wallet signs in the test process, standing in for the
    // browser's signTransaction — the server never holds the key.
    const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    tx.sign(buyer);
    const submittedAt = Date.now();
    const res = await app.request(`/links/${linkId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedXdr: tx.toXDR() }),
    });
    await expectStatus(res, 200);
    payTxHash = ((await res.json()) as { txHash: string }).txHash;
    expect(payTxHash).toMatch(/^[0-9a-f]{64}$/);

    // The watcher owns the paid transition: tick it until the ledger payment
    // is matched to the link. It settles on the *delivered* side, which is what
    // makes a path payment indistinguishable from a plain one here.
    const { value: link } = await pollUntil(
      "the link to become paid",
      async () => {
        await loop.runOnce();
        const got = await app.request(`/links/${linkId}`);
        return ((await got.json()) as { link: { status: string } }).link;
      },
      (l) => l.status === "paid",
      { timeoutMs: PAY_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    );
    expect(link.status).toBe("paid");
    const paidAfterMs = Date.now() - submittedAt;

    // The ledger must show the operation the checkout built: source XLM,
    // delivered USDC, never more than the sendMax the buyer accepted.
    const found = await pollUntil(
      "the payment transaction to appear on Horizon testnet",
      async () => horizonTransaction(payTxHash),
      (foundTx) => foundTx.successful,
      { timeoutMs: PAY_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    );
    expect(found.value.memo_type).toBe("text");
    expect(found.value.memo).toBe(reference);

    const ops = await transactionOperations(payTxHash);
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.type).toBe("path_payment_strict_receive");
    expect(op.from).toBe(buyer.publicKey());
    expect(op.to).toBe(linkDestination);
    expect(op.asset_code).toBe("USDC");
    expect(op.asset_issuer).toBe(USDC_TESTNET_ISSUER);
    expect(Number(op.amount)).toBe(Number(LINK_AMOUNT));
    expect(op.source_asset_type).toBe("native");
    expect(op.source_amount).toBeTruthy();
    spentXlm = op.source_amount!;
    // Horizon's `source_amount` is what was really sent, at or below sendMax.
    expect(Number(spentXlm)).toBeLessThanOrEqual(Number(sendMax));

    done("pay", { pathPayTxHash: payTxHash, pathPaidAfterMs: paidAfterMs, pathSpentXlm: spentXlm });
  }, PAY_TIMEOUT_MS + 120_000);

  it("stage 6/6 receipt: the receipt and the seller's CSV export say the buyer paid in XLM", async (t) => {
    after("pay", () => t.skip());

    const res = await app.request(`/r/${reference}`);
    await expectStatus(res, 200);
    const receipt = (await res.json()) as ReceiptView;
    expect(receipt.reference).toBe(reference);
    expect(receipt.paidWith).not.toBeNull();
    const paidWith = receipt.paidWith ?? [];
    expect(paidWith).toHaveLength(1);
    // What the buyer spent, in the asset they chose — not the link's USDC.
    expect(paidWith[0]!.asset).toEqual({ code: "XLM", issuer: null });
    expect(Number(paidWith[0]!.amount)).toBeCloseTo(Number(spentXlm), 6);

    const csvRes = await api("/links/export/csv");
    await expectStatus(csvRes, 200);
    const csv = await csvRes.text();
    const row = csv.split("\n").find((line) => line.includes(reference));
    expect(row, `no CSV row for ${reference}`).toBeTruthy();
    // The last column is `paid_with`: "<amount> XLM" (issue 4.66).
    expect(row!.split(",").pop()).toContain("XLM");

    done("receipt");
  }, RECEIPT_TIMEOUT_MS);
});
