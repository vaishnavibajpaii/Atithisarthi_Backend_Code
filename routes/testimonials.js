const express = require("express");
const { supabase } = require("../utils/supabase");
const { publicTestimonialSubmissionLimiter } = require("../middleware/public-rate-limiters");
const { createNotificationEventSafely } = require("../utils/notifications");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const { getTenantMutationClient } = require("../utils/tenant-route-database");
const { validateBody } = require("../validators/common");
const { testimonialSubmissionSchema } = require("../validators/public");

const router = express.Router();

function isMissingTestimonialsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("testimonial") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

router.post("/", publicTestimonialSubmissionLimiter, validateBody(testimonialSubmissionSchema), async (req, res) => {
  try {
    const { hotelName, hotelSlug, name, role, text, stars } = req.validatedBody;

    const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
      notFoundMessage: "Hotel is not available for reviews",
      forbiddenMessage: "This hotel cannot accept reviews from the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    const database = getTenantMutationClient(req, supabase);
    const { data, error } = await database
      .from("testimonials")
      .insert([
        {
          tenant_id: hotelAccess.tenant_id,
          property_id: hotelAccess.id,
          hotel_slug: hotelAccess.slug,
          guest_name: name,
          guest_role: role || "",
          review_text: text,
          star_rating: Number(stars),
          avatar_url: "",
          sort_order: 0,
          is_active: true,
          is_archived: false,
          is_approved: false,
          updated_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.status(503).json({
          success: false,
          message: "Reviews are temporarily unavailable"
        });
      }

      throw error;
    }

    void createNotificationEventSafely({
      databaseClient: database,
      tenantId: hotelAccess.tenant_id,
      propertyId: hotelAccess.id,
      hotelSlug: data.hotel_slug || hotelSlug,
      sourceType: "testimonial",
      sourceId: data.id,
      payload: {
        testimonialId: data.id,
        hotelName: hotelName || "",
        hotelSlug: data.hotel_slug || hotelSlug || "",
        name,
        role: role || "",
        text,
        stars: Number(stars),
        approvalStatus: data.is_approved ? "approved" : "pending_approval",
        isApproved: !!data.is_approved
      }
    });

    res.status(201).json({
      success: true,
      message: "Review submitted successfully. It will appear after approval.",
      testimonial: {
        id: data.id,
        hotelName,
        hotelSlug,
        name,
        role: role || "",
        text,
        stars: Number(stars),
        isApproved: false
      }
    });
  } catch (error) {
    console.error("Testimonial submission error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to submit review"
    });
  }
});

module.exports = router;
