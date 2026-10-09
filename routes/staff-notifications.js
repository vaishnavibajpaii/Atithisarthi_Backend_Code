"use strict";

const express = require("express");
const { requireStaffAuth } = require("../middleware/require-staff-auth");
const { supabase } = require("../utils/supabase");
const { env } = require("../config/env");
const { getStaffTenantMutationClient } = require("../utils/tenant-route-database");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const { subscribeToNotificationEvents } = require("../utils/notification-live");
const {
  fetchHotelFeatureConfig,
  isHotelFeatureEnabled
} = require("../utils/hotel-feature-settings");
const {
  NOTIFICATION_CARD_DEFINITIONS,
  getAllowedNotificationCardKeys,
  isNotificationCardAllowed,
  normalizeCardText,
  resolveNotificationCardKey
} = require("../utils/notification-card-map");

const {
  NOTIFICATION_EVENT_WINDOW,
  buildNotificationSummary
} = require("../utils/notification-summary");

const router = express.Router();

function isMissingAcknowledgementRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    details.includes("notification_card_acknowledgements")
  );
}

function isMissingAcknowledgementFunctionError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();
  return (
    code === "42883" ||
    code === "PGRST202" ||
    details.includes("acknowledge_notification_card")
  );
}
function isAcknowledgementSchemaNotReadyError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return isMissingAcknowledgementRelationError(error) ||
    code === "23514" ||
    details.includes("notification_card_ack_card_key_check");
}

async function persistNotificationAcknowledgement(context = {}, cardKey = "", acknowledgedThroughId = 0, req = null) {
  const acknowledgedAt = new Date().toISOString();
  const database = req
    ? await getStaffTenantMutationClient(req, supabase)
    : supabase;
  const scope = req && env.tenantRuntimeWritesEnabled
    ? getTenantRequestScope(req)
    : null;
  const rpcResult = await database.rpc("acknowledge_notification_card", {
    p_hotel_slug: context.hotelSlug,
    p_staff_id: context.staffId,
    p_card_key: cardKey,
    p_acknowledged_through_id: acknowledgedThroughId
  });

  if (!rpcResult.error) {
    const row = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data;
    return {
      acknowledgedThroughId: Math.max(
        acknowledgedThroughId,
        Number(row?.acknowledged_through_id || 0) || 0
      ),
      acknowledgedAt: row?.acknowledged_at || acknowledgedAt
    };
  }

  if (!isMissingAcknowledgementFunctionError(rpcResult.error)) {
    throw rpcResult.error;
  }

  const currentResult = await database
    .from("notification_card_acknowledgements")
    .select("acknowledged_through_id,acknowledged_at")
    .eq("hotel_slug", context.hotelSlug)
    .eq("staff_id", context.staffId)
    .eq("card_key", cardKey)
    .maybeSingle();
  if (currentResult.error) throw currentResult.error;

  const monotonicThroughId = Math.max(
    acknowledgedThroughId,
    Number(currentResult.data?.acknowledged_through_id || 0) || 0
  );
  const fallbackResult = await database
    .from("notification_card_acknowledgements")
    .upsert(
      [
        {
          ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
          hotel_slug: scope?.propertySlug || context.hotelSlug,
          staff_id: context.staffId,
          card_key: cardKey,
          acknowledged_through_id: monotonicThroughId,
          acknowledged_at: acknowledgedAt,
          updated_at: acknowledgedAt
        }
      ],
      { onConflict: "hotel_slug,staff_id,card_key" }
    )
    .select("acknowledged_through_id,acknowledged_at")
    .single();
  if (fallbackResult.error) throw fallbackResult.error;

  return {
    acknowledgedThroughId: Math.max(
      monotonicThroughId,
      Number(fallbackResult.data?.acknowledged_through_id || 0) || 0
    ),
    acknowledgedAt: fallbackResult.data?.acknowledged_at || acknowledgedAt
  };
}

function getStaffId(req = {}) {
  return String(req.staffUser?.sub || req.staffUser?.id || "").trim();
}

async function getNotificationPermissionContext(req = {}) {
  const hotelSlug = String(req.staffHotelSlug || "").trim();
  const featureConfig = await fetchHotelFeatureConfig(supabase, hotelSlug);

  return {
    hotelSlug,
    staffId: getStaffId(req),
    isManager: req.staffCanViewManagerData === true || req.staffUser?.isManager === true,
    canUseFood: isHotelFeatureEnabled(featureConfig, "food"),
    canUseRooms: isHotelFeatureEnabled(featureConfig, "rooms")
  };
}

function getAllowedEventTypes(cardKeys = []) {
  return Array.from(
    new Set(
      cardKeys.flatMap(
        (cardKey) => NOTIFICATION_CARD_DEFINITIONS[cardKey]?.eventTypes || []
      )
    )
  );
}

async function fetchScopedNotificationEvents(context = {}) {
  const cardKeys = getAllowedNotificationCardKeys(context);
  const eventTypes = getAllowedEventTypes(cardKeys);

  if (!context.hotelSlug || !eventTypes.length) {
    return [];
  }

  const { data, error } = await supabase
    .from("notification_events")
    .select("id,hotel_slug,event_type,payload,created_at")
    .eq("hotel_slug", context.hotelSlug)
    .in("event_type", eventTypes)
    .order("id", { ascending: false })
    .limit(NOTIFICATION_EVENT_WINDOW);

  if (error) {
    throw error;
  }

  return (data || []).filter((event) => {
    const cardKey = resolveNotificationCardKey(event);
    return cardKey && cardKeys.includes(cardKey);
  });
}

async function fetchAcknowledgementCursors(context = {}, cardKeys = []) {
  if (!context.hotelSlug || !context.staffId || !cardKeys.length) {
    return { available: false, cursors: {} };
  }

  const { data, error } = await supabase
    .from("notification_card_acknowledgements")
    .select("card_key,acknowledged_through_id,acknowledged_at")
    .eq("hotel_slug", context.hotelSlug)
    .eq("staff_id", context.staffId)
    .in("card_key", cardKeys);

  if (error) {
    if (isMissingAcknowledgementRelationError(error)) {
      return { available: false, cursors: {} };
    }

    throw error;
  }

  return {
    available: true,
    cursors: Object.fromEntries(
      (data || []).map((row) => [
        row.card_key,
        Math.max(0, Number(row.acknowledged_through_id || 0) || 0)
      ])
    )
  };
}

router.get("/stream", requireStaffAuth, async (req, res, next) => {
  try {
    const context = await getNotificationPermissionContext(req);
    if (!context.hotelSlug || !context.staffId) {
      return res.status(403).json({ success: false, message: "Staff notification scope is missing" });
    }

    res.status(200);
    res.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders?.();
    subscribeToNotificationEvents({ request: req, response: res, context });
  } catch (error) {
    next(error);
  }
});
router.get("/summary", requireStaffAuth, async (req, res) => {
  try {
    const context = await getNotificationPermissionContext(req);
    if (!context.hotelSlug || !context.staffId) {
      return res.status(403).json({
        success: false,
        message: "Staff notification scope is missing"
      });
    }

    const cardKeys = getAllowedNotificationCardKeys(context);
    const [events, acknowledgement] = await Promise.all([
      fetchScopedNotificationEvents(context),
      fetchAcknowledgementCursors(context, cardKeys)
    ]);

    res.set("Cache-Control", "private, no-store");
    return res.json(buildNotificationSummary(context, events, acknowledgement));
  } catch (error) {
    console.error("Staff notification summary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load notification summary"
    });
  }
});

router.post("/cards/:cardKey/acknowledge", requireStaffAuth, async (req, res) => {
  try {
    const context = await getNotificationPermissionContext(req);
    const cardKey = normalizeCardText(req.params.cardKey || "");

    if (!context.hotelSlug || !context.staffId) {
      return res.status(403).json({
        success: false,
        message: "Staff notification scope is missing"
      });
    }

    if (!isNotificationCardAllowed(cardKey, context)) {
      return res.status(403).json({
        success: false,
        code: "notification_card_forbidden",
        message: "This notification card is not available for the current staff session"
      });
    }

    const requestedThroughId = Number(req.body?.acknowledgedThroughId);
    if (
      req.body?.acknowledgedThroughId !== undefined &&
      (!Number.isSafeInteger(requestedThroughId) || requestedThroughId < 0)
    ) {
      return res.status(400).json({
        success: false,
        code: "invalid_acknowledgement_cursor",
        message: "Acknowledgement cursor must be a non-negative integer"
      });
    }

    const events = await fetchScopedNotificationEvents(context);
    const latestEventId = events.reduce((latest, event) => {
      if (resolveNotificationCardKey(event) !== cardKey) {
        return latest;
      }

      return Math.max(latest, Number(event.id || 0) || 0);
    }, 0);
    const acknowledgedThroughId = req.body?.acknowledgedThroughId === undefined
      ? latestEventId
      : Math.min(requestedThroughId, latestEventId);
    let persistedAcknowledgement;
    try {
      persistedAcknowledgement = await persistNotificationAcknowledgement(
        context,
        cardKey,
        acknowledgedThroughId,
        req
      );
    } catch (error) {
      if (isAcknowledgementSchemaNotReadyError(error)) {
        return res.status(503).json({
          success: false,
          code: "notification_acknowledgements_not_ready",
          message: "Notification acknowledgement storage is not initialized"
        });
      }
      throw error;
    }

    res.set("Cache-Control", "private, no-store");
    return res.json({
      success: true,
      cardKey,
      acknowledgedThroughId: persistedAcknowledgement.acknowledgedThroughId,
      acknowledgedAt: persistedAcknowledgement.acknowledgedAt
    });
  } catch (error) {
    console.error("Staff notification acknowledgement error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to acknowledge notification card"
    });
  }
});

module.exports = router;
module.exports.buildNotificationSummary = buildNotificationSummary;
module.exports.fetchScopedNotificationEvents = fetchScopedNotificationEvents;
module.exports.getNotificationPermissionContext = getNotificationPermissionContext;
module.exports.persistNotificationAcknowledgement = persistNotificationAcknowledgement;


