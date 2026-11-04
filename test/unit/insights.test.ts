import { describe, expect, it } from "vitest";
import { addDays } from "../../src/data/dates";
import { findInsights, type Insight, insightId, merchantKey } from "../../src/data/insights";
import type { Transaction } from "../../src/data/transaction-schema";

const TODAY = "2026-11-01";

const daysAgo = (days: number) => addDays(TODAY, -days);

function txn(id: string, on: string, amountCents = 1000, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    date: on,
    merchant: "Coles",
    category: "groceries",
    item: "cake",
    amountCents,
    currency: "AUD",
    version: 1,
    createdAt: `${on}T00:00:00.000Z`,
    updatedAt: `${on}T00:00:00.000Z`,
    ...overrides,
  };
}

/** Charges 30 days apart, oldest amount first, the last of them 5 days ago. */
const monthly = (merchant: string, amounts: number[], overrides: Partial<Transaction> = {}) =>
  amounts.map((amount, i) => txn(`${merchant}-${i}`, daysAgo(5 + 30 * (amounts.length - 1 - i)), amount, { merchant, ...overrides }));

const subscription = (amounts: number[]) => monthly("Netflix", amounts, { category: "entertainment", item: "subscription" });

const insights = (transactions: Transaction[], dismissed: string[] = []) =>
  findInsights(transactions, TODAY, new Set(dismissed));

const types = (found: Insight[]) => found.map((insight) => insight.type);
const ids = (found: Insight) => found.transactions.map((t) => t.id);

const rego = (id: string, on: string, overrides: Partial<Transaction> = {}) =>
  txn(id, on, 89000, { merchant: "Service NSW", category: "transport", item: "car rego", ...overrides });

describe("merchantKey", () => {
  it.each([
    ["case", "Netflix", "netflix"],
    ["punctuation and spaces", "  NET-FLIX. ", "netflix"],
    ["a company suffix", "Netflix Pty Ltd", "netflix"],
    ["a domain suffix", "netflix.com", "netflix"],
    ["full-width letters", "Ｎｅｔｆｌｉｘ", "netflix"],
    ["Chinese, which is kept", "奈飞", "奈飞"],
  ])("gives the ways of writing one merchant a shared key: %s", (_, name, expected) => {
    expect(merchantKey(name)).toBe(expected);
  });
});

describe("insightId", () => {
  it("is 16 hex characters, and stable", () => {
    expect(insightId("rego_due|01A")).toBe(insightId("rego_due|01A"));
    expect(insightId("rego_due|奈飞")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("given no transactions", () => {
  it("finds nothing", () => {
    expect(insights([])).toEqual([]);
  });
});

describe("possible duplicates", () => {
  describe("given the same expense twice on one day", () => {
    it("shows one card with both transactions", () => {
      const [card, ...rest] = insights([txn("a", daysAgo(2)), txn("b", daysAgo(2))]);

      expect(card).toMatchObject({ type: "possible_duplicate", merchant: "Coles", amountCents: 1000, currency: "AUD" });
      expect(ids(card!)).toEqual(["a", "b"]);
      expect(rest).toEqual([]);
    });
  });

  it("shows a card for the same expense on adjacent days, since yesterday is easily misrecorded", () => {
    expect(types(insights([txn("a", daysAgo(3)), txn("b", daysAgo(2))]))).toEqual(["possible_duplicate"]);
  });

  it("shows one card with all of three copies", () => {
    const [card] = insights(["a", "b", "c"].map((id) => txn(id, daysAgo(2))));

    expect(card?.transactions).toHaveLength(3);
  });

  it("matches on the item when there's no merchant", () => {
    const [card] = insights(["a", "b"].map((id) => txn(id, daysAgo(1), 1000, { merchant: undefined })));

    expect(card).toMatchObject({ merchant: "cake" });
  });

  it.each([
    ["a different amount", txn("b", daysAgo(2), 1001)],
    ["a different merchant", txn("b", daysAgo(2), 1000, { merchant: "Woolworths" })],
    ["a different item", txn("b", daysAgo(2), 1000, { item: "bread" })],
    ["two days apart", txn("b", daysAgo(4))],
  ])("shows nothing for a near miss: %s", (_, other) => {
    expect(insights([txn("a", daysAgo(2)), other])).toEqual([]);
  });

  it("shows nothing for copies older than 30 days", () => {
    expect(insights([txn("a", daysAgo(31)), txn("b", daysAgo(31))])).toEqual([]);
  });

  describe("given a daily habit", () => {
    const habit = ["a", "b", "c"].map((id, i) => txn(id, daysAgo(i + 1)));

    it("doesn't take three dates in a row as a duplicate", () => {
      expect(insights(habit)).toEqual([]);
    });

    it("still shows a real repeat within the habit, alone", () => {
      const [card] = insights([...habit, txn("d", daysAgo(2))]);

      expect(ids(card!).sort()).toEqual(["b", "d"]);
    });
  });

  it("keeps a dismissed card away until another copy is recorded", () => {
    const pair = [txn("a", daysAgo(2)), txn("b", daysAgo(2))];
    const [card] = insights(pair);

    expect(insights(pair, [card!.id])).toEqual([]);
    expect(insights([...pair, txn("c", daysAgo(2))], [card!.id])).toHaveLength(1);
  });
});

describe("price rises", () => {
  describe("given a monthly subscription that went up", () => {
    it("shows the old and new price, and the yearly cost", () => {
      const [card] = insights(subscription([1699, 1699, 2099]));

      expect(card).toMatchObject({
        type: "price_rise",
        merchant: "Netflix",
        previousCents: 1699,
        currentCents: 2099,
        cadence: "monthly",
        extraPerYearCents: 4800,
        since: daysAgo(5),
      });
      expect(ids(card!)).toEqual(["Netflix-2", "Netflix-1", "Netflix-0"]);
    });
  });

  it("dates the rise from the first charge at the new price", () => {
    const [card] = insights(subscription([1699, 2099, 2099]));

    expect(card).toMatchObject({ since: daysAgo(35) });
  });

  it("needs only two charges of a yearly one", () => {
    const plan = { merchant: "Dropbox", category: "other", item: "plan" } as const;

    const [card] = insights([txn("a", daysAgo(370), 9900, plan), txn("b", daysAgo(5), 11900, plan)]);

    expect(card).toMatchObject({ cadence: "yearly", extraPerYearCents: 2000 });
  });

  it.each([
    ["only two monthly charges", subscription([1699, 2099])],
    ["an unchanged price", subscription([1699, 1699, 1699])],
    ["a price that fell", subscription([2099, 2099, 1699])],
    ["a varying bill with no repeat", subscription([3000, 4100, 5500])],
    ["groceries", monthly("Coles", [1699, 1699, 2099])],
    ["dining", monthly("Pasta Bar", [1699, 1699, 2099], { category: "dining" })],
  ])("isn't shown for %s", (_, charges) => {
    expect(insights(charges)).toEqual([]);
  });

  it("isn't shown once the subscription has stopped", () => {
    const charges = [9, 9, 12].map((amount, i) => txn(`n${i}`, daysAgo(46 + 30 * (2 - i)), amount, { category: "other" }));

    expect(insights(charges)).toEqual([]);
  });

  it("is ruled out by the timing of a weekly habit at the same merchant", () => {
    const shops = Array.from({ length: 8 }, (_, i) =>
      txn(String(i), daysAgo(5 + 7 * i), 1000 + i, { category: "other", item: `i${i}` }),
    );

    expect(insights(shops)).toEqual([]);
  });

  it("comes back after being dismissed only with a further rise", () => {
    const [card] = insights(subscription([1699, 1699, 2099]));

    expect(insights(subscription([1699, 1699, 2099]), [card!.id])).toEqual([]);
    expect(insights(subscription([1699, 1699, 2299]), [card!.id])).toHaveLength(1);
  });
});

describe("rego due", () => {
  describe("given a last payment nearly a year ago", () => {
    it("estimates the due date a year on", () => {
      const [card] = insights([rego("a", "2025-11-14")]);

      expect(card).toMatchObject({ type: "rego_due", estimatedDueDate: "2026-11-14", lastPaidCents: 89000, currency: "AUD" });
      expect(ids(card!)).toEqual(["a"]);
    });
  });

  it.each([
    ["30 days ahead", "2025-12-01", true],
    ["31 days ahead", "2025-12-02", false],
    ["30 days overdue", "2025-10-02", true],
    ["31 days overdue", "2025-10-01", false],
  ])("shows only within 30 days of the estimate: %s", (_, paid, shows) => {
    expect(insights([rego("a", paid)]).length > 0).toBe(shows);
  });

  it.each([
    ["in upper case", { item: "REGO renewal" }],
    ["in the merchant", { item: "registration", merchant: "car registration" }],
    ["in the note", { item: "fee", note: "vehicle registration" }],
    ["as CTP", { item: "CTP" }],
    ["as a green slip", { item: "green slip" }],
    ["in Chinese", { item: "车辆注册" }],
    ["beside Chinese", { item: "车辆rego费" }],
  ])("recognises the payment %s", (_, fields) => {
    expect(types(insights([rego("a", "2025-11-14", fields)]))).toEqual(["rego_due"]);
  });

  it.each([
    ["a word containing rego", "Gregory's birthday"],
    ["registration alone", "course registration"],
    ["Oregon", "Oregon trip"],
  ])("ignores a lookalike: %s", (_, item) => {
    expect(insights([rego("a", "2025-11-14", { item, merchant: "Shop" })])).toEqual([]);
  });

  it("estimates six months on from the latest of payments every six months", () => {
    const [card] = insights([rego("a", "2025-11-14"), rego("b", "2026-05-14")]);

    expect(card).toMatchObject({ estimatedDueDate: "2026-11-14" });
    expect(ids(card!)).toEqual(["b"]);
  });

  it("estimates three months on from the latest of payments every three months", () => {
    const [card] = insights([rego("a", "2026-05-14"), rego("b", "2026-08-14")]);

    expect(card).toMatchObject({ estimatedDueDate: "2026-11-14" });
  });

  it("clears once this year's payment is recorded", () => {
    expect(types(insights([rego("a", "2025-11-14"), rego("b", daysAgo(1))]))).not.toContain("rego_due");
  });

  it("lands a leap day payment's estimate on the last day of February", () => {
    const [card] = findInsights([rego("a", "2024-02-29")], "2025-02-20", new Set());

    expect(card).toMatchObject({ estimatedDueDate: "2025-02-28" });
  });

  it("keeps a dismissed card away until the next payment", () => {
    const last = rego("a", "2025-11-14");
    const [card] = insights([last]);

    expect(insights([last], [card!.id])).toEqual([]);
  });
});

describe("order", () => {
  it("puts rego first, then duplicates, then price rises", () => {
    const everything = [
      ...subscription([1699, 1699, 2099]),
      txn("a", daysAgo(2)),
      txn("b", daysAgo(2)),
      rego("c", "2025-11-14"),
    ];

    expect(types(insights(everything))).toEqual(["rego_due", "possible_duplicate", "price_rise"]);
  });
});
