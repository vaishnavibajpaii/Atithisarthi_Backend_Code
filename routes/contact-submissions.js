const express = require("express");
const { supabase } = require("../utils/supabase");
const { publicContactSubmissionLimiter } = require("../middleware/public-rate-limiters");
const { createNotificationEventSafely } = require("../utils/notifications");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const { getTenantMutationClient } = require("../utils/tenant-route-database");
const { validateBody } = require("../validators/common");
const { contactSubmissionSchema } = require("../validators/public");

const router = express.Router();

function isMissingContactSubmissionsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("contact_submissions") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

router.post("/", publicContactSubmissionLimiter, validateBody(contactSubmissionSchema), async (req, res) => {
  try {
    const {
      hotelName,
      hotelSlug,
      name,
      email,
      subject,
      message,
      googleSheetStatus,
      googleSheetResponse
    } = req.validatedBody;

    const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
      notFoundMessage: "Hotel is not available for contact requests",
      forbiddenMessage: "This hotel cannot accept contact requests from the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    const database = getTenantMutationClient(req, supabase);
    const { data, error } = await database
      .from("contact_submissions")
      .insert([
        {
          tenant_id: hotelAccess.tenant_id,
          property_id: hotelAccess.id,
          hotel_slug: hotelAccess.slug,
          hotel_name: hotelName,
          name,
          email,
          subject: subject || "",
          message,
          status: "new",
          source: "website_contact",
          google_sheet_status: googleSheetStatus || "not_attempted",
          google_sheet_response:
            googleSheetResponse &&
            typeof googleSheetResponse === "object" &&
            !Array.isArray(googleSheetResponse)
              ? googleSheetResponse
              : {},
          updated_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      if (isMissingContactSubmissionsRelationError(error)) {
        return res.status(503).json({
          success: false,
          message: "Contact submissions are not initialized yet"
        });
      }

      throw error;
    }

    void createNotificationEventSafely({
      databaseClient: database,
      tenantId: hotelAccess.tenant_id,
      propertyId: hotelAccess.id,
      hotelSlug: data.hotel_slug || hotelSlug,
      sourceType: "contact_submission",
      sourceId: data.id,
      payload: {
        contactSubmissionId: data.id,
        hotelName: data.hotel_name || hotelName || "",
        hotelSlug: data.hotel_slug || hotelSlug || "",
        name: data.name || name,
        email: data.email || email,
        subject: data.subject || subject || "",
        message: data.message || message,
        status: data.status || "new",
        source: data.source || "website_contact",
        googleSheetStatus: data.google_sheet_status || googleSheetStatus || "not_attempted"
      }
    });

    res.status(201).json({
      success: true,
      message: "Contact submission saved",
      contactSubmission: {
        id: data.id,
        hotelName: data.hotel_name,
        hotelSlug: data.hotel_slug,
        name: data.name,
        email: data.email,
        subject: data.subject,
        message: data.message,
        status: data.status,
        createdAt: data.created_at
      }
    });
  } catch (error) {
    console.error("Contact submission save error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save contact submission"
    });
  }
});

module.exports = router;
