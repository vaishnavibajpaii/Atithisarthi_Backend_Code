"use strict";

const { withTenantTransaction } = require("./tenant-database");
const {
  normalizeHotelFeatureConfig
} = require("./hotel-feature-settings");
const {
  normalizeScope,
  getSinglePayload
} = require("./tenant-public-hotel");

const TRACKING_ORDER_JSON_SQL = `
  jsonb_build_object(
    'id', target.id,
    'hotel_slug', target.hotel_slug,
    'hotel_name', target.hotel_name,
    'order_type', target.order_type,
    'table_number', target.table_number,
    'order_source', target.order_source,
    'payment_method', target.payment_method,
    'payment_status', target.payment_status,
    'billing_status', target.billing_status,
    'bill_number', target.bill_number,
    'room_id', target.room_id,
    'room_booking_id', target.room_booking_id,
    'room_number', target.room_number,
    'room_service_guest_name', target.room_service_guest_name,
    'room_service_charge_to_room', target.room_service_charge_to_room,
    'items', target.items,
    'totals', target.totals,
    'status', target.status,
    'created_at', target.created_at
  )
`;

const TRACKING_ADDON_JSON_SQL = `
  jsonb_build_object(
    'id', target.id,
    'hotel_slug', target.hotel_slug,
    'parent_order_id', target.parent_order_id,
    'order_sequence_label', target.order_sequence_label,
    'addon_sequence', target.addon_sequence,
    'payment_method', target.payment_method,
    'payment_status', target.payment_status,
    'billing_status', target.billing_status,
    'items', target.items,
    'totals', target.totals,
    'status', target.status,
    'created_at', target.created_at
  )
`;

function normalizeTrackingValue(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function getPayloads(result) {
  return (Array.isArray(result?.rows) ? result.rows : [])
    .map((row) => row?.payload)
    .filter((row) => row && typeof row === "object");
}

async function fetchTenantPublicOrderTrackingBundle(
  inputScope,
  requestedSlug,
  {
    orderId,
    trackingToken
  } = {},
  options = {}
) {
  const scope = normalizeScope(inputScope, requestedSlug);
  const normalizedOrderId = normalizeTrackingValue(orderId, 120);
  const normalizedTrackingToken = normalizeTrackingValue(trackingToken, 200);
  if (!normalizedOrderId || !normalizedTrackingToken) {
    const error = new Error("Order ID and tracking token are required");
    error.code = "TENANT_PUBLIC_ORDER_TRACKING_INPUT_INVALID";
    throw error;
  }

  const transactionRunner = options.transactionRunner || withTenantTransaction;
  return transactionRunner(
    {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId
    },
    async (client) => {
      const scopeParams = [
        scope.tenantId,
        scope.propertyId,
        scope.propertySlug
      ];
      const featureResult = await client.query(
        `SELECT to_jsonb(settings) AS payload
           FROM public.hotel_feature_settings AS settings
          WHERE settings.tenant_id = $1::uuid
            AND settings.property_id = $2::bigint
            AND settings.hotel_slug = $3
          LIMIT 2`,
        scopeParams
      );
      const featureConfig = normalizeHotelFeatureConfig(
        getSinglePayload(featureResult, "hotel feature settings") || {},
        scope.propertySlug
      );

      const orderResult = await client.query(
        `SELECT ${TRACKING_ORDER_JSON_SQL} AS payload
           FROM public.orders AS target
          WHERE target.tenant_id = $1::uuid
            AND target.property_id = $2::bigint
            AND target.hotel_slug = $3
            AND target.id::text = $4
            AND target.tracking_token = $5
          LIMIT 2`,
        [...scopeParams, normalizedOrderId, normalizedTrackingToken]
      );
      const order = getSinglePayload(orderResult, "tracked order");
      if (!order) {
        return {
          featureConfig,
          order: null,
          addOns: [],
          ownerWhatsAppNumber: ""
        };
      }

      const addOnResult = await client.query(
        `SELECT ${TRACKING_ADDON_JSON_SQL} AS payload
           FROM public.orders AS target
          WHERE target.tenant_id = $1::uuid
            AND target.property_id = $2::bigint
            AND target.hotel_slug = $3
            AND target.parent_order_id::text = $4
          ORDER BY target.addon_sequence ASC NULLS LAST,
                   target.created_at ASC,
                   target.id ASC`,
        [...scopeParams, normalizedOrderId]
      );
      const profileResult = await client.query(
        `SELECT profile.owner_whatsapp_number
           FROM public.hotel_profiles AS profile
          WHERE profile.tenant_id = $1::uuid
            AND profile.property_id = $2::bigint
            AND profile.hotel_slug = $3
          LIMIT 2`,
        scopeParams
      );
      const hotelResult = await client.query(
        `SELECT hotel.whatsapp_number
           FROM public.hotels AS hotel
          WHERE hotel.tenant_id = $1::uuid
            AND hotel.id = $2::bigint
            AND hotel.slug = $3
          LIMIT 2`,
        scopeParams
      );

      return {
        featureConfig,
        order,
        addOns: getPayloads(addOnResult),
        ownerWhatsAppNumber:
          normalizeTrackingValue(
            profileResult.rows?.[0]?.owner_whatsapp_number,
            80
          ) ||
          normalizeTrackingValue(hotelResult.rows?.[0]?.whatsapp_number, 80)
      };
    },
    { readOnly: true }
  );
}

module.exports = {
  TRACKING_ADDON_JSON_SQL,
  TRACKING_ORDER_JSON_SQL,
  fetchTenantPublicOrderTrackingBundle,
  getPayloads,
  normalizeTrackingValue
};
