"use strict";

const crypto = require("crypto");
const { LEGACY_RAZORPAY_MERCHANT_REF } = require("./payment-domain");

class MockRazorpayAdapter {
  constructor({ merchantRef = LEGACY_RAZORPAY_MERCHANT_REF, secret = "mock_secret" } = {}) {
    this.provider = "razorpay";
    this.merchantRef = merchantRef;
    this.credentialRef = "MOCK_RAZORPAY_V1";
    this.secret = secret;
    this.orders = new Map();
    this.payments = new Map();
    this.createCalls = 0;
    this.timeoutNextCreate = false;
  }

  async createPaymentOrder({ amountMinor, currency = "INR", receipt = "" }) {
    this.createCalls += 1;
    if (this.timeoutNextCreate) {
      this.timeoutNextCreate = false;
      const error = new Error("Provider request outcome is unknown");
      error.code = "PROVIDER_TIMEOUT";
      error.uncertain = true;
      throw error;
    }
    const id = `order_mock_${this.createCalls}`;
    const order = { id, amount: amountMinor, currency, receipt, status: "created" };
    this.orders.set(id, order);
    return {
      provider: this.provider,
      merchantRef: this.merchantRef,
      credentialRef: this.credentialRef,
      gatewayOrderId: id,
      gatewayStatus: "created",
      amountMinor,
      amount: amountMinor / 100,
      currency,
      receipt,
      raw: order
    };
  }

  addPayment({ id, orderId, amountMinor, currency = "INR", status = "created", merchantRef = this.merchantRef }) {
    const payment = {
      id,
      order_id: orderId,
      amount: amountMinor,
      currency,
      status,
      captured: status === "captured",
      merchantRef
    };
    this.payments.set(id, payment);
    return payment;
  }

  async getPaymentStatus(paymentId) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw Object.assign(new Error("Mock payment not found"), { code: "PROVIDER_PAYMENT_NOT_FOUND" });
    return {
      provider: this.provider,
      merchantRef: payment.merchantRef,
      credentialRef: this.credentialRef,
      providerOrderId: payment.order_id,
      providerPaymentId: payment.id,
      amountMinor: payment.amount,
      currency: payment.currency,
      status: payment.status,
      captured: payment.captured,
      raw: payment
    };
  }

  async getOrderPayments(orderId) {
    return [...this.payments.values()].filter((payment) => payment.order_id === orderId);
  }

  verifyCheckoutEvidence({ gatewayOrderId, gatewayPaymentId, gatewaySignature }) {
    const expected = crypto.createHmac("sha256", this.secret)
      .update(`${gatewayOrderId}|${gatewayPaymentId}`).digest("hex");
    return expected === gatewaySignature;
  }

  signCheckout(orderId, paymentId) {
    return crypto.createHmac("sha256", this.secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  verifyWebhook() { return true; }
}

module.exports = { MockRazorpayAdapter };
