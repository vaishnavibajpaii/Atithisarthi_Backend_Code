"use strict";

const { z } = require("zod");

const providerSchema = z.literal("razorpay").default("razorpay");
const modeSchema = z.enum(["TEST", "LIVE"]);
const keyIdSchema = z.string().trim().min(10).max(160)
  .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, "Invalid Razorpay key ID format");
const writeOnlySecretSchema = z.string().min(8).max(500)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Secret contains invalid control characters");

const gatewayTestConnectionSchema = z.object({
  provider: providerSchema,
  mode: modeSchema,
  keyId: keyIdSchema,
  keySecret: writeOnlySecretSchema
});

const gatewayConfigureSchema = z.object({
  provider: providerSchema,
  mode: modeSchema,
  keyId: keyIdSchema,
  keySecret: writeOnlySecretSchema,
  webhookSecret: writeOnlySecretSchema
});

const gatewayEnabledSchema = z.object({ enabled: z.boolean() });
const gatewayResolutionSchema = z.object({
  resolutionMode: z.enum(["LEGACY_GLOBAL", "PER_PROPERTY"])
});

module.exports = {
  gatewayConfigureSchema,
  gatewayEnabledSchema,
  gatewayResolutionSchema,
  gatewayTestConnectionSchema
};
