"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-popup.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const { fetchTenantPublicPopupNotifications } = require("../utils/tenant-public-popup-notifications");
const { buildPublicPopupNotificationPayload } = require("../utils/public-popup-notification-presentation");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj"
};

test("tenant public popup query is canonical, ordered, limited, and read only", async () => {
  const calls = [];
  const item = { id: "popup-1", hotel_slug: SCOPE.propertySlug };
  const transactionRunner = async (context, work, options) => {
    calls.push({ type: "transaction", context, options });
    return work({
      async query(sql, params) {
        calls.push({ type: "query", sql, params });
        return { rows: [{ payload: item }] };
      }
    });
  };
  assert.deepEqual(
    await fetchTenantPublicPopupNotifications(
      SCOPE,
      SCOPE.propertySlug,
      { transactionRunner }
    ),
    [item]
  );
  assert.equal(calls[0].options.readOnly, true);
  assert.deepEqual(calls[1].params, [SCOPE.tenantId, SCOPE.propertyId, SCOPE.propertySlug]);
  assert.match(calls[1].sql, /item\.tenant_id = \$1::uuid/);
  assert.match(calls[1].sql, /item\.property_id = \$2::bigint/);
  assert.match(calls[1].sql, /item\.hotel_slug = \$3/);
  assert.match(calls[1].sql, /ORDER BY item\.priority DESC, item\.created_at DESC/);
  assert.match(calls[1].sql, /LIMIT 20/);
});

test("popup presenter preserves active-window and safe public mapping", () => {
  const now = new Date("2026-01-02T00:00:00Z");
  const payload = buildPublicPopupNotificationPayload([
    {
      id: "active",
      hotel_slug: SCOPE.propertySlug,
      title: " Welcome ",
      cta_link: "javascript:alert(1)",
      start_at: "2026-01-01T00:00:00Z",
      end_at: "2026-01-03T00:00:00Z",
      priority: "2",
      tenant_id: "hidden"
    },
    {
      id: "future",
      hotel_slug: SCOPE.propertySlug,
      title: "Future",
      start_at: "2026-02-01T00:00:00Z"
    }
  ], now);
  assert.equal(payload.notifications.length, 1);
  assert.equal(payload.notification.id, "active");
  assert.equal(payload.notification.title, "Welcome");
  assert.equal(payload.notification.ctaLink, "");
  assert.equal("tenant_id" in payload.notification, false);
});

test("tenant public popup rejects slug/context mismatch before DB use", async () => {
  let called = false;
  await assert.rejects(
    fetchTenantPublicPopupNotifications(SCOPE, "the-food-garden", {
      transactionRunner: async () => { called = true; }
    }),
    { code: "TENANT_PUBLIC_HOTEL_SCOPE_CONFLICT" }
  );
  assert.equal(called, false);
});
