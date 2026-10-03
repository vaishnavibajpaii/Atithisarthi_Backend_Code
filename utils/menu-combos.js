const { supabase } = require("./supabase");

function getMenuComboLookupKey(hotelSlug = "", itemId = "") {
  return `${String(hotelSlug || "").trim()}::${String(itemId || "").trim()}`;
}

function normalizeComboDateValue(value = "") {
  return String(value || "").trim();
}

function normalizeComboTimeValue(value = "") {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    return "";
  }

  if (/^\d{2}:\d{2}$/.test(normalizedValue)) {
    return `${normalizedValue}:00`;
  }

  return /^\d{2}:\d{2}:\d{2}$/.test(normalizedValue) ? normalizedValue : "";
}

function getCurrentDateTimeParts(timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(new Date()).reduce((accumulator, part) => {
    if (part.type !== "literal") {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return {
    currentDate: `${parts.year || "0000"}-${parts.month || "00"}-${parts.day || "00"}`,
    currentTime: `${parts.hour || "00"}:${parts.minute || "00"}:${parts.second || "00"}`
  };
}

function isCurrentTimeWithinWindow({ currentTime, startTime = "", endTime = "" }) {
  const normalizedCurrentTime = normalizeComboTimeValue(currentTime);
  const normalizedStartTime = normalizeComboTimeValue(startTime);
  const normalizedEndTime = normalizeComboTimeValue(endTime);

  if (!normalizedCurrentTime) {
    return true;
  }

  if (normalizedStartTime && normalizedEndTime) {
    if (normalizedStartTime <= normalizedEndTime) {
      return normalizedCurrentTime >= normalizedStartTime && normalizedCurrentTime <= normalizedEndTime;
    }

    return normalizedCurrentTime >= normalizedStartTime || normalizedCurrentTime <= normalizedEndTime;
  }

  if (normalizedStartTime && normalizedCurrentTime < normalizedStartTime) {
    return false;
  }

  if (normalizedEndTime && normalizedCurrentTime > normalizedEndTime) {
    return false;
  }

  return true;
}

function isComboCurrentlyAvailable(comboSettingsRow = null, timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata") {
  const startDate = normalizeComboDateValue(comboSettingsRow?.start_date);
  const endDate = normalizeComboDateValue(comboSettingsRow?.end_date);
  const startTime = normalizeComboTimeValue(comboSettingsRow?.start_time);
  const endTime = normalizeComboTimeValue(comboSettingsRow?.end_time);
  const { currentDate, currentTime } = getCurrentDateTimeParts(timeZone);

  if (startDate && currentDate < startDate) {
    return false;
  }

  if (endDate && currentDate > endDate) {
    return false;
  }

  if (!startDate && !endDate) {
    return isCurrentTimeWithinWindow({ currentTime, startTime, endTime });
  }

  if (startDate && endDate && startDate === endDate && currentDate === startDate) {
    return isCurrentTimeWithinWindow({ currentTime, startTime, endTime });
  }

  if (startDate && currentDate === startDate && startTime && currentTime < startTime) {
    return false;
  }

  if (endDate && currentDate === endDate && endTime && currentTime > endTime) {
    return false;
  }

  return true;
}

function isMenuComboPresentationCurrentlyAvailable(
  comboPresentation = null,
  timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata"
) {
  if (!comboPresentation || typeof comboPresentation !== "object" || Array.isArray(comboPresentation)) {
    return true;
  }

  return isComboCurrentlyAvailable(
    {
      start_date: comboPresentation.startDate || "",
      end_date: comboPresentation.endDate || "",
      start_time: comboPresentation.startTime || "",
      end_time: comboPresentation.endTime || ""
    },
    timeZone
  );
}

function isMissingMenuComboSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    details.includes("menu_combo_items") ||
    details.includes("menu_combo_settings") ||
    details.includes("item_type")
  );
}

function buildMenuComboPresentationMap({
  hotelSlug,
  menuItems = [],
  comboChildRows = [],
  comboSettingsRows = [],
  childMenuItems = []
}) {
  const normalizedHotelSlug = String(hotelSlug || "").trim();
  const comboMenuItems = (Array.isArray(menuItems) ? menuItems : []).filter(
    (menuItem) => String(menuItem?.item_type || "single").trim() === "combo"
  );

  if (!normalizedHotelSlug || !comboMenuItems.length) {
    return new Map();
  }

  const childMenuItemMap = new Map(
    (Array.isArray(childMenuItems) ? childMenuItems : []).map((childMenuItem) => [
      getMenuComboLookupKey(childMenuItem.hotel_slug, childMenuItem.item_id),
      childMenuItem
    ])
  );

  const comboChildRowsByKey = (comboChildRows || []).reduce((accumulator, comboChildRow) => {
    const comboLookupKey = getMenuComboLookupKey(
      comboChildRow.hotel_slug,
      comboChildRow.combo_item_id
    );

    if (!accumulator.has(comboLookupKey)) {
      accumulator.set(comboLookupKey, []);
    }

    accumulator.get(comboLookupKey).push(comboChildRow);
    return accumulator;
  }, new Map());

  const comboSettingsByKey = (comboSettingsRows || []).reduce((accumulator, comboSettingsRow) => {
    accumulator.set(
      getMenuComboLookupKey(comboSettingsRow.hotel_slug, comboSettingsRow.combo_item_id),
      comboSettingsRow
    );
    return accumulator;
  }, new Map());

  return comboMenuItems.reduce((accumulator, comboMenuItem) => {
    const comboLookupKey = getMenuComboLookupKey(comboMenuItem.hotel_slug, comboMenuItem.item_id);
    const childItems = (comboChildRowsByKey.get(comboLookupKey) || []).map((comboChildRow) => {
      const childMenuItem = childMenuItemMap.get(
        getMenuComboLookupKey(comboChildRow.hotel_slug, comboChildRow.child_item_id)
      );

      return {
        itemId: comboChildRow.child_item_id || "",
        name: childMenuItem?.name || comboChildRow.child_item_id || "",
        quantity: Number(comboChildRow.quantity || 1),
        sortOrder: Number(comboChildRow.sort_order || 0),
        price: Number(childMenuItem?.price || 0),
        category: childMenuItem?.category || "",
        image: childMenuItem?.image || ""
      };
    });
    const originalPrice = childItems.reduce(
      (total, childItem) => total + Number(childItem.price || 0) * Number(childItem.quantity || 0),
      0
    );
    const comboPrice = Number(comboMenuItem.price || 0);
    const comboSettingsRow = comboSettingsByKey.get(comboLookupKey) || null;

    accumulator.set(comboMenuItem.item_id, {
      itemType: "combo",
      comboItems: childItems,
      originalPrice,
      savings: Math.max(0, originalPrice - comboPrice),
      startDate: comboSettingsRow?.start_date || "",
      endDate: comboSettingsRow?.end_date || "",
      startTime: comboSettingsRow?.start_time || "",
      endTime: comboSettingsRow?.end_time || ""
    });
    return accumulator;
  }, new Map());
}

async function fetchMenuComboPresentationMap({ hotelSlug, menuItems = [] }) {
  const normalizedHotelSlug = String(hotelSlug || "").trim();
  const comboMenuItems = (Array.isArray(menuItems) ? menuItems : []).filter(
    (menuItem) => String(menuItem?.item_type || "single").trim() === "combo"
  );

  if (!normalizedHotelSlug || !comboMenuItems.length) {
    return new Map();
  }

  const comboItemIds = comboMenuItems
    .map((menuItem) => String(menuItem?.item_id || "").trim())
    .filter(Boolean);

  const { data: comboChildRows, error: comboChildRowsError } = await supabase
    .from("menu_combo_items")
    .select("*")
    .eq("hotel_slug", normalizedHotelSlug)
    .in("combo_item_id", comboItemIds)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (comboChildRowsError) {
    throw comboChildRowsError;
  }

  const { data: comboSettingsRows, error: comboSettingsRowsError } = await supabase
    .from("menu_combo_settings")
    .select("*")
    .eq("hotel_slug", normalizedHotelSlug)
    .in("combo_item_id", comboItemIds);

  if (comboSettingsRowsError) {
    throw comboSettingsRowsError;
  }

  const childItemIds = [
    ...new Set(
      (comboChildRows || [])
        .map((comboChildRow) => String(comboChildRow?.child_item_id || "").trim())
        .filter(Boolean)
    )
  ];

  let childMenuItems = [];

  if (childItemIds.length) {
    const { data, error: childMenuItemsError } = await supabase
      .from("menu_items")
      .select("hotel_slug,item_id,name,price,category,image,is_available")
      .eq("hotel_slug", normalizedHotelSlug)
      .in("item_id", childItemIds);

    if (childMenuItemsError) {
      throw childMenuItemsError;
    }

    childMenuItems = data || [];
  }

  return buildMenuComboPresentationMap({
    hotelSlug: normalizedHotelSlug,
    menuItems,
    comboChildRows: comboChildRows || [],
    comboSettingsRows: comboSettingsRows || [],
    childMenuItems
  });
}

async function validateRequestedMenuCombos({
  hotelSlug,
  requestedItems = [],
  menuItemRows = [],
  timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata"
}) {
  const normalizedHotelSlug = String(hotelSlug || "").trim();
  const normalizedRequestedItems = Array.isArray(requestedItems) ? requestedItems : [];
  const normalizedMenuItemRows = Array.isArray(menuItemRows) ? menuItemRows : [];
  const comboMenuItems = normalizedMenuItemRows.filter(
    (menuItem) => String(menuItem?.item_type || "single").trim() === "combo"
  );

  if (!normalizedHotelSlug || !normalizedRequestedItems.length || !comboMenuItems.length) {
    return { ok: true };
  }

  const comboItemIds = comboMenuItems
    .map((menuItem) => String(menuItem?.item_id || "").trim())
    .filter(Boolean);

  try {
    const { data: comboChildRows, error: comboChildRowsError } = await supabase
      .from("menu_combo_items")
      .select("hotel_slug,combo_item_id,child_item_id,quantity,sort_order")
      .eq("hotel_slug", normalizedHotelSlug)
      .in("combo_item_id", comboItemIds);

    if (comboChildRowsError) {
      throw comboChildRowsError;
    }

    const { data: comboSettingsRows, error: comboSettingsRowsError } = await supabase
      .from("menu_combo_settings")
      .select("hotel_slug,combo_item_id,start_date,end_date,start_time,end_time")
      .eq("hotel_slug", normalizedHotelSlug)
      .in("combo_item_id", comboItemIds);

    if (comboSettingsRowsError) {
      throw comboSettingsRowsError;
    }

    const comboChildRowsByKey = (comboChildRows || []).reduce((accumulator, comboChildRow) => {
      const comboLookupKey = getMenuComboLookupKey(
        comboChildRow.hotel_slug,
        comboChildRow.combo_item_id
      );

      if (!accumulator.has(comboLookupKey)) {
        accumulator.set(comboLookupKey, []);
      }

      accumulator.get(comboLookupKey).push(comboChildRow);
      return accumulator;
    }, new Map());

    const comboSettingsByKey = (comboSettingsRows || []).reduce((accumulator, comboSettingsRow) => {
      accumulator.set(
        getMenuComboLookupKey(comboSettingsRow.hotel_slug, comboSettingsRow.combo_item_id),
        comboSettingsRow
      );
      return accumulator;
    }, new Map());

    const childItemIds = [
      ...new Set(
        (comboChildRows || [])
          .map((comboChildRow) => String(comboChildRow?.child_item_id || "").trim())
          .filter(Boolean)
      )
    ];

    let childMenuItemsByKey = new Map();

    if (childItemIds.length) {
      const { data: childMenuItems, error: childMenuItemsError } = await supabase
        .from("menu_items")
        .select("hotel_slug,item_id,is_available,is_archived")
        .eq("hotel_slug", normalizedHotelSlug)
        .in("item_id", childItemIds);

      if (childMenuItemsError) {
        throw childMenuItemsError;
      }

      childMenuItemsByKey = new Map(
        (childMenuItems || []).map((childMenuItem) => [
          getMenuComboLookupKey(childMenuItem.hotel_slug, childMenuItem.item_id),
          childMenuItem
        ])
      );
    }

    for (const comboMenuItem of comboMenuItems) {
      const comboLookupKey = getMenuComboLookupKey(comboMenuItem.hotel_slug, comboMenuItem.item_id);
      const childRows = comboChildRowsByKey.get(comboLookupKey) || [];
      const comboSettingsRow = comboSettingsByKey.get(comboLookupKey) || null;

      if (!childRows.length) {
        return {
          ok: false,
          error: `Combo item is unavailable right now: ${comboMenuItem.item_id}`
        };
      }

      if (!isComboCurrentlyAvailable(comboSettingsRow, timeZone)) {
        return {
          ok: false,
          error: `Combo item is outside its active window: ${comboMenuItem.item_id}`
        };
      }

      const unavailableChildIds = childRows
        .map((childRow) => {
          const childMenuItem = childMenuItemsByKey.get(
            getMenuComboLookupKey(childRow.hotel_slug, childRow.child_item_id)
          );

          if (!childMenuItem || childMenuItem.is_available !== true || childMenuItem.is_archived === true) {
            return String(childRow.child_item_id || "").trim();
          }

          return "";
        })
        .filter(Boolean);

      if (unavailableChildIds.length) {
        return {
          ok: false,
          error: `Combo item has unavailable child items: ${comboMenuItem.item_id} (${unavailableChildIds.join(", ")})`
        };
      }
    }

    return { ok: true };
  } catch (error) {
    if (isMissingMenuComboSchemaError(error)) {
      return { ok: true };
    }

    throw error;
  }
}

module.exports = {
  buildMenuComboPresentationMap,
  fetchMenuComboPresentationMap,
  getMenuComboLookupKey,
  isMissingMenuComboSchemaError,
  isMenuComboPresentationCurrentlyAvailable,
  validateRequestedMenuCombos
};
