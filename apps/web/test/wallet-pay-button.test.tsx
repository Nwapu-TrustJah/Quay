// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  getWalletNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({ getLink: vi.fn(), submitPayment: vi.fn(), getPayOptions: vi.fn() }));
const sdk = vi.hoisted(() => ({ loadAccount: vi.fn(), memos: [] as string[] }));

vi.mock("../lib/wallet", () => ({
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  connectWallet: wallet.connectWallet,
  getWalletNetwork: wallet.getWalletNetwork,
  signTransaction: wallet.signTransaction,
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: apiMock };
});

// Only the late path (after the link is confirmed payable) reaches the SDK.
vi.mock("@stellar/stellar-sdk", () => {
  class Builder {
    addOperation() {
      return this;
    }
    addMemo(memo: string) {
      sdk.memos.push(memo);
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { toXDR: () => "UNSIGNED_XDR" };
    }
  }
  return {
    Horizon: { Server: class { loadAccount = sdk.loadAccount; } },
    Account: class {},
    Asset: Object.assign(class {}, { native: () => ({}) }),
    Memo: { text: (m: string) => m },
    Operation: { payment: (o: unknown) => o },
    TransactionBuilder: Builder,
  };
});

import WalletPayButton, { type PaymentBuildContext } from "../app/components/WalletPayButton";
import { countdownMilestone } from "../app/components/PayWithChoice";
import { CheckoutError, type LinkWithRequest, type PayOption } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PASSPHRASE = "Test SDF Network ; September 2015";

function link(over: Partial<LinkWithRequest["link"]> = {}): LinkWithRequest {
  return {
    link: { id: "lnk_1", status: "active", amount: "10", paidAmount: null, ...over },
    request: {
      uri: "web+stellar:pay?x",
      destination: "GSELLER",
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      memo: "ref_1",
    },
  } as unknown as LinkWithRequest;
}

/** A quoted path-payment option: 10 USDC is worth about 24.12 XLM to this buyer. */
const XLM_OPTION: PayOption = {
  asset: { code: "XLM", issuer: null },
  sourceAmount: "24.12",
  maxSourceAmount: "24.36",
};

/** The same link, but with the pay-in-any-asset flag on. */
function pathLink(over: Partial<LinkWithRequest["link"]> = {}): LinkWithRequest {
  return { ...link(over), pay: { pathPayments: true, maxSlippageBps: 100 } };
}

const fundedAccount = {
  sequence: "100",
  balances: [
    { asset_type: "native", balance: "50.0000000" },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "100.0000000" },
  ],
};

describe("WalletPayButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSubmitted = vi.fn();

  async function mount(
    initial: LinkWithRequest = link(),
    props: { buildTransaction?: (context: PaymentBuildContext) => Promise<string> } = {},
  ) {
    await act(async () =>
      root.render(<WalletPayButton initial={initial} onSubmitted={onSubmitted} {...props} />),
    );
  }
  async function pay() {
    const button = container.querySelector("button")!;
    await act(async () => {
      button.click();
    });
  }
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk.memos.length = 0;
    wallet.connectWallet.mockResolvedValue("GBUYER");
    wallet.getWalletNetwork.mockResolvedValue({ network: "TESTNET", networkPassphrase: PASSPHRASE });
    wallet.signTransaction.mockResolvedValue("SIGNED_XDR");
    vi.useRealTimers();
    apiMock.getLink.mockResolvedValue(link());
    apiMock.submitPayment.mockResolvedValue({ txHash: "tx_abc" });
    apiMock.getPayOptions.mockResolvedValue([]);
    sdk.loadAccount.mockResolvedValue(fundedAccount);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("renders the cancelled copy when the wallet is dismissed at connect", async () => {
    wallet.connectWallet.mockResolvedValue(null);
    await mount();
    await pay();
    expect(alertText()).toBe("The wallet request was cancelled.");
    expect(apiMock.getLink).not.toHaveBeenCalled();
  });

  it("refuses a wallet on the wrong network before touching the API", async () => {
    wallet.getWalletNetwork.mockResolvedValue({ network: "PUBLIC", networkPassphrase: "Public Global Stellar Network ; September 2015" });
    await mount();
    await pay();
    expect(alertText()).toContain("wrong Stellar network");
    expect(apiMock.getLink).not.toHaveBeenCalled();
  });

  it("carries on when the wallet cannot report its network", async () => {
    wallet.getWalletNetwork.mockRejectedValue(new Error("unsupported"));
    await mount();
    await pay();
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
  });

  it.each(["paid", "cancelled", "expired"] as const)("shows the unavailable copy when the link is %s", async (status) => {
    apiMock.getLink.mockResolvedValue(link({ status }));
    await mount();
    await pay();
    expect(alertText()).toContain("could not be prepared");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("maps a CheckoutError from the API through apiErrorCode", async () => {
    const cases: Array<[ConstructorParameters<typeof CheckoutError>[0], string]> = [
      ["insufficient_balance", "does not have enough balance"],
      ["missing_trustline", "needs a trustline"],
      ["price_moved", "The price changed while you were signing. Get a new price and try again."],
      ["no_path", "not enough market depth to pay this in the selected asset right now. Pay in USDC instead."],
      ["wrong_network", "wrong Stellar network"],
      ["wallet_rejected", "The wallet request was cancelled."],
      // Not specially handled, so it falls to the default copy.
      ["payment_rejected", "could not be prepared"],
      ["server_error", "could not be prepared"],
    ];
    for (const [code, copy] of cases) {
      apiMock.submitPayment.mockRejectedValueOnce(new CheckoutError(code, 409, "x"));
      await mount();
      await pay();
      expect(alertText(), code).toContain(copy);
    }
  });

  it("treats an unexpected thrown value as unavailable", async () => {
    apiMock.getLink.mockRejectedValue(new Error("network down"));
    await mount();
    await pay();
    expect(alertText()).toContain("could not be prepared");
  });

  it("reports a cancelled signature as user_rejected", async () => {
    wallet.signTransaction.mockRejectedValue(new Error("User declined"));
    await mount();
    await pay();
    expect(alertText()).toBe("The wallet request was cancelled.");
    expect(apiMock.submitPayment).not.toHaveBeenCalled();
  });

  it("reports an unfunded wallet as insufficient_balance", async () => {
    sdk.loadAccount.mockRejectedValue(new Error("404"));
    await mount();
    await pay();
    expect(alertText()).toContain("does not have enough balance");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("reports a wallet with no trustline as missing_trustline", async () => {
    sdk.loadAccount.mockResolvedValue({ sequence: "1", balances: [{ asset_type: "native", balance: "50.0000000" }] });
    await mount();
    await pay();
    expect(alertText()).toContain("needs a trustline");
  });

  it("reports a balance below the amount as insufficient_balance", async () => {
    sdk.loadAccount.mockResolvedValue({
      sequence: "1",
      balances: [
        { asset_type: "native", balance: "50.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "1.0000000" },
      ],
    });
    await mount();
    await pay();
    expect(alertText()).toContain("does not have enough balance");
  });

  it("only owes the outstanding amount on an underpaid link, and refuses a fully paid one", async () => {
    apiMock.getLink.mockResolvedValue(link({ status: "underpaid", paidAmount: "10" }));
    await mount();
    await pay();
    expect(alertText()).toContain("could not be prepared");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("on success signs, submits the signed XDR and reports the hash with no error shown", async () => {
    await mount();
    await pay();

    expect(wallet.signTransaction).toHaveBeenCalledWith("UNSIGNED_XDR", "GBUYER");
    expect(apiMock.submitPayment).toHaveBeenCalledWith("lnk_1", "SIGNED_XDR");
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    expect(alertText()).toBeNull();
    expect(sdk.memos).toEqual(["ref_1"]);
  });

  it("clears a previous error when the buyer tries again", async () => {
    wallet.connectWallet.mockResolvedValueOnce(null);
    await mount();
    await pay();
    expect(alertText()).not.toBeNull();

    await pay();
    expect(alertText()).toBeNull();
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
  });

  it("is disabled when told to be", async () => {
    await act(async () => root.render(<WalletPayButton initial={link()} disabled onSubmitted={onSubmitted} />));
    expect(container.querySelector("button")!.disabled).toBe(true);
  });

  // ── Pay-with choice (issue 5.47) ─────────────────────────────────────────

  describe("pay-with choice", () => {
    const choiceGroup = () => container.querySelector("fieldset.pay-choice");
    const radios = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[name="payAsset"]'));
    const liveRegion = () => container.querySelector('.pay-choice [aria-live="polite"]');
    const payButtonText = () => container.querySelector("button")?.textContent;

    it.each([
      ["missing", undefined],
      ["false", { pathPayments: false, maxSlippageBps: 100 }],
    ])("keeps the existing payment when pay.pathPayments is %s", async (_label, payFlag) => {
      apiMock.getPayOptions.mockResolvedValue([XLM_OPTION]);
      await mount({ ...link(), pay: payFlag as unknown as LinkWithRequest["pay"] });
      await pay();

      expect(choiceGroup()).toBeNull();
      expect(apiMock.getPayOptions).not.toHaveBeenCalled();
      expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    });

    it("keeps the existing payment when the API quotes no other asset", async () => {
      apiMock.getPayOptions.mockResolvedValue([]);
      await mount(pathLink());
      await pay();

      expect(apiMock.getPayOptions).toHaveBeenCalledWith("lnk_1", "GBUYER");
      expect(choiceGroup()).toBeNull();
      expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    });

    it("lists the link asset first, then each quoted asset, and pays with the chosen one", async () => {
      apiMock.getPayOptions.mockResolvedValue([XLM_OPTION]);
      const build = vi.fn().mockResolvedValue("UNSIGNED_XDR");
      await mount(pathLink(), { buildTransaction: build });
      await pay();

      const group = choiceGroup() as HTMLElement;
      expect(group.querySelector("legend")?.textContent).toBe("Pay with");
      expect(radios().map((radio) => radio.closest("label")!.textContent)).toEqual([
        "10 USDC",
        "about 24.12 XLM, at most 24.36 XLM",
      ]);
      // One radio group: the shared name is what gives arrow-key navigation.
      expect(radios().map((radio) => radio.name)).toEqual(["payAsset", "payAsset"]);
      expect(radios()[0]!.checked).toBe(true);
      expect(group.textContent).toContain("The QR code above always pays in USDC.");
      expect(liveRegion()).toBeTruthy();
      // Nothing is built or signed until the buyer confirms the choice.
      expect(build).not.toHaveBeenCalled();
      expect(payButtonText()).toBe("Pay with USDC");

      await act(async () => radios()[1]!.click());
      expect(payButtonText()).toBe("Pay with XLM");

      await pay();
      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "GBUYER",
          payOption: expect.objectContaining({ asset: { code: "XLM", issuer: null } }),
        }),
      );
      expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    });

    it("refuses a chosen foreign asset instead of quietly charging the link asset", async () => {
      // 5.48 owns the path payment. Until it lands the default builder must not
      // fall back to the link asset: the buyer picked XLM and must be told so.
      apiMock.getPayOptions.mockResolvedValue([XLM_OPTION]);
      await mount(pathLink());
      await pay();
      await act(async () => radios()[1]!.click());
      await pay();

      expect(alertText()).toContain("Paying in XLM isn't available yet");
      expect(alertText()).toContain("Choose USDC to pay now");
      expect(wallet.signTransaction).not.toHaveBeenCalled();
      expect(apiMock.submitPayment).not.toHaveBeenCalled();
      // The choice is still on screen and still selected.
      expect(radios()[1]!.checked).toBe(true);
    });

    it("keeps the chosen asset when the re-quote request fails, rather than reverting to the link asset", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      apiMock.getPayOptions
        .mockResolvedValueOnce([{ ...XLM_OPTION, expiresAt: Date.now() + 2_000 }])
        .mockRejectedValueOnce(new Error("quote service down"));
      await mount(pathLink());
      await pay();
      await act(async () => radios()[1]!.click());

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      await act(async () => {});
      await act(async () => {});

      expect(apiMock.getPayOptions).toHaveBeenCalledTimes(2);
      expect(radios()[1]!.checked).toBe(true);
      expect(radios()[0]!.checked).toBe(false);
      expect(payButtonText()).toBe("Pay with XLM");
    });

    it("counts the quote down and re-quotes when it expires, keeping the chosen asset", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      apiMock.getPayOptions
        .mockResolvedValueOnce([{ ...XLM_OPTION, expiresAt: Date.now() + 2_000 }])
        .mockResolvedValueOnce([
          { ...XLM_OPTION, sourceAmount: "24.20", maxSourceAmount: "24.44", expiresAt: Date.now() + 120_000 },
        ]);
      await mount(pathLink());
      await pay();
      await act(async () => radios()[1]!.click());

      expect(container.textContent).toContain("Quote valid for 0:02");
      // Two seconds left is inside the 10-second threshold, so the live region
      // says so once — the per-second tick itself is silent.
      expect(liveRegion()?.textContent).toContain("under 10 seconds");

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      await act(async () => {});
      await act(async () => {});

      expect(apiMock.getPayOptions).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("about 24.20 XLM, at most 24.44 XLM");
      expect(radios()[1]!.checked).toBe(true);
      expect(container.textContent).not.toContain("Quote expired");
    });

    it("only announces the countdown at thresholds, not every second", () => {
      expect(countdownMilestone(120_000)).toBeNull();
      expect(countdownMilestone(45_000)).toContain("under a minute");
      expect(countdownMilestone(20_000)).toContain("under 30 seconds");
      expect(countdownMilestone(5_000)).toContain("under 10 seconds");
      expect(countdownMilestone(0)).toContain("expired");
    });
  });
});
