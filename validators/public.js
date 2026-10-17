const { z } = require("zod");

const orderItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  qty: z.number().int().positive(),
  price: z.number().nonnegative()
});

const orderContextSchema = z.object({
  orderType: z.string().trim().max(40).optional(),
  tableNumber: z.string().trim().max(80).optional(),
  orderSource: z.string().trim().max(40).optional(),
  qrContextToken: z.string().trim().max(2000).optional()
}).optional();

const orderSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(200).optional(),
  hotelName: z.string().trim().min(1),
  hotelSlug: z.string().trim().min(1).optional().nullable(),
  customerName: z.string().trim().min(2).max(100),
  customerPhone: z.string().trim().min(8).max(20),
  customerAddress: z.string().trim().min(3).max(500),
  paymentMethod: z.string().trim().min(1).max(30).optional(),
  note: z.string().max(1000).optional(),
  paymentConfirmed: z.boolean().optional(),
  items: z.array(orderItemSchema).min(1),
  totals: z.object({
    subtotal: z.number().nonnegative().optional(),
    gst: z.number().nonnegative().optional(),
    total: z.number().nonnegative().optional(),
    normalTotal: z.number().nonnegative().optional(),
    gpayDiscount: z.number().nonnegative().optional(),
    gpayFinalTotal: z.number().nonnegative().optional()
  }).optional(),
  whatsappMessage: z.string().max(5000).optional(),
  orderContext: orderContextSchema
});

const inquirySchema = z.object({
  hotelName: z.string().trim().min(1),
  hotelSlug: z.string().trim().min(1).optional().nullable(),
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(8).max(20),
  eventType: z.string().trim().min(2).max(100),
  date: z.string().trim().min(1).max(50),
  guests: z.union([z.string(), z.number()]).optional(),
  specialRequirements: z.string().max(2000).optional()
});

const reservationSchema = z.object({
  hotelName: z.string().trim().min(1),
  hotelSlug: z.string().trim().min(1).optional().nullable(),
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(8).max(20),
  date: z.string().trim().min(1).max(50),
  time: z.string().trim().min(1).max(50),
  guests: z.union([z.string(), z.number()]),
  note: z.string().max(1000).optional()
});

const testimonialSubmissionSchema = z.object({
  hotelName: z.string().trim().min(1).max(150),
  hotelSlug: z.string().trim().min(1).max(120),
  name: z.string().trim().min(2).max(150),
  role: z.string().trim().max(150).optional(),
  text: z.string().trim().min(2).max(4000),
  stars: z.number().int().min(1).max(5)
});

const contactSubmissionSchema = z.object({
  hotelName: z.string().trim().min(1).max(150),
  hotelSlug: z.string().trim().min(1).max(120),
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(320),
  subject: z.string().trim().max(200).optional().nullable(),
  message: z.string().trim().min(2).max(4000),
  googleSheetStatus: z.string().trim().max(40).optional().nullable(),
  googleSheetResponse: z.record(z.string(), z.any()).optional().nullable()
});

const menuAssistantRequestSchema = z.object({
  message: z.string().trim().min(2).max(500),
  context: z
    .object({
      budget: z.number().nonnegative().max(100000).nullish(),
      peopleCount: z.number().int().min(1).max(20).nullish(),
      pageScope: z.string().trim().max(40).optional(),
      orderType: z.string().trim().max(40).optional(),
      tableNumber: z.string().trim().max(80).optional(),
      orderSource: z.string().trim().max(40).optional(),
      addMode: z.boolean().optional(),
      trackingHotelSlug: z.string().trim().max(120).optional(),
      trackingOrderId: z.string().trim().max(120).optional(),
      trackingToken: z.string().trim().max(200).optional()
    })
    .optional()
});

module.exports = {
  orderSchema,
  inquirySchema,
  reservationSchema,
  testimonialSubmissionSchema,
  contactSubmissionSchema,
  menuAssistantRequestSchema
};
