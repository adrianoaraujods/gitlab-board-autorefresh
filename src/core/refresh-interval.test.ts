import { describe, expect, it } from "vitest";
import { normalizeIntervalSeconds, parseIntervalSeconds } from "./refresh-interval";

describe("parseIntervalSeconds", () => {
  it.each([
    ["30", 30],
    [" 45 ", 45],
    ["10", 10],
    ["3600", 3600],
  ])("accepts %j as %d seconds", (input, seconds) => {
    expect(parseIntervalSeconds(input)).toEqual({ ok: true, seconds });
  });

  it.each([
    ["empty", ""],
    ["below the minimum", "9"],
    ["zero", "0"],
    ["negative", "-30"],
    ["fractional", "12.5"],
    ["not a number", "thirty"],
  ])("rejects %s", (_name, input) => {
    expect(parseIntervalSeconds(input)).toMatchObject({ ok: false });
  });
});

describe("normalizeIntervalSeconds", () => {
  it.each([
    ["a valid stored value", 45, 45],
    ["a value below the minimum", 3, 10],
    ["a fractional value", 12.7, 12],
    ["a missing value", undefined, 30],
    ["a non-number", "60", 30],
    ["NaN", Number.NaN, 30],
  ])("turns %s into a usable interval", (_name, stored, expected) => {
    expect(normalizeIntervalSeconds(stored)).toBe(expected);
  });
});
