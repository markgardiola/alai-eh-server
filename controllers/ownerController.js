const bcrypt = require("bcrypt");
const crypto = require("crypto");
const db = require("../config/connectDB");
const sendEmail = require("../utils/sendEmail");
const tplOwnerAccountCreated = require("../templates/ownerAccountCreated");

const CLIENT_URL =
  process.env.CLIENT_URL || "https://alai-eh-booking.vercel.app";

const generateTempPassword = () =>
  crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 10);

// Called from resortController on create/update. Looks up (or creates) the
// resort_owners account matching this email, and returns its id so the
// resort can be linked to it via resorts.owner_user_id. A brand-new
// account gets a temp password emailed to them; an existing one is left
// untouched (so listing a second resort under the same email just adds
// it to their portal, no new account or email).
const ensureOwnerAccount = async (ownerEmail, ownerName, resortName) => {
  if (!ownerEmail) return null;

  const existing = await db.query(
    "SELECT id FROM resort_owners WHERE LOWER(email) = LOWER($1)",
    [ownerEmail],
  );
  if (existing.length > 0) return existing[0].id;

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const result = await db.query(
    `INSERT INTO resort_owners (username, email, password) VALUES ($1, $2, $3) RETURNING id`,
    [ownerName, ownerEmail, passwordHash],
  );

  try {
    await sendEmail(
      ownerEmail,
      "Welcome to ALAI-eh -- your Owner Portal account",
      tplOwnerAccountCreated({
        owner_name: ownerName,
        resort: resortName,
        email: ownerEmail,
        tempPassword,
        loginUrl: `${CLIENT_URL}/owner/login`,
      }),
    );
  } catch (err) {
    // Don't fail resort creation just because the welcome email didn't
    // send -- the account still exists, and the admin can be told to
    // pass the credentials along manually if needed.
    console.error("❌ Owner welcome email error:", err);
  }

  return result[0].id;
};

// ---------------------------------------------------------------------
// Owner-scoped data (all filtered to req.userId's own resorts)
// ---------------------------------------------------------------------

// GET /api/owner/resorts
exports.getMyResorts = async (req, res) => {
  try {
    const resorts = await db.query(
      `SELECT id, name, barangay, location, image
         FROM resorts WHERE owner_user_id = $1
        ORDER BY created_at DESC`,
      [req.userId],
    );
    res.json(resorts);
  } catch (err) {
    console.error("Error fetching owner's resorts:", err);
    res.status(500).json({ message: "Server error while fetching resorts." });
  }
};

// GET /api/owner/bookings
// Live bookings across all of this owner's resorts.
exports.getMyBookings = async (req, res) => {
  try {
    const bookings = await db.query(
      `SELECT b.id, b.full_name AS guest_name, r.name AS resort_name,
              b.stay_type_name, b.status, b.total_price, b.adults, b.children,
              TO_CHAR(b.check_in,  'FMMon FMDD, YYYY FMHH12:MI AM') AS check_in_display,
              TO_CHAR(b.check_out, 'FMMon FMDD, YYYY FMHH12:MI AM') AS check_out_display,
              TO_CHAR(b.created_at, 'FMMon FMDD, YYYY FMHH12:MI AM') AS created_at_display
         FROM bookings b
         JOIN resorts r ON r.id = b.resort_id
        WHERE r.owner_user_id = $1
        ORDER BY b.created_at DESC`,
      [req.userId],
    );
    res.json(bookings);
  } catch (err) {
    console.error("Error fetching owner's bookings:", err);
    res.status(500).json({ message: "Server error while fetching bookings." });
  }
};

// GET /api/owner/reviews
exports.getMyReviews = async (req, res) => {
  try {
    const reviews = await db.query(
      `SELECT rev.id, r.name AS resort_name, rev.rating, rev.comment, u.username,
              TO_CHAR(rev.created_at, 'FMMon FMDD, YYYY') AS created_at_display
         FROM reviews rev
         JOIN resorts r ON r.id = rev.resort_id
         JOIN users u ON u.id = rev.user_id
        WHERE r.owner_user_id = $1
        ORDER BY rev.created_at DESC`,
      [req.userId],
    );
    res.json(reviews);
  } catch (err) {
    console.error("Error fetching owner's reviews:", err);
    res.status(500).json({ message: "Server error while fetching reviews." });
  }
};

// GET /api/owner/revenue?days=7|30|90
// Same commission-split logic as the admin dashboard, scoped to this
// owner's resorts only.
exports.getMyRevenue = async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days))
    ? Number(req.query.days)
    : 30;

  try {
    const commissionRows = await db.query(
      "SELECT value FROM settings WHERE key = 'commission_rate'",
    );
    const commissionRate =
      commissionRows.length > 0 ? Number(commissionRows[0].value) : 0;

    const [summaryRows, byResortRows, revenueOverTimeRows, bookingRows] =
      await Promise.all([
        db.query(
          `SELECT COUNT(*)::int AS bookings,
                  COALESCE(SUM(b.total_price), 0)::float AS gross_revenue
             FROM bookings b
             JOIN resorts r ON r.id = b.resort_id
            WHERE r.owner_user_id = $1 AND b.status = 'Confirmed'
              AND b.created_at >= NOW() - ($2 || ' days')::interval`,
          [req.userId, days],
        ),
        db.query(
          `SELECT r.id, r.name,
                  COUNT(b.id)::int AS bookings,
                  COALESCE(SUM(b.total_price), 0)::float AS gross_revenue
             FROM resorts r
             LEFT JOIN bookings b ON b.resort_id = r.id AND b.status = 'Confirmed'
                  AND b.created_at >= NOW() - ($2 || ' days')::interval
            WHERE r.owner_user_id = $1
            GROUP BY r.id, r.name
            ORDER BY gross_revenue DESC`,
          [req.userId, days],
        ),
        db.query(
          `SELECT TO_CHAR(b.created_at, 'YYYY-MM-DD') AS date,
                  COALESCE(SUM(b.total_price), 0)::float AS revenue
             FROM bookings b
             JOIN resorts r ON r.id = b.resort_id
            WHERE r.owner_user_id = $1 AND b.status = 'Confirmed'
              AND b.created_at >= NOW() - ($2 || ' days')::interval
            GROUP BY 1
            ORDER BY 1`,
          [req.userId, days],
        ),
        db.query(
          `SELECT b.id, b.full_name AS guest_name, r.name AS resort_name,
                  b.total_price,
                  TO_CHAR(b.created_at, 'FMMon FMDD, YYYY') AS created_at_display
             FROM bookings b
             JOIN resorts r ON r.id = b.resort_id
            WHERE r.owner_user_id = $1 AND b.status = 'Confirmed'
              AND b.created_at >= NOW() - ($2 || ' days')::interval
            ORDER BY b.created_at DESC`,
          [req.userId, days],
        ),
      ]);

    const grossRevenue = summaryRows[0].gross_revenue;
    const alaiehCommission =
      Math.round(grossRevenue * (commissionRate / 100) * 100) / 100;
    const netPayout = Math.round((grossRevenue - alaiehCommission) * 100) / 100;

    res.json({
      range: { days },
      commissionRate,
      summary: {
        bookings: summaryRows[0].bookings,
        grossRevenue,
        alaiehCommission,
        netPayout,
      },
      byResort: byResortRows.map((r) => {
        const commission =
          Math.round(r.gross_revenue * (commissionRate / 100) * 100) / 100;
        return {
          ...r,
          alaiehCommission: commission,
          netPayout: Math.round((r.gross_revenue - commission) * 100) / 100,
        };
      }),
      revenueOverTime: revenueOverTimeRows,
      bookings: bookingRows,
    });
  } catch (err) {
    console.error("Error building owner revenue report:", err);
    res
      .status(500)
      .json({ message: "Server error while building revenue report." });
  }
};

exports.changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res
      .status(400)
      .json({ message: "Current and new password are required." });
  }
  if (newPassword.length < 6) {
    return res
      .status(400)
      .json({ message: "New password must be at least 6 characters." });
  }

  try {
    const rows = await db.query(
      "SELECT password FROM resort_owners WHERE id = $1",
      [req.userId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Account not found." });
    }

    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isMatch) {
      return res
        .status(400)
        .json({ message: "Current password is incorrect." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE resort_owners SET password = $1 WHERE id = $2", [
      passwordHash,
      req.userId,
    ]);

    res.json({ message: "Password changed successfully." });
  } catch (err) {
    console.error("Error changing owner password:", err);
    res.status(500).json({ message: "Server error while changing password." });
  }
};

exports.ensureOwnerAccount = ensureOwnerAccount;
