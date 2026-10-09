"use strict";

const { requireStaffAuth, requireStaffManagerAccess } = require("../middleware/require-staff-auth");
const { supabase } = require("../utils/supabase");
const { getStaffTenantMutationClient } = require("../utils/tenant-route-database");
const { createRoomCheckoutBillRouter } = require("./create-room-checkout-bill-router");

async function resolveStaffBookingHotelSlug(req) {
  const bookingId = String(req.params?.id || "").trim();
  const hotelSlug = String(req.staffHotelSlug || "").trim();
  if (!bookingId || !hotelSlug) return "";

  const { data, error } = await supabase
    .from("room_bookings")
    .select("hotel_slug")
    .eq("id", bookingId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();
  if (error) throw error;
  return data?.hotel_slug || "";
}

module.exports = createRoomCheckoutBillRouter({
  supabaseClient: supabase,
  resolveDatabaseClient: (req) => getStaffTenantMutationClient(req, supabase),
  authMiddleware: requireStaffAuth,
  configureMiddleware: requireStaffManagerAccess,
  resolveHotelSlug: (req) => req.staffHotelSlug,
  resolveBookingHotelSlug: resolveStaffBookingHotelSlug,
  resolveActor: (req) => ({
    id: req.staffUser?.sub || req.staffUser?.id || null,
    role: req.staffRole || req.staffUser?.role || "owner",
    displayName: req.staffUser?.displayName || "Hotel staff"
  })
});
