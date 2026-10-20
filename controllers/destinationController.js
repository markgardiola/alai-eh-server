const db = require("../config/connectDB");

const slugify = (str) =>
  str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

// Called from resortController whenever a resort is created/updated.
// Creates a destination card the first time a location is seen; does
// nothing if one already exists for it (case-insensitive match, since
// "San Vicente" and "san vicente" should be the same destination).
const ensureDestinationExists = async (location, imageUrl) => {
  if (!location) return;

  const existing = await db.query(
    "SELECT id FROM destinations WHERE LOWER(name) = LOWER($1)",
    [location],
  );
  if (existing.length > 0) return;

  try {
    await db.query(
      `INSERT INTO destinations (name, slug, image_url, description)
       VALUES ($1, $2, $3, $4)`,
      [
        location,
        slugify(location),
        imageUrl || null,
        `Discover Private Resorts in ${location}, Sto. Tomas City.`,
      ],
    );
  } catch (err) {
    // 23505 (unique_violation) means someone else's request created this
    // same destination a moment earlier -- not a real error, just a race
    // we lost, and the destination exists either way.
    if (err.code !== "23505") throw err;
  }
};

// GET /api/destinations
// Public -- powers the Destinations browse page.
exports.getAllDestinations = async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT d.id, d.name, d.slug, d.image_url, d.description,
              (SELECT COUNT(*)::int FROM resorts r WHERE LOWER(r.barangay) = LOWER(d.name)) AS resort_count
         FROM destinations d
        ORDER BY d.name ASC`,
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching destinations:", err);
    res
      .status(500)
      .json({ message: "Server error while fetching destinations." });
  }
};

// GET /api/destinations/:slug
// Public -- feeds the "explore area" page's title/description.
exports.getDestinationBySlug = async (req, res) => {
  const { slug } = req.params;

  try {
    const rows = await db.query(
      "SELECT id, name, slug, image_url, description FROM destinations WHERE slug = $1",
      [slug],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Destination not found." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching destination:", err);
    res
      .status(500)
      .json({ message: "Server error while fetching destination." });
  }
};

exports.ensureDestinationExists = ensureDestinationExists;
