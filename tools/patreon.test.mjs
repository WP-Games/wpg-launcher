// node --test tools/   (or: npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTier, authorizeUrl } from "./patreon.mjs";

const CFG = {
  patreon: {
    campaignId: "111",
    tiers: { "t-low": { level: 1, name: "Supporter" }, "t-high": { level: 2, name: "Phantom" } },
    byAmountCents: [{ minCents: 500, level: 1, name: "Supporter (by price)" }],
  },
};

// Shape of GET /api/oauth2/v2/identity?include=memberships,memberships.currently_entitled_tiers,memberships.campaign
function identity({ status = "active_patron", tiers = [], campaign = "111", cents = 0, charge = "Paid" } = {}) {
  return {
    data: { type: "user", id: "u1", attributes: { full_name: "Jane Patron", image_url: "https://img/x.png" } },
    included: [
      {
        type: "member", id: "m1",
        attributes: { patron_status: status, currently_entitled_amount_cents: cents, last_charge_status: charge },
        relationships: {
          campaign: { data: { type: "campaign", id: campaign } },
          currently_entitled_tiers: { data: tiers.map((id) => ({ type: "tier", id })) },
        },
      },
      ...tiers.map((id) => ({ type: "tier", id, attributes: { title: `Tier ${id}`, amount_cents: 500 } })),
    ],
  };
}

test("active patron on mapped tier", () => {
  const a = resolveTier(identity({ tiers: ["t-low"] }), CFG);
  assert.equal(a.tier, 1);
  assert.equal(a.tierName, "Supporter");
  assert.equal(a.displayName, "Jane Patron");
  assert.equal(a.provider, "patreon");
});

test("highest entitled tier wins", () => {
  const a = resolveTier(identity({ tiers: ["t-low", "t-high"] }), CFG);
  assert.equal(a.tier, 2);
  assert.equal(a.tierName, "Phantom");
});

test("unmapped tier falls back to price", () => {
  const a = resolveTier(identity({ tiers: ["t-unknown"], cents: 700 }), CFG);
  assert.equal(a.tier, 1);
  assert.equal(a.tierName, "Supporter (by price)");
});

test("former patron gets tier 0", () => {
  const a = resolveTier(identity({ status: "former_patron", tiers: ["t-high"] }), CFG);
  assert.equal(a.tier, 0);
  assert.equal(a.tierName, "Former patron");
});

test("declined payment gets tier 0", () => {
  const a = resolveTier(identity({ tiers: ["t-high"], charge: "Declined" }), CFG);
  assert.equal(a.tier, 0);
});

test("membership of a different campaign is ignored", () => {
  const a = resolveTier(identity({ tiers: ["t-high"], campaign: "999" }), CFG);
  assert.equal(a.tier, 0);
  assert.equal(a.tierName, "Not a patron");
});

test("user with no memberships at all", () => {
  const a = resolveTier({ data: { attributes: { full_name: "New Person" } }, included: [] }, CFG);
  assert.equal(a.tier, 0);
  assert.equal(a.displayName, "New Person");
});

test("override grants a tier to a specific user id", () => {
  const cfg = { patreon: { ...CFG.patreon, overrides: { u1: { level: 4, name: "Creator" } } } };
  const a = resolveTier(identity({ status: "former_patron" }), cfg);
  assert.equal(a.tier, 4);
  assert.equal(a.tierName, "Creator");
  assert.equal(a.userId, "u1");
  // override never lowers a real tier
  const b = resolveTier(identity({ tiers: ["t-high"] }), { patreon: { ...CFG.patreon, overrides: { u1: { level: 1 } } } });
  assert.equal(b.tier, 2);
});

test("authorize url carries client, redirect, scope and state", () => {
  const u = new URL(authorizeUrl({ clientId: "cid", redirectUri: "http://localhost:8787/auth/patreon/callback", state: "n0nce" }));
  assert.equal(u.origin + u.pathname, "https://www.patreon.com/oauth2/authorize");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:8787/auth/patreon/callback");
  assert.equal(u.searchParams.get("scope"), "identity identity.memberships");
  assert.equal(u.searchParams.get("state"), "n0nce");
});
