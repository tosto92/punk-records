import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, fingerprint } from "../lib/fingerprint.js";
import { slugify } from "../lib/slug.js";

test("fingerprint is case/whitespace/punctuation insensitive", () => {
  assert.equal(
    fingerprint({ repo: "X", title: "Auth Bug!", symptoms: "  login  FAILS" }),
    fingerprint({ repo: "x", title: "auth bug", symptoms: "login fails" }),
  );
  assert.match(fingerprint({ repo: "x", title: "auth bug", symptoms: "login fails" }), /^[0-9a-f]{40}$/);
});

test("normalizeText lowercases, trims, collapses spaces, strips punctuation", () => {
  assert.equal(normalizeText("  Hello,   World! "), "hello world");
});

test("slugify truncates, dedups, and never returns empty", () => {
  assert.ok(slugify("Hello, World! ...", new Set()).startsWith("hello-world"));
  assert.match(slugify("!!!", new Set()), /^mem-[0-9a-f]{6}$/);
  assert.equal(slugify("Same", new Set(["same"])), "same-2");
  assert.equal(slugify("Same", new Set(["same", "same-2"])), "same-3");
  assert.ok(slugify("a".repeat(200), new Set()).length <= 60);
  const longBase = slugify("word ".repeat(30), new Set());
  assert.ok(longBase.length <= 60);
  const collided = slugify("word ".repeat(30), new Set([longBase]));
  assert.ok(collided.length <= 60);
  assert.ok(collided.endsWith("-2"));
  assert.notEqual(collided, longBase);
});
