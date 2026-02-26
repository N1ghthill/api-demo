import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidCpf,
  isValidEmail,
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeUf,
  sanitizeString
} from "../lib/validators.js";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  USER@Example.COM  "), "user@example.com");
});

test("isValidEmail validates common formats", () => {
  assert.equal(isValidEmail("john.doe@example.com"), true);
  assert.equal(isValidEmail("invalid-email"), false);
  assert.equal(isValidEmail(""), false);
});

test("normalizePhone keeps only digits and enforces size", () => {
  assert.equal(normalizePhone("(31) 98888-7777"), "31988887777");
  assert.equal(normalizePhone("123"), null);
});

test("normalizeUf uppercases and validates two letters", () => {
  assert.equal(normalizeUf("mg"), "MG");
  assert.equal(normalizeUf("MGA"), null);
  assert.equal(normalizeUf("1A"), null);
});

test("normalizeCpf and isValidCpf validate check digits", () => {
  assert.equal(normalizeCpf("529.982.247-25"), "52998224725");
  assert.equal(isValidCpf("52998224725"), true);
  assert.equal(isValidCpf("11111111111"), false);
  assert.equal(isValidCpf("52998224724"), false);
});

test("sanitizeString trims and enforces max length", () => {
  assert.equal(sanitizeString("  abc  ", 10), "abc");
  assert.equal(sanitizeString("", 10), null);
  assert.equal(sanitizeString("abcdef", 3), "abc");
});
