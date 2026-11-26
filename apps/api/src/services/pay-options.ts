import type { AssetRef, PaymentLink } from "@checkout/core";
import { fromStroops, toStroops } from "@checkout/core";
import {
  quoteStrictReceive,
  sendMaxFor,
  type HorizonClient,
  type PathQuote,
} from "@checkout/stellar";

/**
 * One foreign asset the buyer could pay with, priced for their own account
 * (issue 4.64). The link asset is NOT in this list — the checkout always offers
 * it first and separately, and Horizon drops it from the quotes anyway.
 *
 * `sourceAmount` is what the quote says they will send, `maxSourceAmount` is
 * that amount plus the deployment's slippage allowance (the `sendMax` a path
 * payment will carry in 5.48). Neither is recomputed in the UI.
 */
export interface PayOption {
  asset: AssetRef;
  sourceAmount: string;
  maxSourceAmount: string;
}

export interface PayOptions {
  options: PayOption[];
  /** Server epoch ms shared by every option. Absent when there are none. */
  expiresAt?: number;
}

/** Quotes are per buyer, so the account is part of the call. */
export type PayOptionsPort = (input: {
  link: PaymentLink;
  account: string;
}) => Promise<PayOptions>;

/**
 * How long one quote set is offered before the checkout re-asks.
 *
 * Deliberately longer than the panel's announcement thresholds (60s, 30s, 10s)
 * so a freshly opened panel does not immediately read "under a minute". The TTL
 * is not what protects the buyer: `maxSourceAmount` is. An aged quote can only
 * cost them up to that cap, and Horizon prices the path again when the payment
 * is actually built (5.48).
 */
export const PAY_OPTIONS_TTL_MS = 90_000;

export interface PayOptionsQuoterDeps {
  client: HorizonClient;
  /** Slippage applied to every `maxSourceAmount`, in basis points. */
  maxSlippageBps: number;
  now?: () => number;
  /** Called when Horizon fails, so the route can still answer "link asset only". */
  onError?: (err: unknown, linkId: string) => void;
}

/**
 * Builds the `GET /links/:id/pay-options` port (issue 4.64) on top of the
 * strict-receive quoting in `@checkout/stellar` (issue #545).
 *
 * One Horizon call per request: it already returns one cheapest quote per
 * source asset. Price impact is NOT measured here — a second slice quote just
 * to hide thin books cost the buyer an extra round trip on every checkout —
 * and is enforced in 5.48 when the payment transaction is built.
 *
 * Every failure mode that is not the caller's fault degrades to "no options":
 * the checkout then keeps today's one-asset payment instead of blocking it.
 * That includes a link that is no longer payable, a link whose expiry is in the
 * past, an empty order book, and Horizon being down.
 */
export function createPayOptionsQuoter(
  deps: PayOptionsQuoterDeps,
): PayOptionsPort {
  const now = deps.now ?? Date.now;

  return async ({ link, account }) => {
    if (link.status !== "active" && link.status !== "underpaid") {
      return { options: [] };
    }
    const destAmount = outstandingAmount(link);
    if (destAmount === null) return { options: [] };

    const quotedAt = now();
    // A quote that outlives the link would let the panel count down to a
    // deadline that is already gone, so the link's own expiry is the ceiling.
    const expiresAt =
      link.expiresAt === null
        ? quotedAt + PAY_OPTIONS_TTL_MS
        : Math.min(quotedAt + PAY_OPTIONS_TTL_MS, link.expiresAt);
    if (expiresAt <= quotedAt) return { options: [] };

    let quotes: PathQuote[];
    try {
      quotes = await quoteStrictReceive({
        client: deps.client,
        source: account,
        destAsset: link.asset,
        destAmount,
      });
    } catch (err) {
      deps.onError?.(err, link.id);
      return { options: [] };
    }

    const options: PayOption[] = [];
    for (const quote of quotes) {
      try {
        options.push({
          asset: quote.sourceAsset,
          sourceAmount: quote.sourceAmount,
          maxSourceAmount: sendMaxFor(quote.sourceAmount, deps.maxSlippageBps),
        });
      } catch {
        // A malformed Horizon amount must not take the other options with it.
        continue;
      }
    }
    if (options.length === 0) return { options: [] };

    return { options, expiresAt };
  };
}

/** What is still owed in the link asset — the same figure the builder pays. */
function outstandingAmount(link: PaymentLink): string | null {
  if (link.status !== "underpaid") return link.amount;
  const outstanding = toStroops(link.amount) - toStroops(link.paidAmount ?? "0");
  return outstanding > 0n ? fromStroops(outstanding) : null;
}
