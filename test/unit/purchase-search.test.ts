import { describe, expect, it } from "vitest";
import { findPurchases, MAX_MATCHES } from "../../src/data/purchase-search";
import type { Receipt, Transaction } from "../../src/data/transaction-schema";

function txn(id: string, overrides: Partial<Transaction> & { on?: string } = {}): Transaction {
  const { on = "2026-11-01", ...fields } = overrides;
  return {
    id,
    date: on,
    merchant: "Coles",
    category: "groceries",
    item: "cake",
    amountCents: 1000,
    currency: "AUD",
    version: 1,
    createdAt: `${on}T00:00:00.000Z`,
    updatedAt: `${on}T00:00:00.000Z`,
    ...fields,
  };
}

function scanned(id: string, lines: [string, string | null, number][], receipt: Partial<Receipt> = {}): Transaction {
  const built = lines.map(([name, product, amountCents]) => ({ name, amountCents, ...(product ? { product } : {}) }));
  return txn(id, { item: `${lines.length} items`, receipt: { totalCents: 1000, lines: built, ...receipt } });
}

const COLES = scanned("coles", [
  ["BANANAS PERKG", "bananas", 284],
  ["CLS CHKN DRUMSTICKS 2KG", "chicken drumsticks", 770],
  ["BANDANA", "headscarf", 500],
]);

describe("matching", () => {
  it.each([
    ["the start of a word", "banana", ["BANANAS PERKG"]],
    ["any case", "BANANA", ["BANANAS PERKG"]],
    ["the plain product name", "chicken", ["CLS CHKN DRUMSTICKS 2KG"]],
    ["the printed name", "chkn", ["CLS CHKN DRUMSTICKS 2KG"]],
    ["a later word", "drumsticks", ["CLS CHKN DRUMSTICKS 2KG"]],
    ["not the middle of a word", "ana", []],
    ["several words", "bananas perkg", ["BANANAS PERKG"]],
    ["nothing bought", "kiwi", []],
  ])("finds the lines it should: %s", async (_, term, names) => {
    const found = await findPurchases([COLES], [term]);

    expect(found.matches.map((match) => match.name)).toEqual(names);
  });

  it("matches a Chinese term anywhere", async () => {
    expect((await findPurchases([scanned("tan-hung", [["新鲜香蕉", null, 392]])], ["香蕉"])).count).toBe(1);
  });

  it("finds a line once, though several terms match it", async () => {
    const found = await findPurchases([scanned("two", [["BANANAS", "bananas 香蕉", 392]])], ["banana", "香蕉"]);

    expect([found.count, found.totalCents]).toEqual([1, 392]);
  });

  it("takes punctuation in a term as plain text", async () => {
    const receipt = scanned("odd", [["SPRING ONION (B&R) 2/3.5", null, 350]]);

    expect((await findPurchases([receipt], ["(b&r)"])).count).toBe(1);
  });
});

describe("given an expense typed into the chat", () => {
  it("searches its item", async () => {
    const found = await findPurchases([txn("typed", { item: "bananas", amountCents: 300 })], ["banana"]);

    expect(found.matches).toEqual([
      { transactionId: "typed", date: "2026-11-01", merchant: "Coles", name: "bananas", product: null, amountCents: 300 },
    ]);
  });

  it("has no merchant when none was given", async () => {
    const found = await findPurchases([txn("typed", { item: "bananas", merchant: undefined })], ["banana"]);

    expect(found.matches[0]?.merchant).toBeNull();
  });
});

describe("given a scanned receipt", () => {
  it("returns the plain product with the printed name", async () => {
    const [match] = (await findPurchases([COLES], ["chicken"])).matches;

    expect([match?.name, match?.product]).toEqual(["CLS CHKN DRUMSTICKS 2KG", "chicken drumsticks"]);
  });

  it("returns no product for a line that has none", async () => {
    expect((await findPurchases([scanned("misc", [["MISC ITEM", null, 499]])], ["misc"])).matches[0]?.product).toBeNull();
  });

  it("counts a one-line receipt once, though its item names the line", async () => {
    const lines = [{ name: "B.BARRAMUNDI", product: "barramundi", amountCents: 1774 }];
    const oneLine = txn("one", { item: "barramundi", receipt: { totalCents: 1774, lines } });

    expect((await findPurchases([oneLine], ["barramundi"])).count).toBe(1);
  });

  it("doesn't search its item of 18 items", async () => {
    expect((await findPurchases([COLES], ["items"])).count).toBe(0);
  });

  it("takes a discount line off the total", async () => {
    const receipt = scanned("deal", [
      ["BANANAS", null, 400],
      ["BANANA DISCOUNT", null, -100],
    ]);

    expect((await findPurchases([receipt], ["banana"])).totalCents).toBe(300);
  });
});

describe("totals", () => {
  it("adds up every match across transactions", async () => {
    const found = await findPurchases([COLES, txn("typed", { item: "bananas", amountCents: 300 })], ["banana"]);

    expect([found.count, found.totalCents, found.currency]).toEqual([2, 584, "AUD"]);
  });

  it("keeps the order it was given, which is newest first", async () => {
    const found = await findPurchases(
      [txn("new", { on: "2026-11-02", item: "bananas" }), txn("old", { on: "2026-11-01", item: "bananas" })],
      ["banana"],
    );

    expect(found.matches.map((match) => match.transactionId)).toEqual(["new", "old"]);
  });

  it("finds nothing with no transactions", async () => {
    expect(await findPurchases([], ["banana"])).toEqual({
      matches: [],
      count: 0,
      totalCents: 0,
      currency: "AUD",
      includesPoints: false,
    });
  });

  it("returns only so many lines, but counts them all", async () => {
    const many = Array.from({ length: MAX_MATCHES + 5 }, (_, i) => txn(String(i), { item: "bananas", amountCents: 100 }));

    const found = await findPurchases(many, ["banana"]);

    expect(found.matches).toHaveLength(MAX_MATCHES);
    expect([found.count, found.totalCents]).toEqual([MAX_MATCHES + 5, (MAX_MATCHES + 5) * 100]);
  });
});

describe("points", () => {
  const points: Partial<Receipt> = {
    payments: [
      { label: "Flybuys value redeemed", kind: "points", amountCents: 900 },
      { label: "EFT", kind: "money", amountCents: 100 },
    ],
  };

  it("says when a match was paid partly with points", async () => {
    const receipt = scanned("points", [["BANANAS", null, 284]], points);

    expect((await findPurchases([receipt], ["banana"])).includesPoints).toBe(true);
  });

  it("doesn't count points on a receipt that didn't match", async () => {
    const receipt = scanned("points", [["BREAD", null, 284]], points);

    expect((await findPurchases([receipt], ["banana"])).includesPoints).toBe(false);
  });
});
