const db = require("../config/connectDB");
const sendEmail = require("../utils/sendEmail");
const tplApproved = require("../templates/bookingApproved");
const tplCancelled = require("../templates/bookingCancelled");
const tplRefundRequested = require("../templates/refundRequested");
const tplRefundApproved = require("../templates/refundApproved");
const tplRefundDenied = require("../templates/refundDenied");
const tplOwnerNewBooking = require("../templates/ownerNewBooking");
const tplOwnerBookingCancelled = require("../templates/ownerBookingCancelled");
const {
  ordersController,
  paymentsController,
} = require("../utils/paypalClient");
const { notifyUser, notifyAdmin } = require("../utils/notify");

const ADMIN_EMAIL = "alai.eh2526@gmail.com";

// Emails the resort owner: 'new_booking' once a booking actually goes
// Confirmed (so they know to expect a guest), or 'cancelled' when a
// booking they were previously told about falls through. Silently does
// nothing if this resort has no owner_email on file yet.
const notifyResortOwner = async (bookingId, event) => {
  const rows = await db.query(
    `SELECT b.full_name AS guest_name,
            b.stay_type_name,
            TO_CHAR(b.check_in,  'FMMonth FMDD, YYYY "at" FMHH12:MI AM') AS "checkIn",
            TO_CHAR(b.check_out, 'FMMonth FMDD, YYYY "at" FMHH12:MI AM') AS "checkOut",
            b.adults,
            b.children,
            r.name AS resort,
            r.owner_name,
            r.owner_email
       FROM bookings b
       JOIN resorts r ON r.id = b.resort_id
      WHERE b.id = $1`,
    [bookingId],
  );

  const booking = rows[0];
  if (!booking || !booking.owner_email) return;

  const data = {
    owner_name: booking.owner_name || "there",
    resort: booking.resort,
    guest_name: booking.guest_name,
    stay_type_name: booking.stay_type_name,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    adults: booking.adults,
    children: booking.children,
  };

  const subject =
    event === "new_booking"
      ? `New booking at ${booking.resort}! 🎉`
      : `Booking update: a stay at ${booking.resort} was cancelled`;
  const html =
    event === "new_booking"
      ? tplOwnerNewBooking(data)
      : tplOwnerBookingCancelled(data);

  try {
    await sendEmail(booking.owner_email, subject, html);
    console.log(`✅ Owner ${event} email sent to ${booking.owner_email}`);
  } catch (err) {
    console.error("❌ Owner email error:", err);
  }
};

// Shared by admin approval (updateBookingStatus) and automatic PayPal
// confirmation (capturePaypalOrder) -- both need to send the same emails
// and notifications. previousStatus lets the Cancelled branch know
// whether the resort owner was ever told about this booking in the first
// place (only Confirmed bookings trigger an owner email).
const sendBookingStatusEmail = async (
  bookingId,
  status,
  previousStatus = null,
) => {
  const rows = await db.query(
    `SELECT b.id,
            b.user_id,
            b.stay_type_name,
            TO_CHAR(b.check_in,  'FMMonth FMDD, YYYY "at" FMHH12:MI AM') AS "checkIn",
            TO_CHAR(b.check_out, 'FMMonth FMDD, YYYY "at" FMHH12:MI AM') AS "checkOut",
            b.adults,
            b.children,
            b.full_name,
            ud.email,
            ud.username,
            r.name AS resort
       FROM bookings b
       JOIN users ud ON ud.id = b.user_id
       JOIN resorts r ON r.id = b.resort_id
      WHERE b.id = $1`,
    [bookingId],
  );

  const booking = rows[0];
  if (!booking) return;

  let subject, html, notifyType, notifyTitle, notifyMessage;
  if (status === "Confirmed") {
    subject = "Your booking is confirmed! 🎉";
    html = tplApproved({
      full_name: booking.full_name,
      resort: booking.resort,
      stay_type_name: booking.stay_type_name,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      adults: booking.adults,
      children: booking.children,
    });
    notifyType = "booking_confirmed";
    notifyTitle = "Booking confirmed";
    notifyMessage = `Your booking at ${booking.resort} is confirmed.`;
    notifyResortOwner(bookingId, "new_booking");
  } else if (status === "Cancelled") {
    subject = "Your booking has been cancelled";
    html = tplCancelled({
      full_name: booking.full_name,
      resort: booking.resort,
    });
    notifyType = "booking_cancelled";
    notifyTitle = "Booking cancelled";
    notifyMessage = `Your booking at ${booking.resort} has been cancelled.`;
    if (previousStatus === "Confirmed") {
      notifyResortOwner(bookingId, "cancelled");
    }
  }

  if (!html) return;

  notifyUser(booking.user_id, {
    type: notifyType,
    title: notifyTitle,
    message: notifyMessage,
    link: `/viewMyBooking/${booking.id}`,
  });

  try {
    await sendEmail(booking.email, subject, html);
    console.log(`✅ ${status} email sent to ${booking.email}`);
  } catch (err) {
    console.error("❌ Email error:", err);
  }
};

// Fetches the bits every refund-related email/notification needs.
const getBookingForEmail = async (bookingId) => {
  const rows = await db.query(
    `SELECT b.id, b.user_id, b.payment_method, b.full_name, ud.email, r.name AS resort
       FROM bookings b
       JOIN users ud ON ud.id = b.user_id
       JOIN resorts r ON r.id = b.resort_id
      WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0];
};

// Attempts a full refund of a PayPal capture. Never throws -- returns a
// result object so callers can decide how to handle a failed refund
// (e.g. still let the cancellation go through, just flag it for the admin).
const refundPaypalPayment = async (captureId, note) => {
  try {
    const { result } = await paymentsController.refundCapturedPayment({
      captureId,
      body: { noteToPayer: note || "Refund approved by ALAI-eh." },
    });
    return { success: true, refundId: result.id };
  } catch (err) {
    console.error("PayPal refund error:", err);
    return { success: false, error: err.message || "Refund failed" };
  }
};

exports.getTotalBookings = async (req, res) => {
  try {
    const results = await db.query(
      "SELECT COUNT(*) AS \"totalBookings\" FROM bookings WHERE status = 'Confirmed'",
    );
    res.json({ totalBookings: Number(results[0].totalBookings) });
  } catch (err) {
    console.error("Error fetching total bookings:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// GET /api/resorts/:resortId/booked-dates
// Public -- powers the real-time availability calendar on the Booking page.
// This is a private resort, so booking it blocks the whole property, not
// just one room -- availability depends only on the resort, not on any
// specific room. Returns each active booking's [check_in, check_out)
// range; the frontend expands these into individual disabled dates.
exports.getResortBookedDates = async (req, res) => {
  const { resortId } = req.params;

  try {
    // Full timestamps now, not just dates -- the frontend needs exact
    // check-in/check-out times to apply the same 2-hour buffer rule the
    // server enforces at booking time.
    const rows = await db.query(
      `SELECT TO_CHAR(check_in, 'YYYY-MM-DD HH24:MI:SS') AS check_in,
              TO_CHAR(check_out, 'YYYY-MM-DD HH24:MI:SS') AS check_out
         FROM bookings
        WHERE resort_id = $1
          AND status IN ('Pending', 'Confirmed', 'Refund Requested')
          AND check_out >= NOW() - INTERVAL '1 day'`,
      [resortId],
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching resort booked dates:", err);
    res
      .status(500)
      .json({ message: "Server error while fetching availability." });
  }
};

exports.submitBooking = async (req, res) => {
  const {
    resortId,
    stayTypeId,
    date,
    fullName,
    email,
    mobile,
    address,
    adults,
    children,
  } = req.body;

  const userId = req.userId;

  if (!date) {
    return res.status(400).json({ message: "Please select a date." });
  }

  try {
    // Stay type's price and times always come from the DB, never the
    // client -- a request could otherwise be tampered with to book at any
    // price or time.
    const stayTypeRows = await db.query(
      `SELECT id, name, check_in_time, check_out_time, spans_next_day, price
         FROM stay_types WHERE id = $1 AND resort_id = $2`,
      [stayTypeId, resortId],
    );

    if (stayTypeRows.length === 0) {
      return res
        .status(400)
        .json({ message: "Please select a valid stay type." });
    }

    const stayType = stayTypeRows[0];

    // Computed as plain strings (never materialized as JS Date objects)
    // so nothing here can drift across a timezone conversion -- the exact
    // bug that caused the earlier calendar off-by-one issue.
    const computedRows = await db.query(
      `SELECT
         TO_CHAR($1::date + $2::time, 'YYYY-MM-DD HH24:MI:SS') AS check_in,
         TO_CHAR($1::date + ($3::int * INTERVAL '1 day') + $4::time, 'YYYY-MM-DD HH24:MI:SS') AS check_out`,
      [
        date,
        stayType.check_in_time,
        stayType.spans_next_day ? 1 : 0,
        stayType.check_out_time,
      ],
    );
    const checkInStr = computedRows[0].check_in;
    const checkOutStr = computedRows[0].check_out;

    // Guards against double-booking, with a 2-hour cleaning buffer: two
    // bookings only conflict if there's LESS than a 2-hour gap between one
    // ending and the other starting. This is a private resort -- one
    // booking holds the whole property, so this checks resort_id, not a
    // specific room or stay type. Anything not Cancelled still holds the
    // resort -- including Pending, since two people could otherwise both
    // "book" the same slot while one is still on the payment step.
    const overlapRows = await db.query(
      `SELECT id FROM bookings
        WHERE resort_id = $1
          AND status IN ('Pending', 'Confirmed', 'Refund Requested')
          AND check_out + INTERVAL '2 hours' > $2::timestamp
          AND $3::timestamp + INTERVAL '2 hours' > check_in`,
      [resortId, checkInStr, checkOutStr],
    );

    if (overlapRows.length > 0) {
      return res.status(409).json({
        message:
          "Sorry, this resort is no longer available for that date and stay type. Please choose a different date.",
      });
    }

    const totalPrice = Number(stayType.price);

    const sql = `
      INSERT INTO bookings
      (user_id, resort_id, stay_type_id, stay_type_name, full_name, email, mobile, address, check_in, check_out, adults, children, total_price, original_price)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp, $10::timestamp, $11, $12, $13, $13)
      RETURNING id
    `;

    const values = [
      userId,
      resortId,
      stayType.id,
      stayType.name,
      fullName,
      email,
      mobile,
      address,
      checkInStr,
      checkOutStr,
      adults,
      children,
      totalPrice,
    ];

    const result = await db.query(sql, values);

    res.status(201).json({
      message: "Booking submitted successfully",
      bookingId: result[0].id,
      totalPrice,
    });
  } catch (err) {
    console.error("Booking insert error:", err);
    res.status(500).json({ message: "Database error" });
  }
};

exports.getAllBookings = async (req, res) => {
  const sql = `
    SELECT
      bookings.id AS booking_id,
      users.username,
      resorts.name AS resort_name,
      bookings.stay_type_name,
      bookings.check_in,
      bookings.check_out,
      TO_CHAR(bookings.check_in,  'FMMon FMDD, YYYY FMHH12:MI AM') AS check_in_display,
      TO_CHAR(bookings.check_out, 'FMMon FMDD, YYYY FMHH12:MI AM') AS check_out_display,
      bookings.total_price,
      bookings.payment_method,
      (
        bookings.total_price <= 0
        OR COALESCE(bookings.receipt, '') <> ''
        OR bookings.paypal_capture_id IS NOT NULL
      ) AS payment_ready,
      bookings.cancellation_reason,
      bookings.status
    FROM bookings
    JOIN users ON bookings.user_id = users.id
    JOIN resorts ON bookings.resort_id = resorts.id
    ORDER BY bookings.created_at DESC
  `;

  try {
    const results = await db.query(sql);
    res.json(results);
  } catch (err) {
    console.error("Error fetching bookings:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Admin-only "Refund Requests" tab: just the bookings awaiting a decision.
exports.getRefundRequests = async (req, res) => {
  const sql = `
    SELECT
      bookings.id AS booking_id,
      users.username,
      resorts.name AS resort_name,
      bookings.stay_type_name,
      bookings.check_in,
      bookings.check_out,
      TO_CHAR(bookings.check_in,  'FMMon FMDD, YYYY FMHH12:MI AM') AS check_in_display,
      TO_CHAR(bookings.check_out, 'FMMon FMDD, YYYY FMHH12:MI AM') AS check_out_display,
      bookings.total_price,
      bookings.payment_method,
      bookings.cancellation_reason,
      bookings.status
    FROM bookings
    JOIN users ON bookings.user_id = users.id
    JOIN resorts ON bookings.resort_id = resorts.id
    WHERE bookings.status = 'Refund Requested'
    ORDER BY bookings.created_at ASC
  `;

  try {
    const results = await db.query(sql);
    res.json(results);
  } catch (err) {
    console.error("Error fetching refund requests:", err);
    res.status(500).json({ message: "Database error" });
  }
};

exports.getRefundRequestCount = async (req, res) => {
  try {
    const results = await db.query(
      "SELECT COUNT(*) AS \"count\" FROM bookings WHERE status = 'Refund Requested'",
    );
    res.json({ count: Number(results[0].count) });
  } catch (err) {
    console.error("Error counting refund requests:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// A GCash booking sits at Pending until an admin manually checks the
// uploaded receipt and confirms it -- unlike PayPal, which auto-confirms.
// This badge exists to make sure those don't get missed. It clears itself
// naturally once the admin approves (-> Confirmed) or the booking is no
// longer Pending for any other reason.
exports.getGcashPendingCount = async (req, res) => {
  try {
    const results = await db.query(
      "SELECT COUNT(*) AS \"count\" FROM bookings WHERE status = 'Pending' AND payment_method = 'gcash'",
    );
    res.json({ count: Number(results[0].count) });
  } catch (err) {
    console.error("Error counting pending GCash bookings:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.uploadPaymentReceipt = async (req, res) => {
  const { bookingId } = req.body;
  const receiptImage = req.file.path;

  if (!bookingId || !receiptImage) {
    return res
      .status(400)
      .json({ message: "Missing bookingId or receipt file." });
  }

  try {
    const result = await db.query(
      "UPDATE bookings SET receipt = $1, payment_method = 'gcash' WHERE id = $2 AND user_id = $3 RETURNING id",
      [receiptImage, bookingId, req.userId],
    );

    if (result.length === 0) {
      return res.status(404).json({ message: "Booking not found." });
    }

    return res.status(200).json({ message: "Receipt uploaded successfully!" });
  } catch (err) {
    console.error("Receipt upload error:", err);
    return res.status(500).json({ message: "Database error" });
  }
};

exports.getBookingById = async (req, res) => {
  const bookingId = req.params.id;

  // Admins can view any booking; regular users only their own.
  const sql =
    req.userRole === "admin"
      ? `SELECT b.*, r.name AS resort_name,
                TO_CHAR(b.check_in,  'FMMon FMDD, YYYY FMHH12:MI AM') AS check_in_display,
                TO_CHAR(b.check_out, 'FMMon FMDD, YYYY FMHH12:MI AM') AS check_out_display
           FROM bookings b JOIN resorts r ON b.resort_id = r.id WHERE b.id = $1`
      : `SELECT b.*, r.name AS resort_name,
                TO_CHAR(b.check_in,  'FMMon FMDD, YYYY FMHH12:MI AM') AS check_in_display,
                TO_CHAR(b.check_out, 'FMMon FMDD, YYYY FMHH12:MI AM') AS check_out_display
           FROM bookings b JOIN resorts r ON b.resort_id = r.id WHERE b.id = $1 AND b.user_id = $2`;

  const params =
    req.userRole === "admin" ? [bookingId] : [bookingId, req.userId];

  try {
    const results = await db.query(sql, params);

    if (results.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.status(200).json(results[0]);
  } catch (err) {
    console.error("Error fetching booking:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Why a booking can't be approved yet, or null if payment is in order.
// Approval requires real evidence of payment: a captured PayPal payment
// or an uploaded GCash receipt. A fully discounted (0-peso) booking has
// nothing to pay, so it's allowed through.
function getApprovalBlocker(b) {
  if (Number(b.total_price) <= 0) return null;

  if (b.payment_method === "paypal") {
    return b.paypal_capture_id
      ? null
      : {
          code: "PAYPAL_NOT_COMPLETED",
          message:
            "The guest started a PayPal payment but it was never completed. The booking can't be approved until the payment succeeds.",
        };
  }

  if (b.receipt) return null; // GCash receipt uploaded

  if (b.payment_method === "gcash") {
    return {
      code: "GCASH_RECEIPT_MISSING",
      message:
        "This booking is marked as GCash but no payment receipt has been uploaded yet.",
    };
  }

  return {
    code: "NO_PAYMENT",
    message:
      "The guest hasn't paid yet. There is no successful payment or uploaded GCash receipt for this booking.",
  };
}

exports.updateBookingStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = ["Confirmed", "Cancelled", "Pending"];
  if (!allowed.includes(status))
    return res.status(400).json({ error: "Invalid status" });

  try {
    const existingRows = await db.query(
      "SELECT status, payment_method, paypal_capture_id, paypal_refund_id, total_price, receipt FROM bookings WHERE id = $1",
      [id],
    );
    if (existingRows.length === 0)
      return res.status(404).json({ error: "Booking not found" });

    const existing = existingRows[0];

    // Never confirm a booking that hasn't actually been paid for.
    if (status === "Confirmed" && existing.status !== "Confirmed") {
      const blocker = getApprovalBlocker(existing);
      if (blocker) {
        return res
          .status(409)
          .json({ error: blocker.message, code: blocker.code });
      }
    }

    let refundOutcome = null;

    // If an admin directly cancels a booking that was actually paid via
    // PayPal (not just going through the request-refund flow), refund it
    // automatically too, so money never stays captured on a cancelled stay.
    if (
      status === "Cancelled" &&
      existing.payment_method === "paypal" &&
      existing.paypal_capture_id &&
      !existing.paypal_refund_id
    ) {
      refundOutcome = await refundPaypalPayment(
        existing.paypal_capture_id,
        "Booking cancelled by ALAI-eh.",
      );
    }

    if (refundOutcome?.success) {
      await db.query(
        "UPDATE bookings SET status = $1, paypal_refund_id = $2, refunded_at = NOW() WHERE id = $3",
        [status, refundOutcome.refundId, id],
      );
    } else {
      await db.query("UPDATE bookings SET status = $1 WHERE id = $2", [
        status,
        id,
      ]);
    }

    sendBookingStatusEmail(id, status, existing.status);

    res.json({
      message: `Booking ${status}`,
      refunded: !!refundOutcome?.success,
      refundError:
        refundOutcome && !refundOutcome.success
          ? refundOutcome.error
          : undefined,
    });
  } catch (err) {
    console.error("Error updating booking status:", err);
    res.status(500).json({ error: "Failed to update booking status" });
  }
};

exports.getUserBooking = async (req, res) => {
  const userId = req.params.userId;

  // Users may only list their own bookings; admins can look up anyone's.
  if (req.userRole !== "admin" && Number(userId) !== Number(req.userId)) {
    return res
      .status(403)
      .json({ error: "Not authorized to view these bookings." });
  }

  const query = `
    SELECT
      b.id,
      b.resort_id,
      r.name AS resort_name,
      b.stay_type_name,
      b.check_in,
      b.check_out,
      TO_CHAR(b.check_in,  'FMMon FMDD, YYYY FMHH12:MI AM') AS check_in_display,
      TO_CHAR(b.check_out, 'FMMon FMDD, YYYY FMHH12:MI AM') AS check_out_display,
      b.adults,
      b.children,
      b.total_price,
      b.payment_method,
      b.status,
      b.cancellation_reason,
      b.refund_decision_note,
      b.created_at,
      (rev.id IS NOT NULL) AS has_review
    FROM bookings b
    JOIN resorts r ON b.resort_id = r.id
    LEFT JOIN reviews rev ON rev.booking_id = b.id
    WHERE b.user_id = $1 AND b.hidden_by_user = FALSE
    ORDER BY b.created_at DESC
  `;

  try {
    const results = await db.query(query, [userId]);
    res.json(results);
  } catch (err) {
    console.error("Error fetching bookings:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Users may delete their own Pending/Cancelled bookings (see MyBooking.jsx --
// Confirmed/Refund Requested bookings are never offered a delete button,
// but this is enforced here too, not just hidden in the UI).
// "Deletes" a booking from the customer's own list. This is a soft delete
// (hidden_by_user flag), not a real row DELETE, on purpose:
//   1. A real DELETE cascades and wipes out any review left for this
//      booking (reviews.booking_id references bookings.id ON DELETE CASCADE).
//   2. Admin reporting/analytics still needs the full booking history,
//      including ones a customer has since removed from their own view.
//
// Only offered once a booking is "settled": Cancelled, or a Confirmed stay
// that has already happened (check-out date passed). Pending bookings are
// excluded -- those should be cancelled first, not hidden while still active.
exports.deleteBooking = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `UPDATE bookings SET hidden_by_user = TRUE
       WHERE id = $1 AND user_id = $2
         AND (status = 'Cancelled' OR (status = 'Confirmed' AND check_out < CURRENT_DATE))
       RETURNING id`,
      [id, req.userId],
    );
    if (result.length === 0)
      return res
        .status(404)
        .json({ error: "Booking not found or cannot be deleted." });

    res.json({ message: "Booking removed from your list." });
  } catch (err) {
    console.error("Error deleting booking:", err);
    res.status(500).json({ error: "Failed to delete booking" });
  }
};

// User cancels an unpaid (Pending) booking outright -- no money was ever
// confirmed received, so there's nothing to refund.
exports.userCancelBooking = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (status !== "Cancelled") {
    return res.status(400).json({ error: "Users can only cancel bookings" });
  }

  try {
    const result = await db.query(
      "UPDATE bookings SET status = $1 WHERE id = $2 AND user_id = $3 AND status = 'Pending' RETURNING id",
      [status, id, req.userId],
    );

    if (result.length === 0) {
      return res
        .status(404)
        .json({ error: "Booking not found or cannot be cancelled directly" });
    }

    sendBookingStatusEmail(id, status, "Pending");

    res.json({ message: "Booking cancelled successfully" });
  } catch (err) {
    console.error("Error cancelling booking:", err);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
};

// User requests to cancel/refund a Confirmed (paid, stay not yet over) or
// Pending booking -- does NOT cancel or refund anything by itself, just
// flags it for admin review. Pending is included because a GCash receipt
// may already have been uploaded and paid before admin gets to confirm it,
// so an outright, unreviewed cancel isn't safe there either. A Confirmed
// booking whose check-out date has already passed is excluded -- there's
// nothing left to cancel once the stay happened.
exports.requestRefund = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const result = await db.query(
      `UPDATE bookings
          SET status = 'Refund Requested', pre_refund_status = status, cancellation_reason = $1
        WHERE id = $2 AND user_id = $3
          AND (status = 'Pending' OR (status = 'Confirmed' AND check_out >= CURRENT_DATE))
        RETURNING id`,
      [reason || null, id, req.userId],
    );

    if (result.length === 0) {
      return res.status(404).json({
        error:
          "Booking not found, not yours, or not eligible for a refund request.",
      });
    }

    const booking = await getBookingForEmail(id);
    if (booking) {
      notifyUser(booking.user_id, {
        type: "refund_requested",
        title: "Refund request submitted",
        message: `We received your cancellation/refund request for ${booking.resort}.`,
        link: `/viewMyBooking/${id}`,
      });

      notifyAdmin({
        type: "refund_requested",
        title: "New cancellation/refund request",
        message: `${booking.full_name} requested a refund for booking #${id} (${booking.resort}).`,
        link: `/adminDashboard/refund-requests`,
      });

      sendEmail(
        ADMIN_EMAIL,
        `Cancel/refund request -- Booking #${id}`,
        tplRefundRequested({
          bookingId: id,
          full_name: booking.full_name,
          resort: booking.resort,
          reason,
        }),
      ).catch((err) =>
        console.error("❌ Admin notification email error:", err),
      );
    }

    res.json({
      message: "Cancellation/refund request submitted. Awaiting admin review.",
    });
  } catch (err) {
    console.error("Error requesting refund:", err);
    res.status(500).json({ error: "Failed to submit refund request" });
  }
};

// Admin approves a pending refund request: refunds via PayPal automatically
// if that's how it was paid, otherwise leaves it for manual GCash refund.
exports.approveRefund = async (req, res) => {
  const { id } = req.params;
  const { decisionNote } = req.body;

  try {
    const rows = await db.query(
      "SELECT payment_method, paypal_capture_id, pre_refund_status FROM bookings WHERE id = $1 AND status = 'Refund Requested'",
      [id],
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "No pending refund request found for this booking." });
    }

    const booking = rows[0];
    let refundOutcome = null;

    if (booking.payment_method === "paypal" && booking.paypal_capture_id) {
      refundOutcome = await refundPaypalPayment(
        booking.paypal_capture_id,
        decisionNote,
      );

      if (!refundOutcome.success) {
        return res.status(502).json({
          error: `Refund could not be processed via PayPal: ${refundOutcome.error}. The booking has not been changed -- please try again or handle it manually in the PayPal dashboard.`,
        });
      }
    }

    await db.query(
      `UPDATE bookings
          SET status = 'Cancelled',
              refund_decision_note = $1,
              paypal_refund_id = COALESCE($2, paypal_refund_id),
              refunded_at = NOW(),
              pre_refund_status = NULL
        WHERE id = $3`,
      [decisionNote || null, refundOutcome?.refundId || null, id],
    );

    if (booking.pre_refund_status === "Confirmed") {
      notifyResortOwner(id, "cancelled");
    }

    const emailData = await getBookingForEmail(id);
    if (emailData) {
      notifyUser(emailData.user_id, {
        type: "refund_approved",
        title: "Refund approved",
        message: `Your refund for ${emailData.resort} has been approved.`,
        link: `/viewMyBooking/${id}`,
      });

      sendEmail(
        emailData.email,
        "Your refund has been approved",
        tplRefundApproved({
          full_name: emailData.full_name,
          resort: emailData.resort,
          paymentMethod: emailData.payment_method,
          decisionNote,
        }),
      ).catch((err) => console.error("❌ Refund-approved email error:", err));
    }

    res.json({
      message: "Refund approved and processed.",
      refunded: !!refundOutcome?.success,
    });
  } catch (err) {
    console.error("Error approving refund:", err);
    res.status(500).json({ error: "Failed to approve refund" });
  }
};

// Admin denies a pending refund request: booking reverts to Confirmed.
exports.denyRefund = async (req, res) => {
  const { id } = req.params;
  const { decisionNote } = req.body;

  try {
    const result = await db.query(
      `UPDATE bookings
          SET status = COALESCE(pre_refund_status, 'Confirmed'),
              refund_decision_note = $1,
              pre_refund_status = NULL
        WHERE id = $2 AND status = 'Refund Requested'
        RETURNING id, status`,
      [decisionNote || null, id],
    );

    if (result.length === 0) {
      return res
        .status(404)
        .json({ error: "No pending refund request found for this booking." });
    }

    const restoredStatus = result[0].status;

    const emailData = await getBookingForEmail(id);
    if (emailData) {
      notifyUser(emailData.user_id, {
        type: "refund_denied",
        title: "Refund request denied",
        message: `Your refund request for ${emailData.resort} was denied. The booking remains ${restoredStatus.toLowerCase()}.`,
        link: `/viewMyBooking/${id}`,
      });

      sendEmail(
        emailData.email,
        "Update on your cancellation/refund request",
        tplRefundDenied({
          full_name: emailData.full_name,
          resort: emailData.resort,
          decisionNote,
        }),
      ).catch((err) => console.error("❌ Refund-denied email error:", err));
    }

    res.json({
      message: `Refund request denied. Booking remains ${restoredStatus.toLowerCase()}.`,
    });
  } catch (err) {
    console.error("Error denying refund:", err);
    res.status(500).json({ error: "Failed to deny refund request" });
  }
};

// ---------------------------------------------------------------------
// PayPal checkout
// ---------------------------------------------------------------------

exports.createPaypalOrder = async (req, res) => {
  const { bookingId } = req.body;

  try {
    const rows = await db.query(
      "SELECT id, total_price, status FROM bookings WHERE id = $1 AND user_id = $2",
      [bookingId, req.userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Booking not found." });
    }

    const booking = rows[0];

    if (booking.status === "Confirmed") {
      return res.status(400).json({ message: "This booking is already paid." });
    }

    const { result } = await ordersController.createOrder({
      body: {
        intent: "CAPTURE",
        purchaseUnits: [
          {
            referenceId: String(booking.id),
            customId: String(booking.id),
            description: `ALAI-eh booking #${booking.id}`,
            amount: {
              currencyCode: "PHP",
              value: Number(booking.total_price).toFixed(2),
            },
          },
        ],
      },
    });

    res.json({ orderID: result.id });
  } catch (err) {
    console.error("PayPal create order error:", err);
    res.status(500).json({ message: "Failed to create PayPal order." });
  }
};

exports.capturePaypalOrder = async (req, res) => {
  const { orderID, bookingId } = req.body;

  try {
    const rows = await db.query(
      "SELECT id, status FROM bookings WHERE id = $1 AND user_id = $2",
      [bookingId, req.userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Booking not found." });
    }

    // Guard against double-processing (e.g. a page refresh after paying).
    if (rows[0].status === "Confirmed") {
      return res.json({
        message: "Booking already confirmed.",
        alreadyConfirmed: true,
      });
    }

    const { result } = await ordersController.captureOrder({
      id: orderID,
      body: {},
    });

    if (result.status !== "COMPLETED") {
      return res.status(400).json({ message: "Payment was not completed." });
    }

    const captureId =
      result.purchaseUnits?.[0]?.payments?.captures?.[0]?.id || null;

    await db.query(
      "UPDATE bookings SET status = 'Confirmed', payment_method = 'paypal', paypal_order_id = $1, paypal_capture_id = $2 WHERE id = $3",
      [orderID, captureId, bookingId],
    );

    sendBookingStatusEmail(bookingId, "Confirmed");

    res.json({ message: "Payment captured, booking confirmed!" });
  } catch (err) {
    console.error("PayPal capture order error:", err);
    res.status(500).json({ message: "Failed to capture PayPal payment." });
  }
};
