const { z } = require("zod");

const staffLoginSchema = z.object({
  hotelSlug: z.string().trim().min(2).max(120),
  pin: z.string().trim().min(4).max(80)
});

const staffTableOrderItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  qty: z.number().int().positive().max(100),
  note: z.string().trim().max(500).optional()
});

const staffTableOrderSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(200).optional(),
  tableNumber: z.string().trim().min(1).max(80),
  restaurantTableId: z.union([z.string().trim().min(1).max(40), z.number().int().positive()]).optional(),
  customerName: z.string().trim().max(100).optional(),
  customerPhone: z.string().trim().max(20).optional(),
  note: z.string().trim().max(1000).optional(),
  items: z.array(staffTableOrderItemSchema).min(1).max(100)
});

const staffRoomServiceOrderSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(200).optional(),
  roomBookingId: z.coerce.number().int().positive(),
  customerName: z.string().trim().max(100).optional(),
  customerPhone: z.string().trim().max(20).optional(),
  paymentMethod: z.string().trim().max(40).optional(),
  chargeToRoom: z.boolean().optional(),
  note: z.string().trim().max(1000).optional(),
  items: z.array(staffTableOrderItemSchema).min(1).max(100)
});

const staffOrderItemAdditionSchema = z.object({
  tableNumber: z.string().trim().min(1).max(80),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(12).max(160).optional(),
  note: z.string().trim().max(1000).optional(),
  items: z.array(staffTableOrderItemSchema).min(1).max(100)
});

const staffKdsKitchenStatusSchema = z.object({
  kitchenStatus: z.enum([
    "new",
    "accepted",
    "preparing",
    "ready",
    "served",
    "delayed",
    "cancelled"
  ]),
  expectedVersion: z.number().int().positive(),
  clientRequestId: z.string().trim().min(12).max(160).optional()
});

const staffPaymentMethodSettingsSchema = z.object({
  secureOnlinePaymentEnabled: z.boolean(),
  cashOnDeliveryEnabled: z.boolean(),
  manualUpiPaymentEnabled: z.boolean()
}).superRefine((settings, ctx) => {
  if (
    !settings.secureOnlinePaymentEnabled &&
    !settings.cashOnDeliveryEnabled &&
    !settings.manualUpiPaymentEnabled
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Enable at least one customer payment method",
      path: ["cashOnDeliveryEnabled"]
    });
  }
});

module.exports = {
  staffLoginSchema,
  staffTableOrderSchema,
  staffRoomServiceOrderSchema,
  staffOrderItemAdditionSchema,
  staffKdsKitchenStatusSchema,
  staffPaymentMethodSettingsSchema
};
