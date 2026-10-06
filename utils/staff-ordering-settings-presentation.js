"use strict";

function buildStaffOrderingSettingsPayload({
  hotelSlug = "",
  settings = {}
} = {}) {
  return {
    success: true,
    hotelSlug,
    ordering: {
      staffOrderingEnabled: settings.staffOrderingEnabled !== false,
      enforceTableMaster: settings.enforceTableMaster === true,
      secureOnlinePaymentEnabled:
        settings.secureOnlinePaymentEnabled !== false,
      cashOnDeliveryEnabled:
        settings.cashOnDeliveryEnabled !== false,
      manualUpiPaymentEnabled:
        settings.manualUpiPaymentEnabled !== false,
      title: settings.disabledTitle || "",
      message: settings.disabledMessage || "",
      icon: settings.disabledIcon || ""
    }
  };
}

module.exports = {
  buildStaffOrderingSettingsPayload
};
