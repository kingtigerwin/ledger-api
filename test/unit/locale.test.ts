import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage } from "../../src/auth/locale";

describe("localeFromAcceptLanguage", () => {
  describe("given a browser's Accept-Language", () => {
    it.each([
      ["zh-CN,zh;q=0.9,en;q=0.8", "zh-CN"],
      ["zh", "zh-CN"],
      ["zh-Hans-CN", "zh-CN"],
      ["zh-TW,zh;q=0.9", "zh-CN"],
      ["en-AU,en;q=0.9", "en"],
      ["EN-us", "en"],
      ["ja,zh-CN;q=0.8,en;q=0.5", "zh-CN"],
      ["en;q=0.5,zh-CN;q=0.9", "zh-CN"],
      ["fr-FR, de ; q=0.7, en ; q=0.3", "en"],
    ])("picks the first language Ledger has from %s", (header, locale) => {
      expect(localeFromAcceptLanguage(header)).toBe(locale);
    });

    it.each([undefined, "", "fr-FR,fr;q=0.9", "*", "zh;q=0"])("finds none in %s", (header) => {
      expect(localeFromAcceptLanguage(header)).toBeUndefined();
    });
  });
});
