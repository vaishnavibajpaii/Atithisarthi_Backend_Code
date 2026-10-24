"use strict";

const TASK6_ORDER_STATE_FINALITY_MARKERS = Object.freeze([
  "TASK6_ORDER_FINAL_FINANCIAL_SNAPSHOT_IMMUTABLE",
  "TASK6_ORDER_FINAL_BILL_IMMUTABLE",
  "TASK6_ORDER_FINAL_PAYMENT_IMMUTABLE",
  "TASK6_ORDER_REFUND_WORKFLOW_REQUIRED",
  "TASK6_ORDER_TERMINAL_STATE_IMMUTABLE",
  "TASK6_ORDER_PAYMENT_LIFECYCLE_REQUIRED",
  "TASK6_ORDER_KITCHEN_TRANSITION_INVALID",
  "TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE"
]);

function isTask6OrderStateFinalityConflict(error = {}) {
  const text = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`
    .toUpperCase();
  return TASK6_ORDER_STATE_FINALITY_MARKERS.some((marker) => text.includes(marker));
}

function buildTask6OrderStateFinalityConflictResponse() {
  return {
    success: false,
    code: "ORDER_STATE_FINALITY_CONFLICT",
    message: "This order is finalized or the requested lifecycle transition is not allowed. Reload the order and use the approved workflow."
  };
}

module.exports = {
  TASK6_ORDER_STATE_FINALITY_MARKERS,
  isTask6OrderStateFinalityConflict,
  buildTask6OrderStateFinalityConflictResponse
};
