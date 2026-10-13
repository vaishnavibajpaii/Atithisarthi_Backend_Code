"use strict";

const SAFE_GATEWAY_CODES = new Set([
  "GATEWAY_MODE_MISMATCH",
  "LIVE_GATEWAY_REFUSED",
  "GATEWAY_ROTATION_CONTINUITY_UNAVAILABLE",
  "GATEWAY_ROTATION_CONTINUITY_FAILED",
  "TASK5_GATEWAY_CONFIGURATION_SCOPE_INVALID",
  "TASK5_GATEWAY_KEY_MODE_MISMATCH",
  "TASK5_GATEWAY_SECRET_FORMAT_INVALID",
  "TASK5_GATEWAY_VALIDATION_REQUIRED",
  "TASK5_GATEWAY_CREDENTIAL_CHANGED",
  "TASK5_ROTATION_CONTINUITY_REQUIRED",
  "TASK5_PROPERTY_GATEWAY_NOT_FOUND",
  "TASK5_PER_PROPERTY_GATEWAY_NOT_READY",
  "TASK5_GATEWAY_ACCOUNT_NOT_FOUND",
  "TASK5_GATEWAY_CREDENTIAL_MODE_MISMATCH",
  "TASK5_GATEWAY_CREDENTIAL_NOT_VALIDATED",
  "TASK5_GATEWAY_ACCOUNT_NOT_READY",
  "TASK5_ACTIVE_GATEWAY_ACCOUNT_NOT_READY",
  "TASK5_GATEWAY_POLICY_IDENTITY_IMMUTABLE",
  "TASK5_GATEWAY_ACCOUNT_IDENTITY_IMMUTABLE",
  "TASK5_GATEWAY_CREDENTIAL_IMMUTABLE",
  "TASK5_GATEWAY_WEBHOOK_SECRET_IMMUTABLE",
  "TASK5_GATEWAY_ACCOUNT_STATUS_TRANSITION_INVALID",
  "TASK5_GATEWAY_CREDENTIAL_STATUS_TRANSITION_INVALID",
  "TASK5_GATEWAY_WEBHOOK_STATUS_TRANSITION_INVALID",
  "PER_HOTEL_GATEWAY_FEATURE_DISABLED",
  "PROVIDER_LOOKUP_FAILED",
  "PROVIDER_TIMEOUT"
]);

const SAFE_DATABASE_CODE_BY_SQLSTATE = Object.freeze({
  "42501": "TASK5_DATABASE_PERMISSION_DENIED",
  "23503": "TASK5_DATABASE_REFERENCE_REJECTED",
  "23505": "TASK5_DATABASE_CONFLICT",
  "23514": "TASK5_DATABASE_CONSTRAINT_REJECTED",
  "40001": "TASK5_DATABASE_CONCURRENT_CHANGE"
});

function classifyGatewayAdminError(error = {}) {
  const suppliedCode = String(error.code || "");
  const exactMessage = String(error.message || "");
  let code = "GATEWAY_OPERATION_FAILED";

  if (SAFE_GATEWAY_CODES.has(suppliedCode)) {
    code = suppliedCode;
  } else if (SAFE_GATEWAY_CODES.has(exactMessage)) {
    // PostgreSQL exposes RAISE EXCEPTION markers through `message`, while its
    // `code` remains a five-character SQLSTATE. Only exact allowlisted markers
    // may cross the API boundary.
    code = exactMessage;
  } else if (SAFE_DATABASE_CODE_BY_SQLSTATE[suppliedCode]) {
    code = SAFE_DATABASE_CODE_BY_SQLSTATE[suppliedCode];
  }

  const status = Number(error.httpStatus) || (
    code === "PROVIDER_LOOKUP_FAILED" ||
    code === "GATEWAY_MODE_MISMATCH" ||
    code === "TASK5_GATEWAY_KEY_MODE_MISMATCH" ||
    code === "TASK5_GATEWAY_SECRET_FORMAT_INVALID" ||
    code === "TASK5_GATEWAY_CONFIGURATION_SCOPE_INVALID"
      ? 400
      : 409
  );

  let message = "Payment gateway operation could not be completed";
  if (code === "PROVIDER_LOOKUP_FAILED") {
    message = "Razorpay rejected the submitted TEST credential";
  } else if (code === "TASK5_DATABASE_PERMISSION_DENIED") {
    message = "Database gateway permissions rejected the operation";
  } else if (code.startsWith("TASK5_DATABASE_")) {
    message = "Database gateway safeguards rejected the operation";
  }

  return { code, status, message };
}

module.exports = { classifyGatewayAdminError };
