const { Type } = require("@google/genai");
const db = require("../config/connectDB");

// Gemini's function-declaration format (JSON-schema-like, using its Type
// enum). The execution functions below are unchanged from before -- only
// how we describe them to the model differs.
const baseToolDeclarations = [
  {
    name: "search_resorts",
    description:
      "Search/browse resorts listed on the site by name or area. Returns id, name, location/barangay, description, and rating for each match. Use this first when the customer hasn't named an exact resort.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description:
            "Free-text match against resort name or description (optional).",
        },
        barangay: {
          type: Type.STRING,
          description: "Filter to resorts in this barangay/area (optional).",
        },
      },
    },
  },
  {
    name: "get_resort_details",
    description:
      "Get full details for ONE specific resort: included rooms, amenities, stay types with check-in/out times and pricing, and rating. Call after identifying which resort the customer means.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        resortId: {
          type: Type.INTEGER,
          description: "The resort's id, if already known.",
        },
        resortName: {
          type: Type.STRING,
          description: "The resort's name, if id is not known.",
        },
      },
    },
  },
  {
    name: "check_availability",
    description:
      "Check whether a resort is available for a SPECIFIC stay type on a specific date, using the exact same rule the booking system enforces (including the cleaning-turnover buffer). You must know the exact stay type name first -- call get_resort_details if you don't already have it. Informational only -- does NOT reserve anything.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        resortId: { type: Type.INTEGER },
        date: {
          type: Type.STRING,
          description: "ISO date of the stay, e.g. 2026-09-30",
        },
        stayTypeName: {
          type: Type.STRING,
          description:
            "Exact stay type name, e.g. 'Day Tour', 'Overnight', '21 Hours Stay'",
        },
      },
      required: ["resortId", "date", "stayTypeName"],
    },
  },
];

// Only offered to the model when the request is authenticated -- an
// anonymous visitor must never be able to fetch ANY booking, so the
// capability doesn't exist for them at the tool-list level.
const authedToolDeclarations = [
  {
    name: "get_my_bookings",
    description:
      "Get the logged-in customer's own bookings (status, resort, dates). Use when they ask about 'my booking' / booking status. Can never see another customer's bookings.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        bookingId: {
          type: Type.INTEGER,
          description:
            "If they gave a specific booking id, narrow to that one.",
        },
      },
    },
  },
];

function getToolsFor(context) {
  return context.userId
    ? [...baseToolDeclarations, ...authedToolDeclarations]
    : baseToolDeclarations;
}

// --- Everything below is unchanged from the Claude version ---

async function searchResorts({ query, barangay }) {
  const conditions = [];
  const params = [];
  if (query) {
    params.push(`%${query}%`);
    conditions.push(
      `(r.name ILIKE $${params.length} OR r.description ILIKE $${params.length})`,
    );
  }
  if (barangay) {
    params.push(barangay);
    conditions.push(`LOWER(r.barangay) = LOWER($${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.query(
    `SELECT r.id, r.name, r.address, r.barangay, r.description,
            COALESCE(AVG(rev.rating)::float, 0) AS avg_rating,
            COUNT(rev.id)::int AS review_count
       FROM resorts r
       LEFT JOIN reviews rev ON rev.resort_id = r.id
       ${where}
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT 8`,
    params,
  );
}

async function getResortDetails({ resortId, resortName }) {
  let resort;
  if (resortId) {
    resort = (
      await db.query("SELECT * FROM resorts WHERE id = $1", [resortId])
    )[0];
  } else if (resortName) {
    resort = (
      await db.query(
        "SELECT * FROM resorts WHERE name ILIKE $1 ORDER BY created_at DESC LIMIT 1",
        [`%${resortName}%`],
      )
    )[0];
  }
  if (!resort) return { error: "Resort not found." };

  const [rooms, amenities, stayTypes, ratingRows] = await Promise.all([
    db.query("SELECT name FROM rooms WHERE resort_id = $1", [resort.id]),
    db.query("SELECT amenity FROM resort_amenities WHERE resort_id = $1", [
      resort.id,
    ]),
    db.query(
      `SELECT name, TO_CHAR(check_in_time, 'HH24:MI') AS check_in_time,
              TO_CHAR(check_out_time, 'HH24:MI') AS check_out_time,
              spans_next_day, price
         FROM stay_types WHERE resort_id = $1 ORDER BY created_at ASC`,
      [resort.id],
    ),
    db.query(
      `SELECT COUNT(*)::int AS count, COALESCE(AVG(rating)::float, 0) AS average
         FROM reviews WHERE resort_id = $1`,
      [resort.id],
    ),
  ]);

  return {
    id: resort.id,
    name: resort.name,
    address: resort.address,
    barangay: resort.barangay,
    description: resort.description,
    rooms: rooms.map((r) => r.name),
    amenities: amenities.map((a) => a.amenity),
    stayTypes,
    rating: ratingRows[0],
  };
}

async function checkAvailability({ resortId, date, stayTypeName }) {
  const stayTypeRows = await db.query(
    `SELECT id, name, check_in_time, check_out_time, spans_next_day
       FROM stay_types WHERE resort_id = $1 AND name ILIKE $2 LIMIT 1`,
    [resortId, `%${stayTypeName}%`],
  );
  const stayType = stayTypeRows[0];
  if (!stayType)
    return {
      error: `No stay type matching "${stayTypeName}" found for this resort.`,
    };

  // Same computation submitBooking uses -- plain strings, never JS Date
  // objects, so nothing drifts across a timezone conversion.
  const computedRows = await db.query(
    `SELECT TO_CHAR($1::date + $2::time, 'YYYY-MM-DD HH24:MI:SS') AS check_in,
            TO_CHAR($1::date + ($3::int * INTERVAL '1 day') + $4::time, 'YYYY-MM-DD HH24:MI:SS') AS check_out`,
    [
      date,
      stayType.check_in_time,
      stayType.spans_next_day ? 1 : 0,
      stayType.check_out_time,
    ],
  );
  const { check_in: checkIn, check_out: checkOut } = computedRows[0];

  // Identical rule to submitBooking's own conflict check: a private
  // resort booking holds the whole property, with a 2-hour buffer
  // between bookings. Keeping this in sync with that query is the point
  // -- the chatbot's answer must match what booking will actually allow.
  const overlapRows = await db.query(
    `SELECT id FROM bookings
      WHERE resort_id = $1
        AND status IN ('Pending', 'Confirmed', 'Refund Requested')
        AND check_out + INTERVAL '2 hours' > $2::timestamp
        AND $3::timestamp + INTERVAL '2 hours' > check_in`,
    [resortId, checkIn, checkOut],
  );

  return {
    resortId,
    stayType: stayType.name,
    date,
    checkIn,
    checkOut,
    looksAvailable: overlapRows.length === 0,
    conflictingBookings: overlapRows.length,
  };
}

async function getMyBookings({ bookingId }, context) {
  if (!context.userId) return { error: "Not logged in." };
  const sql = bookingId
    ? `SELECT b.id, b.status, b.check_in, b.check_out, r.name AS resort_name, r.id AS resort_id
         FROM bookings b JOIN resorts r ON r.id = b.resort_id
        WHERE b.id = $1 AND b.user_id = $2`
    : `SELECT b.id, b.status, b.check_in, b.check_out, r.name AS resort_name, r.id AS resort_id
         FROM bookings b JOIN resorts r ON r.id = b.resort_id
        WHERE b.user_id = $1
        ORDER BY b.created_at DESC LIMIT 5`;
  const params = bookingId ? [bookingId, context.userId] : [context.userId];
  const rows = await db.query(sql, params);
  return rows.length
    ? rows
    : { message: "No matching booking found for this account." };
}

async function executeTool(name, args, context) {
  switch (name) {
    case "search_resorts":
      return searchResorts(args);
    case "get_resort_details":
      return getResortDetails(args);
    case "check_availability":
      return checkAvailability(args);
    case "get_my_bookings":
      return getMyBookings(args, context);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { getToolsFor, executeTool };
