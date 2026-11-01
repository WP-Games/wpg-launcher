import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTier, authorizeUrl } from "./subscribestar.mjs";

const CFG = {
  subscribestar: {
    byPriceCents: [
      { minCents: 100, level: 1, name: "Just Following" },
      { minCents: 500, level: 2, name: "Supporter" },
      { minCents: 1000, level: 3, name: "Premium Supporter" },
      { minCents: 2500, level: 4, name: "Ultimate Supporter" },
    ],
    overrides: { "77": { level: 4, name: "Creator" } },
  },
};

const data = (subscription, id = "1") => ({ subscriber: { id, name: "Sam Sub", avatar_url: "https://a/b.png", subscription } });

test("active £5 subscriber → Supporter", () => {
  const a = resolveTier(data({ price: 500, active: true, billing_failed: false, cancelled: false }), CFG);
  assert.equal(a.tier, 2);
  assert.equal(a.tierName, "Supporter");
  assert.equal(a.provider, "subscribestar");
  assert.equal(a.displayName, "Sam Sub");
});

test("price between tiers rounds down to the tier they paid for", () => {
  assert.equal(resolveTier(data({ price: 1200, active: true }), CFG).tier, 3);
  assert.equal(resolveTier(data({ price: 2500, active: true }), CFG).tier, 4);
});

test("billing failed → tier 0", () => {
  const a = resolveTier(data({ price: 2500, active: true, billing_failed: true }), CFG);
  assert.equal(a.tier, 0);
  assert.equal(a.patronStatus, "billing_failed");
});

test("cancelled → tier 0", () => {
  assert.equal(resolveTier(data({ price: 500, active: true, cancelled: true }), CFG).tier, 0);
});

test("no subscription → tier 0", () => {
  const a = resolveTier(data(null), CFG);
  assert.equal(a.tier, 0);
  assert.equal(a.tierName, "Not a subscriber");
});

test("non-subscriber still gets name/avatar from user", () => {
  const a = resolveTier({ user: { id: "9", name: "White Phantom", avatar_url: "https://a/p.png" }, subscriber: null }, CFG);
  assert.equal(a.tier, 0);
  assert.equal(a.displayName, "White Phantom");
  assert.equal(a.avatar, "https://a/p.png");
  assert.equal(a.userId, "9");
});

test("override by subscriber id", () => {
  const a = resolveTier(data(null, "77"), CFG);
  assert.equal(a.tier, 4);
  assert.equal(a.tierName, "Creator");
});

test("authorize url uses .art host and plus-joined scopes", () => {
  const url = authorizeUrl({ clientId: "cid", redirectUri: "https://api.whitephantomgames.co.uk/auth/subscribestar/callback", state: "n" });
  assert.ok(url.startsWith("https://subscribestar.art/oauth2/authorize?"));
  assert.ok(url.endsWith("&scope=subscriber.read+subscriber.payments.read+user.read"));
  const u = new URL(url);
  assert.equal(u.searchParams.get("redirect_uri"), "https://api.whitephantomgames.co.uk/auth/subscribestar/callback");
  assert.equal(u.searchParams.get("response_type"), "code");
});
