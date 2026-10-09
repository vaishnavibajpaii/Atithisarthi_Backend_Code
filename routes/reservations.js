const express = require("express");
const { supabase } = require("../utils/supabase");
const { publicReservationLimiter } = require("../middleware/public-rate-limiters");
const { createNotificationEventSafely } = require("../utils/notifications");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const { getTenantMutationClient } = require("../utils/tenant-route-database");
const { ensureHotelFeatureEnabled } = require("../middleware/require-hotel-feature");

// ✅ Added imports
const { validateBody } = require("../validators/common");
const { reservationSchema } = require("../validators/public");

const router = express.Router();

// ✅ Middleware added
router.post("/", publicReservationLimiter, validateBody(reservationSchema), async (req, res) => {
  try {
    // ✅ Use validatedBody
    const {
      hotelName,
      hotelSlug,
      name,
      phone,
      date,
      time,
      guests,
      note
    } = req.validatedBody;

    const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
      notFoundMessage: "Hotel is not available for reservations",
      forbiddenMessage: "This hotel cannot accept reservations from the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    if (!(await ensureHotelFeatureEnabled(res, { featureKey: "food", hotelSlug }))) {
      return;
    }

    // (Optional: manual validation can be removed since schema handles it)

    const database = getTenantMutationClient(req, supabase);
    const { data, error } = await database
      .from("reservations")
      .insert([
        {
          tenant_id: hotelAccess.tenant_id,
          property_id: hotelAccess.id,
          hotel_name: hotelName || "Unknown Hotel",
          hotel_slug: hotelAccess.slug,
          name,
          phone,
          date,
          time,
          guests,
          note: note || "",
          status: "new"
        }
      ])
      .select()
      .single();

    if (error) {
      throw error;
    }

    void createNotificationEventSafely({
      databaseClient: database,
      tenantId: hotelAccess.tenant_id,
      propertyId: hotelAccess.id,
      hotelSlug: data.hotel_slug || hotelSlug || null,
      sourceType: "reservation",
      sourceId: data.id,
      payload: {
        reservationId: data.id,
        hotelName: data.hotel_name || hotelName || "",
        name: data.name || name,
        phone: data.phone || phone,
        date: data.date || date,
        time: data.time || time,
        guests: data.guests || guests,
        note: data.note || note || "",
        status: data.status || "new"
      }
    });

    res.status(201).json({
      success: true,
      message: "Reservation saved successfully",
      reservation: data
    });
  } catch (error) {
    console.error("Reservation save error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save reservation"
    });
  }
});

module.exports = router;
