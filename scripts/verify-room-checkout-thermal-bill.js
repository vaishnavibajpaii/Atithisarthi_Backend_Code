"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  buildDefaultBillFormat,
  buildFormatRow,
  buildLiveBill,
  getCheckoutBill
} = require("../utils/room-checkout-bill");

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

async function verifyBillMapping() {
  const format = buildDefaultBillFormat(
    {
      hotel_name: "Verified Hotel",
      tagline: "Boutique stay",
      contact: {
        phone: "+91 9999991234",
        email: "stay@example.com",
        website: "https://example.com"
      },
      location: { address: "Verified address" }
    },
    "verified-hotel"
  );

  const source = {
    booking: {
      id: 42,
      hotel_slug: "verified-hotel",
      guest_name: "Guest Person",
      guest_phone: "+91 9999991234",
      guest_email: "guest@example.com",
      guest_id_proof: "ABCD1234",
      check_in_date: "2026-07-15",
      check_out_date: "2026-07-16",
      checked_in_at: "2026-07-15T08:42:13.000Z",
      checked_out_at: "2026-07-16T05:21:09.000Z",
      total_nights: 1,
      booking_status: "checked_in",
      payment_status: "partial"
    },
    room: {
      room_number: "205",
      title: "Deluxe room"
    },
    roomType: { name: "Deluxe King" },
    payments: [
      {
        payment_method: "card",
        payment_status: "paid",
        transaction_id: "txn_12345678",
        amount: 300
      }
    ],
    receipt: null,
    format,
    summary: {
      booking: { roomNumber: "205" },
      roomCharges: {
        roomPrice: 1000,
        taxAmount: 100,
        discountAmount: 50,
        totalAmount: 1050,
        advancePaid: 300,
        balanceAmount: 750
      },
      foodCharges: {
        orders: [
          {
            id: "food-1",
            status: "served",
            paymentMethod: "cash",
            paymentStatus: "unpaid",
            chargeToRoom: true,
            billable: true,
            totalAmount: 250,
            createdAt: "2026-07-15T18:00:00Z",
            source: {
              id: "food-1",
              created_at: "2026-07-15T18:00:00Z",
              items: [{ name: "Dinner", qty: 1, price: 250 }]
            }
          },
          {
            id: "food-cancelled",
            status: "cancelled",
            paymentMethod: "cash",
            paymentStatus: "unpaid",
            chargeToRoom: true,
            billable: false,
            totalAmount: 999,
            source: { items: [{ name: "Cancelled", qty: 1, price: 999 }] }
          },
          {
            id: "food-separate",
            status: "served",
            paymentMethod: "cash",
            paymentStatus: "unpaid",
            chargeToRoom: false,
            billable: true,
            totalAmount: 500,
            source: { items: [{ name: "Separate", qty: 1, price: 500 }] }
          }
        ]
      },
      totals: {
        roomBalanceAmount: 750,
        outstandingChargeToRoomAmount: 250,
        finalPayableAmount: 1000
      }
    }
  };

  const bill = await buildLiveBill(source, {
    id: "owner-1",
    role: "owner",
    displayName: "Owner"
  });

  assert.equal(bill.provisional, true);
  assert.equal(bill.totals.roomSubtotal, 1000);
  assert.equal(bill.totals.foodSubtotal, 250);
  assert.equal(bill.totals.grandTotal, 1300);
  assert.equal(bill.totals.paid, 300);
  assert.equal(bill.totals.balance, 1000);
  assert.equal(bill.lines.filter((line) => line.category === "room_service").length, 1);
  assert.equal(bill.lines.some((line) => line.orderId === "food-cancelled"), false);
  assert.equal(bill.lines.some((line) => line.orderId === "food-separate"), false);
  assert.match(bill.guest.phone, /\*+1234$/);
  assert.match(bill.guest.email, /^g\*\*\*@/);
  assert.match(bill.guest.maskedId, /\*+1234$/);
  assert.equal(bill.generatedFromTrustedSummary, true);
  assert.equal(bill.stay.checkIn, source.booking.checked_in_at);
  assert.equal(bill.stay.checkOut, source.booking.checked_out_at);
  assert.equal(bill.stay.timeZone, process.env.APP_TIMEZONE || "Asia/Kolkata");
}

async function verifyExistingSnapshotLifecycle() {
  const snapshotRow = {
    id: 91,
    hotel_slug: "verified-hotel",
    booking_id: 42,
    invoice_number: null,
    reprint_count: 0,
    snapshot_json: {
      invoiceNumber: "",
      checkoutStatus: "checked_out",
      paymentStatus: "paid",
      stay: { checkIn: "2026-07-15", checkOut: "2026-07-16" }
    }
  };
  const lifecycle = {
    id: 42,
    hotel_slug: "verified-hotel",
    check_in_date: "2026-07-15",
    check_out_date: "2026-07-16",
    checked_in_at: "2026-07-15T08:42:13.000Z",
    checked_out_at: "2026-07-16T05:21:09.000Z"
  };
  const requestedTables = [];
  const supabaseClient = {
    from(table) {
      requestedTables.push(table);
      const data = table === "room_checkout_bill_snapshots" ? snapshotRow : lifecycle;
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data, error: null }; }
      };
    }
  };

  const result = await getCheckoutBill({
    supabaseClient,
    hotelSlug: "verified-hotel",
    bookingId: 42
  });

  assert.equal(result.bill.invoiceNumber, "RCPT-GF-VERIFIED-HOTEL-91");
  assert.equal(result.bill.stay.checkIn, lifecycle.checked_in_at);
  assert.equal(result.bill.stay.checkOut, lifecycle.checked_out_at);
  assert.equal(result.bill.stay.timeZone, process.env.APP_TIMEZONE || "Asia/Kolkata");
  assert.deepEqual(requestedTables, [
    "room_checkout_bill_snapshots",
    "room_bookings"
  ]);
  assert.equal(result.snapshot, true);
}

function verifyFormatSanitization() {
  const row = buildFormatRow(
    "hotel-a",
    {
      companyName: "Hotel\u0000 A",
      paperWidth: "58",
      messages: { footer: "<script>alert(1)</script>" }
    },
    null,
    "owner-a"
  );

  assert.equal(row.hotel_slug, "hotel-a");
  assert.equal(row.paper_width, "58");
  assert.equal(row.company_name, "Hotel  A");
  assert.equal(row.messages_json.footer, "<script>alert(1)</script>");
  assert.equal(typeof row.messages_json.footer, "string");
}

function verifyMigrationContracts() {
  const migration = read("backend/scripts/create-room-checkout-thermal-bill.sql");
  const rollback = read("backend/scripts/rollback-room-checkout-thermal-bill.sql");

  assert.match(migration, /room_checkout_bill_formats_hotel_unique/);
  assert.match(migration, /uq_room_checkout_bill_formats_active_hotel/);
  assert.match(migration, /room_checkout_bill_snapshots_hotel_booking_unique/);
  assert.match(migration, /protect_room_checkout_bill_snapshot/);
  assert.match(migration, /payload_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(migration, /room_checkout_bill_audit/);
  assert.match(migration, /revoke all on table public\.room_checkout_bill_snapshots/);
  assert.match(rollback, /drop table if exists public\.room_checkout_bill_snapshots/);
  assert.doesNotMatch(rollback, /drop table if exists public\.room_bookings/);
  assert.doesNotMatch(rollback, /drop function if exists public\.settle_room_combined_checkout/);
}

function verifyTenantAndPermissionContracts() {
  const staffRoute = read("backend/routes/staff-room-checkout-bill.js");
  const adminRoute = read("backend/routes/admin-room-checkout-bill.js");
  const factory = read("backend/routes/create-room-checkout-bill-router.js");

  assert.match(staffRoute, /requireStaffManagerAccess/);
  assert.match(staffRoute, /\.eq\("hotel_slug", hotelSlug\)/);
  assert.match(adminRoute, /resolveAdminBookingHotelSlug/);
  assert.match(factory, /resolvePropertyStorageScope\(supabaseClient, hotelSlug\)/);
  assert.match(factory, /buildPropertyStoragePath\([\s\S]*propertyScope,[\s\S]*"room-checkout-bill"/);
  assert.match(factory, /isPropertyStoragePath\([\s\S]*allowLegacy: true/);
  assert.match(factory, /getImageDimensions/);
  assert.match(factory, /Logo must be 2 MB or smaller/);
  assert.match(factory, /validateBody\(roomCheckoutBillReprintSchema\)/);
  assert.match(factory, /bill_reprinted|reprintCheckoutBill/);
}

function verifyFrontendContracts() {
  const renderer = read("frontend/js/room-checkout-receipt.js");
  const styles = read("frontend/css/room-checkout-receipt.css");
  const staff = read("frontend/js/staff-orders.js");
  const admin = read("frontend/js/admin.js");
  const staffHtml = read("frontend/staff-orders.html");
  const adminHtml = read("frontend/admin.html");

  assert.match(renderer, /HOTEL CHECKOUT BILL \/ GUEST FOLIO/);
  assert.match(renderer, /Print \/ Download PDF/);
  assert.match(renderer, /data-room-checkout-reprint/);
  assert.match(renderer, /hasRecordedTime\(stay\.checkIn\)/);
  assert.match(renderer, /hasRecordedTime\(stay\.checkOut\)/);
  assert.match(renderer, /stay\.timeZone/);
  const billUtility = read("backend/utils/room-checkout-bill.js");
  assert.match(billUtility, /RCPT-GF-\$\{getHotelToken\(row\.hotel_slug\)\}-\$\{row\.id\}/);
  assert.match(billUtility, /booking\?\.checked_in_at/);
  assert.match(billUtility, /booking\?\.checked_out_at/);
  assert.match(styles, /\.room-receipt-paper\.is-58mm/);
  assert.match(styles, /@media print/);
  assert.match(styles, /break-inside: avoid/);
  assert.match(staff, /roomCheckoutBills/);
  assert.match(staff, /room-checkout-bill\/bookings/);
  assert.match(admin, /roomCheckoutBills/);
  assert.match(admin, /room-checkout-bill\/bookings/);
  assert.match(staffHtml, /room-checkout-receipt\.css/);
  assert.match(staffHtml, /room-checkout-bill-settings\.js/);
  assert.match(adminHtml, /room-checkout-receipt\.css/);
}

async function main() {
  await verifyBillMapping();
  await verifyExistingSnapshotLifecycle();
  verifyFormatSanitization();
  verifyMigrationContracts();
  verifyTenantAndPermissionContracts();
  verifyFrontendContracts();
  console.log("Room checkout thermal bill verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
