const db = require("../config/connectDB");

// ---------------------------------------------------------------------
// Commission rate (settings)
// ---------------------------------------------------------------------

// GET /api/admin/settings/commission-rate
exports.getCommissionRate = async (req, res) => {
  try {
    const rows = await db.query(
      "SELECT value FROM settings WHERE key = 'commission_rate'",
    );
    res.json({ rate: rows.length > 0 ? Number(rows[0].value) : 0 });
  } catch (err) {
    console.error("Error fetching commission rate:", err);
    res
      .status(500)
      .json({ message: "Server error while fetching commission rate." });
  }
};

// PUT /api/admin/settings/commission-rate
exports.updateCommissionRate = async (req, res) => {
  const { rate } = req.body;
  const numericRate = Number(rate);

  if (!Number.isFinite(numericRate) || numericRate < 0 || numericRate > 100) {
    return res
      .status(400)
      .json({ message: "Commission rate must be a number between 0 and 100." });
  }

  try {
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('commission_rate', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(numericRate)],
    );
    res.json({ rate: numericRate });
  } catch (err) {
    console.error("Error updating commission rate:", err);
    res
      .status(500)
      .json({ message: "Server error while updating commission rate." });
  }
};

// ---------------------------------------------------------------------
// Dashboard analytics
// ---------------------------------------------------------------------

// "Revenue" here means money actually collected and kept -- only
// Confirmed bookings count. Pending isn't collected yet; Cancelled and
// Refund Requested either gave the money back or are about to.
const REVENUE_STATUS = "'Confirmed'";

// GET /api/admin/analytics?days=30
exports.getDashboardAnalytics = async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days))
    ? Number(req.query.days)
    : 30;

  try {
    const commissionRows = await db.query(
      "SELECT value FROM settings WHERE key = 'commission_rate'",
    );
    const commissionRate =
      commissionRows.length > 0 ? Number(commissionRows[0].value) : 0;

    const [
      kpiRows,
      revenueOverTimeRows,
      bookingsByStatusRows,
      stayTypeRows,
      topResortRows,
      promoUsageRows,
      reviewSummaryRows,
      lowRatedResortRows,
      recentBookingRows,
      recentReviewRows,
    ] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM bookings) AS total_bookings_all_time,
           (SELECT COUNT(*)::int FROM bookings WHERE created_at >= NOW() - ($1 || ' days')::interval) AS bookings_in_range,
           (SELECT COALESCE(SUM(total_price), 0)::float FROM bookings
             WHERE status = ${REVENUE_STATUS} AND created_at >= NOW() - ($1 || ' days')::interval) AS gross_revenue_in_range,
           (SELECT COUNT(*)::int FROM resorts) AS total_resorts,
           (SELECT COUNT(*)::int FROM users WHERE role != 'admin') AS total_users,
           (SELECT COUNT(*)::int FROM bookings WHERE status = 'Pending' AND payment_method = 'gcash') AS pending_gcash_count,
           (SELECT COUNT(*)::int FROM bookings WHERE status = 'Refund Requested') AS refund_request_count`,
        [days],
      ),

      db.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS date,
                COALESCE(SUM(total_price), 0)::float AS revenue
           FROM bookings
          WHERE status = ${REVENUE_STATUS} AND created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY 1
          ORDER BY 1`,
        [days],
      ),

      db.query(
        `SELECT status, COUNT(*)::int AS count
           FROM bookings
          WHERE created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY status`,
        [days],
      ),

      db.query(
        `SELECT COALESCE(MODE() WITHIN GROUP (ORDER BY stay_type_name), 'Unspecified') AS name,
                COUNT(*)::int AS bookings,
                COALESCE(SUM(total_price), 0)::float AS revenue
           FROM bookings
          WHERE status = ${REVENUE_STATUS} AND created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY LOWER(REGEXP_REPLACE(COALESCE(stay_type_name, ''), '[^a-zA-Z0-9]', '', 'g'))
          ORDER BY revenue DESC`,
        [days],
      ),

      db.query(
        `SELECT r.id, r.name,
                COUNT(b.id)::int AS bookings,
                COALESCE(SUM(b.total_price), 0)::float AS revenue
           FROM bookings b
           JOIN resorts r ON r.id = b.resort_id
          WHERE b.status = ${REVENUE_STATUS} AND b.created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY r.id, r.name
          ORDER BY revenue DESC
          LIMIT 5`,
        [days],
      ),

      db.query(
        `SELECT promo_code AS code,
                COUNT(*)::int AS uses,
                COALESCE(SUM(discount_amount), 0)::float AS total_discount
           FROM bookings
          WHERE promo_code IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY promo_code
          ORDER BY uses DESC`,
        [days],
      ),

      db.query(
        `SELECT COUNT(*)::int AS count, COALESCE(AVG(rating)::float, 0) AS average FROM reviews`,
      ),

      db.query(
        `SELECT r.id, r.name,
                COALESCE(AVG(rev.rating)::float, 0) AS average,
                COUNT(rev.id)::int AS count
           FROM resorts r
           JOIN reviews rev ON rev.resort_id = r.id
          GROUP BY r.id, r.name
         HAVING COALESCE(AVG(rev.rating)::float, 0) < 3.5
          ORDER BY average ASC
          LIMIT 5`,
      ),

      db.query(
        `SELECT b.id, b.full_name AS guest_name, r.name AS resort_name,
                b.status, b.total_price,
                TO_CHAR(b.created_at, 'FMMon FMDD, YYYY FMHH12:MI AM') AS created_at_display
           FROM bookings b
           JOIN resorts r ON r.id = b.resort_id
          ORDER BY b.created_at DESC
          LIMIT 10`,
      ),

      db.query(
        `SELECT rev.id, r.name AS resort_name, rev.rating, rev.comment,
                TO_CHAR(rev.created_at, 'FMMon FMDD, YYYY') AS created_at_display
           FROM reviews rev
           JOIN resorts r ON r.id = rev.resort_id
          ORDER BY rev.created_at DESC
          LIMIT 5`,
      ),
    ]);

    const kpis = kpiRows[0];
    const grossRevenueInRange = kpis.gross_revenue_in_range;
    const alaiehRevenueInRange =
      Math.round(grossRevenueInRange * (commissionRate / 100) * 100) / 100;
    const ownerPayoutsInRange =
      Math.round((grossRevenueInRange - alaiehRevenueInRange) * 100) / 100;

    res.json({
      range: { days },
      commissionRate,
      kpis: {
        totalBookingsAllTime: kpis.total_bookings_all_time,
        bookingsInRange: kpis.bookings_in_range,
        grossRevenueInRange,
        alaiehRevenueInRange,
        ownerPayoutsInRange,
        totalResorts: kpis.total_resorts,
        totalUsers: kpis.total_users,
        pendingGcashCount: kpis.pending_gcash_count,
        refundRequestCount: kpis.refund_request_count,
      },
      revenueOverTime: revenueOverTimeRows,
      bookingsByStatus: bookingsByStatusRows,
      stayTypeBreakdown: stayTypeRows,
      topResorts: topResortRows,
      promoUsage: promoUsageRows,
      reviewSummary: reviewSummaryRows[0],
      lowRatedResorts: lowRatedResortRows,
      recentBookings: recentBookingRows,
      recentReviews: recentReviewRows,
    });
  } catch (err) {
    console.error("Error building dashboard analytics:", err);
    res.status(500).json({ message: "Server error while building analytics." });
  }
};
