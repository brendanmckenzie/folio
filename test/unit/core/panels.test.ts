import { describe, expect, it } from "vitest";
import { isPanelHref, screenPanel } from "../../../src/core/panels";

/**
 * `screenPanel` (`platform/admin-extensions.md` decision 21): the caps, the tone vocabulary,
 * the printable rule, the `href` rule and "malformed" when nothing survives.
 */

const item = (label: string, value: string, tone?: string) => ({
  label,
  value,
  ...(tone ? { tone } : {}),
});

describe("screenPanel", () => {
  it("passes a well-formed summary through", () => {
    expect(
      screenPanel({
        items: [item("Variants", "6"), item("From", "$28.50"), item("Editions left", "3", "warn")],
        note: "Back in stock Friday.",
        link: { label: "Open in Products", href: "/admin/products/prod_8812" },
      }),
    ).toEqual({
      items: [
        { label: "Variants", value: "6" },
        { label: "From", value: "$28.50" },
        { label: "Editions left", value: "3", tone: "warn" },
      ],
      note: "Back in stock Friday.",
      link: { label: "Open in Products", href: "/admin/products/prod_8812" },
    });
  });

  it("cuts a long value at 80 characters with an ellipsis and keeps the other items", () => {
    const got = screenPanel({
      items: [item("Notes", "n".repeat(300)), item("Variants", "6")],
      link: { label: "Bad", href: "javascript:alert(1)" },
    });
    expect([...got!.items[0]!.value]).toHaveLength(80);
    expect(got!.items[0]!.value.endsWith("…")).toBe(true);
    expect(got!.items[1]).toEqual({ label: "Variants", value: "6" });
    expect(got!.link).toBeUndefined();
  });

  it("cuts a label at 40, a note at 280 and a link label at 40", () => {
    const got = screenPanel({
      items: [item("L".repeat(80), "v")],
      note: "x".repeat(500),
      link: { label: "k".repeat(80), href: "/a" },
    });
    expect([...got!.items[0]!.label]).toHaveLength(40);
    expect([...got!.note!]).toHaveLength(280);
    expect([...got!.link!.label]).toHaveLength(40);
  });

  it("keeps at most eight items", () => {
    const got = screenPanel({ items: Array.from({ length: 12 }, (_, i) => item(`L${i}`, `${i}`)) });
    expect(got!.items).toHaveLength(8);
    expect(got!.items[7]!.label).toBe("L7");
  });

  it("drops an item that is not usable, never the card", () => {
    const got = screenPanel({
      items: [
        item("", "blank label"),
        item("blank value", "   "),
        item("ctrl", "a\u0000b"),
        { label: 3, value: "x" },
        null,
        "x",
        item("kept", "yes"),
      ],
    });
    expect(got!.items).toEqual([{ label: "kept", value: "yes" }]);
  });

  it("keeps a tone only when it is one of the four", () => {
    const got = screenPanel({
      items: ["neutral", "ok", "warn", "danger", "loud", 1].map((t) => ({
        label: "l",
        value: "v",
        tone: t,
      })),
    });
    expect(got!.items.map((i) => i.tone)).toEqual([
      "neutral",
      "ok",
      "warn",
      "danger",
      undefined,
      undefined,
    ]);
  });

  it("is a note-only card when it has no usable item but a note", () => {
    expect(screenPanel({ items: [item("", "")], note: "Nothing linked yet." })).toEqual({
      items: [],
      note: "Nothing linked yet.",
    });
  });

  it("answers null (malformed) when nothing survives and there is no note", () => {
    for (const raw of [
      null,
      undefined,
      "x",
      3,
      [],
      {},
      { items: [] },
      { items: "x" },
      { items: [item("", "")], note: "  " },
      { link: { label: "Only a link", href: "/a" } },
    ]) {
      expect(screenPanel(raw)).toBeNull();
    }
  });

  it("drops a link with no usable label, however good its href", () => {
    expect(
      screenPanel({ items: [item("a", "b")], link: { label: "", href: "/ok" } })!.link,
    ).toBeUndefined();
  });
});

describe("isPanelHref", () => {
  it.each([
    "/admin/products/prod_8812",
    "/admin/products?tab=variants#top",
    "https://shop.example/products/1",
    "/a%20b",
  ])("accepts %s", (href) => {
    expect(isPanelHref(href)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "http://shop.example/",
    "//evil.example/x",
    "/\\evil.example",
    "/\t/evil.example",
    "/%2F/evil.example",
    "/%5Cevil.example",
    "/%09/evil.example",
    "https://user:pass@shop.example/",
    "ftp://shop.example/",
    "admin/products",
    "",
    "/%E0%A4%A",
    `/${"a".repeat(2001)}`,
  ])("refuses %j", (href) => {
    expect(isPanelHref(href)).toBe(false);
  });

  it("refuses a non-string", () => {
    expect(isPanelHref(5)).toBe(false);
    expect(isPanelHref(null)).toBe(false);
  });
});
