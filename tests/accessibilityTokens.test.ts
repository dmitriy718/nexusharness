import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function token(name: string) {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  if (!value) throw new Error(`Missing hexadecimal --${name} token.`);
  return value;
}

function luminance(hex: string) {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("accessible semantic colors", () => {
  it("keeps every small-text semantic token above 4.5:1 on the lightest surface", () => {
    const background = token("surface-hover");
    for (const name of ["text", "text-soft", "muted", "faint", "violet", "violet-bright", "cyan", "blue", "green", "amber", "red", "focus"]) {
      expect(contrast(token(name), background), `--${name} against --surface-hover`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
