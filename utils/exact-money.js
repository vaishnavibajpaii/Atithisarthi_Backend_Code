"use strict";

const MONEY_SCALE = 2;
const PERCENT_SCALE = 4;

function toPlainDecimal(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?(?:\d+)(?:\.\d+)?$/.test(text)) {
    throw new TypeError(`${label} must be a plain decimal value`);
  }
  return text;
}

function decimalToScaledInteger(value, scale, label = "decimal") {
  const text = toPlainDecimal(value, label);
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const keptFraction = fractionPart.slice(0, scale).padEnd(scale, "0");
  const discardedFraction = fractionPart.slice(scale);
  let scaled = BigInt(wholePart) * (10n ** BigInt(scale)) + BigInt(keptFraction || "0");

  if (discardedFraction && discardedFraction[0] >= "5") scaled += 1n;
  return negative ? -scaled : scaled;
}

function roundHalfUp(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError("roundHalfUp accepts only non-negative numerators and positive denominators");
  }
  return (numerator + (denominator / 2n)) / denominator;
}

function scaledIntegerToNumber(value, scale) {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = unsigned / divisor;
  const fraction = (unsigned % divisor).toString().padStart(scale, "0");
  const decimal = scale ? `${whole}.${fraction}` : whole.toString();
  return Number(negative ? `-${decimal}` : decimal);
}

function normalizePositiveInteger(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return BigInt(text);
}

function normalizeOrderItemMoney(items = []) {
  return items.map((item, index) => {
    const quantity = normalizePositiveInteger(item?.qty, `items[${index}].qty`);
    const unitPriceMinor = decimalToScaledInteger(item?.price, MONEY_SCALE, `items[${index}].price`);
    if (unitPriceMinor < 0n) throw new RangeError(`items[${index}].price cannot be negative`);
    const lineTotalMinor = unitPriceMinor * quantity;

    return {
      snapshot: {
        ...item,
        qty: Number(quantity),
        price: scaledIntegerToNumber(unitPriceMinor, MONEY_SCALE),
        lineTotal: scaledIntegerToNumber(lineTotalMinor, MONEY_SCALE)
      },
      lineTotalMinor
    };
  });
}

function wholeCurrencyPercentageMinor(amountMinor, percent) {
  const percentScaled = decimalToScaledInteger(percent, PERCENT_SCALE, "percentage");
  if (percentScaled < 0n || percentScaled > 100n * (10n ** BigInt(PERCENT_SCALE))) {
    throw new RangeError("percentage must be between 0 and 100");
  }

  const denominator =
    (10n ** BigInt(MONEY_SCALE)) * 100n * (10n ** BigInt(PERCENT_SCALE));
  const wholeCurrency = roundHalfUp(amountMinor * percentScaled, denominator);
  return wholeCurrency * (10n ** BigInt(MONEY_SCALE));
}

function buildExactOrderFinancialSnapshot({
  items = [],
  gstPercent,
  deliveryCharge = 0,
  upiDiscountPercent = 0,
  includeUpiPolicy = false,
  applyUpiDiscount = false
} = {}) {
  const normalizedItems = normalizeOrderItemMoney(items);
  const subtotalMinor = normalizedItems.reduce(
    (total, item) => total + item.lineTotalMinor,
    0n
  );
  const deliveryMinor = decimalToScaledInteger(deliveryCharge, MONEY_SCALE, "delivery charge");
  if (deliveryMinor < 0n) throw new RangeError("delivery charge cannot be negative");

  const gstMinor = wholeCurrencyPercentageMinor(subtotalMinor, gstPercent);
  const normalTotalMinor = subtotalMinor + gstMinor + deliveryMinor;
  const discountMinor = includeUpiPolicy
    ? wholeCurrencyPercentageMinor(normalTotalMinor, upiDiscountPercent)
    : 0n;
  const payableMinor = applyUpiDiscount
    ? (normalTotalMinor > discountMinor ? normalTotalMinor - discountMinor : 0n)
    : normalTotalMinor;

  const totals = {
    subtotal: scaledIntegerToNumber(subtotalMinor, MONEY_SCALE),
    gst: scaledIntegerToNumber(gstMinor, MONEY_SCALE),
    deliveryCharge: scaledIntegerToNumber(deliveryMinor, MONEY_SCALE),
    gstPercent: scaledIntegerToNumber(
      decimalToScaledInteger(gstPercent, PERCENT_SCALE, "GST percentage"),
      PERCENT_SCALE
    ),
    normalTotal: scaledIntegerToNumber(normalTotalMinor, MONEY_SCALE),
    total: scaledIntegerToNumber(payableMinor, MONEY_SCALE)
  };

  if (includeUpiPolicy) {
    totals.upiDiscountPercent = scaledIntegerToNumber(
      decimalToScaledInteger(upiDiscountPercent, PERCENT_SCALE, "UPI discount percentage"),
      PERCENT_SCALE
    );
  }
  if (applyUpiDiscount) {
    totals.gpayDiscount = scaledIntegerToNumber(discountMinor, MONEY_SCALE);
    totals.gpayFinalTotal = scaledIntegerToNumber(payableMinor, MONEY_SCALE);
  }

  return {
    items: normalizedItems.map((item) => item.snapshot),
    totals
  };
}

module.exports = {
  MONEY_SCALE,
  PERCENT_SCALE,
  buildExactOrderFinancialSnapshot,
  decimalToScaledInteger,
  normalizeOrderItemMoney,
  roundHalfUp,
  scaledIntegerToNumber,
  wholeCurrencyPercentageMinor
};

