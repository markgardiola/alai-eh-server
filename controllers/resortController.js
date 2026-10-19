const db = require("../config/connectDB");
const { buildValuesClause } = require("../utils/buildValuesClause");
const { ensureDestinationExists } = require("./destinationController");
const { ensureOwnerAccount } = require("./ownerController");

exports.createResort = async (req, res) => {
  const {
    name,
    address,
    location,
    barangay,
    description,
    ownerName,
    ownerEmail,
  } = req.body;

  let rooms = [];
  let amenities = [];
  let stayTypes = [];
  try {
    rooms = JSON.parse(req.body.rooms);
    amenities = JSON.parse(req.body.amenities || "[]");
    stayTypes = JSON.parse(req.body.stayTypes || "[]");
  } catch (error) {
    return res.status(400).json({
      message: "Invalid JSON format for rooms, amenities, or stay types.",
    });
  }

  if (
    !name ||
    !address ||
    !barangay ||
    !description ||
    !ownerName ||
    !ownerEmail ||
    rooms.length === 0 ||
    stayTypes.length === 0
  ) {
    return res.status(400).json({
      message:
        "All fields (including barangay, resort owner name/email) and at least one room and one stay type are required.",
    });
  }

  for (const stayType of stayTypes) {
    const numericStayPrice = Number(stayType.price);
    if (
      !stayType.name ||
      !stayType.checkInTime ||
      !stayType.checkOutTime ||
      !Number.isFinite(numericStayPrice) ||
      numericStayPrice <= 0
    ) {
      return res.status(400).json({
        message:
          "Each stay type needs a name, check-in/out time, and a valid price.",
      });
    }
  }

  // req.files is a flat array now (uploadResortImages.any()), since we
  // accept both the resort gallery ('images') and each room's own photos
  // ('roomImages_0', 'roomImages_1', ...) in one request.
  const allFiles = req.files || [];
  const galleryFiles = allFiles.filter((f) => f.fieldname === "images");
  const imageUrls = galleryFiles.map((file) => file.path);

  if (imageUrls.length === 0) {
    return res.status(400).json({ message: "At least one image is required." });
  }

  try {
    const resortResult = await db.query(
      "INSERT INTO resorts (name, address, location, barangay, description, owner_name, owner_email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [
        name,
        address,
        location || "",
        barangay,
        description,
        ownerName,
        ownerEmail,
      ],
    );
    const resortId = resortResult[0].id;

    // Insert gallery images
    const imageValues = imageUrls.map((url) => [resortId, url]);
    const imageClause = buildValuesClause(imageValues);
    await db.query(
      `INSERT INTO resort_images (resort_id, image_url) VALUES ${imageClause.placeholders}`,
      imageClause.values,
    );

    // Also set the legacy cover thumbnail (used by listing/search cards)
    // to the first uploaded image, so it isn't blank until someone edits.
    db.query("UPDATE resorts SET image = $1 WHERE id = $2", [
      imageUrls[0],
      resortId,
    ]).catch((errCover) =>
      console.error("Error setting cover image:", errCover),
    );

    // Auto-create a destination card for this barangay if it's the first
    // resort listed there.
    await ensureDestinationExists(barangay, imageUrls[0]);

    // Auto-create (or reuse) the owner's portal account and link it to
    // this resort, so they can see their bookings/reviews/revenue.
    const ownerUserId = await ensureOwnerAccount(ownerEmail, ownerName, name);
    if (ownerUserId) {
      await db.query("UPDATE resorts SET owner_user_id = $1 WHERE id = $2", [
        ownerUserId,
        resortId,
      ]);
    }

    // Rooms are purely informational now (no price, no selection) -- just
    // what's included in the stay. Each room's photos come in under
    // fieldname `roomImages_<index>`, index matching its position in the
    // `rooms` array submitted alongside it.
    for (let i = 0; i < rooms.length; i++) {
      const roomResult = await db.query(
        "INSERT INTO rooms (resort_id, name) VALUES ($1, $2) RETURNING id",
        [resortId, rooms[i].name],
      );
      const roomId = roomResult[0].id;

      const roomFiles = allFiles.filter(
        (f) => f.fieldname === `roomImages_${i}`,
      );
      if (roomFiles.length > 0) {
        const roomImageValues = roomFiles.map((f) => [roomId, f.path]);
        const roomImageClause = buildValuesClause(roomImageValues);
        await db.query(
          `INSERT INTO room_images (room_id, image_url) VALUES ${roomImageClause.placeholders}`,
          roomImageClause.values,
        );
      }
    }

    // Insert amenities, if any
    if (amenities.length > 0) {
      const amenityValues = amenities.map((amenity) => [resortId, amenity]);
      const amenityClause = buildValuesClause(amenityValues);
      await db.query(
        `INSERT INTO resort_amenities (resort_id, amenity) VALUES ${amenityClause.placeholders}`,
        amenityClause.values,
      );
    }

    // Insert stay types (Overnight, Day Tour, etc.) -- at least one is
    // required, validated above.
    const stayTypeValues = stayTypes.map((st) => [
      resortId,
      st.name.trim(),
      st.checkInTime,
      st.checkOutTime,
      !!st.spansNextDay,
      st.price,
    ]);
    const stayTypeClause = buildValuesClause(stayTypeValues);
    await db.query(
      `INSERT INTO stay_types (resort_id, name, check_in_time, check_out_time, spans_next_day, price) VALUES ${stayTypeClause.placeholders}`,
      stayTypeClause.values,
    );

    return res.status(201).json({
      message: "Resort created successfully!",
    });
  } catch (err) {
    console.error("Error creating resort:", err);
    return res
      .status(500)
      .json({ message: "Server error while creating resort." });
  }
};

exports.getTotalResorts = async (req, res) => {
  try {
    const results = await db.query(
      'SELECT COUNT(*) AS "totalResorts" FROM resorts',
    );
    res.json({ totalResorts: Number(results[0].totalResorts) });
  } catch (err) {
    console.error("Error fetching total resorts:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.getAllResorts = async (req, res) => {
  try {
    const results = await db.query(
      "SELECT * FROM resorts ORDER BY created_at DESC",
    );
    res.status(200).json(results);
  } catch (err) {
    console.error("Error fetching resorts:", err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getResortById = async (req, res) => {
  const { id } = req.params;

  try {
    const resortResults = await db.query(
      "SELECT * FROM resorts WHERE id = $1",
      [id],
    );
    if (resortResults.length === 0) {
      return res.status(404).json({ message: "Resort not found" });
    }

    const resort = resortResults[0];

    const roomResults = await db.query(
      "SELECT id, name FROM rooms WHERE resort_id = $1",
      [id],
    );
    const roomImageResults = await db.query(
      `SELECT room_id, id, image_url FROM room_images
        WHERE room_id = ANY($1::int[])`,
      [roomResults.map((r) => r.id)],
    );
    const amenityResults = await db.query(
      "SELECT amenity FROM resort_amenities WHERE resort_id = $1",
      [id],
    );
    const imageResults = await db.query(
      "SELECT id, image_url FROM resort_images WHERE resort_id = $1",
      [id],
    );
    const ratingResults = await db.query(
      `SELECT COUNT(*)::int AS count, COALESCE(AVG(rating)::float, 0) AS average
       FROM reviews WHERE resort_id = $1`,
      [id],
    );
    const stayTypeResults = await db.query(
      `SELECT id, name,
              TO_CHAR(check_in_time, 'HH24:MI') AS check_in_time,
              TO_CHAR(check_out_time, 'HH24:MI') AS check_out_time,
              spans_next_day, price
         FROM stay_types WHERE resort_id = $1
        ORDER BY created_at ASC`,
      [id],
    );

    resort.rooms = roomResults.map((room) => ({
      ...room,
      images: roomImageResults.filter((img) => img.room_id === room.id),
    }));
    resort.amenities = amenityResults.map((a) => a.amenity);
    resort.images = imageResults; // [{ id, image_url }, ...] - full gallery for the carousel
    resort.stayTypes = stayTypeResults;
    resort.rating = {
      average: ratingResults[0].average,
      count: ratingResults[0].count,
    };

    res.json(resort);
  } catch (err) {
    console.error("Error fetching resort:", err);
    res.status(500).json({ message: "Error fetching resort details" });
  }
};

exports.deleteResort = async (req, res) => {
  const { id } = req.params;

  try {
    await db.query("DELETE FROM resort_amenities WHERE resort_id = $1", [id]);
    await db.query("DELETE FROM rooms WHERE resort_id = $1", [id]);
    await db.query("DELETE FROM resort_images WHERE resort_id = $1", [id]);
    await db.query("DELETE FROM resorts WHERE id = $1", [id]);

    res.status(200).json({ message: "Resort deleted successfully" });
  } catch (error) {
    console.error("Delete failed:", error);
    res.status(500).json({ error: "Failed to delete resort" });
  }
};

exports.updateResort = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    address,
    location,
    barangay,
    description,
    ownerName,
    ownerEmail,
  } = req.body;

  let rooms = []; // [{ id?: number, name: string, existingImages?: string[] }, ...]
  let amenities = [];
  let keepImages = []; // image_urls of existing gallery images the admin did NOT remove

  try {
    rooms = JSON.parse(req.body.rooms || "[]");
    amenities = JSON.parse(req.body.amenities || "[]");
    keepImages = JSON.parse(req.body.existingImages || "[]");
  } catch (err) {
    return res
      .status(400)
      .json({ message: "Invalid JSON for rooms, amenities, or images." });
  }

  // req.files is a flat array now (uploadResortImages.any()): the resort
  // gallery uses fieldname 'images', each room's new photos use
  // 'roomImages_<index>' where index is that room's position in `rooms`.
  const allFiles = req.files || [];
  const galleryFiles = allFiles.filter((f) => f.fieldname === "images");
  const newImageUrls = galleryFiles.map((file) => file.path);
  const finalImages = [...keepImages, ...newImageUrls];

  if (
    !name ||
    !address ||
    !barangay ||
    !description ||
    !ownerName ||
    !ownerEmail ||
    rooms.length === 0
  ) {
    return res.status(400).json({
      message:
        "All required fields (including resort owner name/email) must be filled.",
    });
  }

  if (finalImages.length === 0) {
    return res.status(400).json({ message: "At least one image is required." });
  }

  try {
    const coverImage = finalImages[0]; // legacy single-image column used by listing/search cards

    await db.query(
      `UPDATE resorts SET name = $1, address = $2, location = $3, barangay = $4, description = $5, image = $6, owner_name = $7, owner_email = $8 WHERE id = $9`,
      [
        name,
        address,
        location || "",
        barangay,
        description,
        coverImage,
        ownerName,
        ownerEmail,
        id,
      ],
    );

    // Auto-create a destination card if the admin changed this resort's
    // barangay to one that doesn't have a card yet.
    await ensureDestinationExists(barangay, coverImage);

    // Re-link the owner account too, in case the admin changed the owner
    // email -- e.g. to an existing owner's account (multi-resort owner) or
    // a brand-new one (auto-created, welcome email sent).
    const ownerUserId = await ensureOwnerAccount(ownerEmail, ownerName, name);
    if (ownerUserId) {
      await db.query("UPDATE resorts SET owner_user_id = $1 WHERE id = $2", [
        ownerUserId,
        id,
      ]);
    }

    // Replace the gallery with exactly what the admin submitted (kept + new)
    await db.query(`DELETE FROM resort_images WHERE resort_id = $1`, [id]);
    const imageValues = finalImages.map((url) => [id, url]);
    const imageClause = buildValuesClause(imageValues);
    await db.query(
      `INSERT INTO resort_images (resort_id, image_url) VALUES ${imageClause.placeholders}`,
      imageClause.values,
    );

    // Rooms: reconcile rather than wipe-and-reinsert, so a room's existing
    // photos survive an edit unless the admin actually removed them.
    // A room in the submitted list with an `id` is an existing room being
    // kept/edited; one without an `id` is brand new. Any existing room NOT
    // present in the submitted list was removed by the admin.
    const existingRoomRows = await db.query(
      "SELECT id FROM rooms WHERE resort_id = $1",
      [id],
    );
    const submittedIds = rooms.filter((r) => r.id).map((r) => r.id);
    const removedRoomIds = existingRoomRows
      .map((r) => r.id)
      .filter((existingId) => !submittedIds.includes(existingId));

    if (removedRoomIds.length > 0) {
      await db.query(
        "DELETE FROM rooms WHERE id = ANY($1::int[]) AND resort_id = $2",
        [removedRoomIds, id],
      );
    }

    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i];
      const roomKeepImages = room.existingImages || [];
      const roomNewFiles = allFiles.filter(
        (f) => f.fieldname === `roomImages_${i}`,
      );

      let roomId = room.id;
      if (roomId) {
        await db.query("UPDATE rooms SET name = $1 WHERE id = $2", [
          room.name,
          roomId,
        ]);
        // Drop any of this room's photos the admin didn't keep. Works for
        // an empty keep-list too: `= ANY('{}')` is never true, so NOT(...)
        // deletes everything, which is exactly "removed all photos".
        await db.query(
          "DELETE FROM room_images WHERE room_id = $1 AND NOT (image_url = ANY($2::text[]))",
          [roomId, roomKeepImages],
        );
      } else {
        const roomResult = await db.query(
          "INSERT INTO rooms (resort_id, name) VALUES ($1, $2) RETURNING id",
          [id, room.name],
        );
        roomId = roomResult[0].id;
      }

      if (roomNewFiles.length > 0) {
        const roomImageValues = roomNewFiles.map((f) => [roomId, f.path]);
        const roomImageClause = buildValuesClause(roomImageValues);
        await db.query(
          `INSERT INTO room_images (room_id, image_url) VALUES ${roomImageClause.placeholders}`,
          roomImageClause.values,
        );
      }
    }

    await db.query(`DELETE FROM resort_amenities WHERE resort_id = $1`, [id]);
    if (amenities.length > 0) {
      const amenityValues = amenities.map((item) => [id, item]);
      const amenityClause = buildValuesClause(amenityValues);
      await db.query(
        `INSERT INTO resort_amenities (resort_id, amenity) VALUES ${amenityClause.placeholders}`,
        amenityClause.values,
      );
    }

    return res.status(200).json({ message: "Resort updated successfully!" });
  } catch (err) {
    console.error("Error updating resort:", err);
    return res.status(500).json({ message: "Error updating resort." });
  }
};

exports.getResortsByBarangay = async (req, res) => {
  const barangay = req.params.barangay;

  try {
    // Grouping by r.id (the primary key) lets Postgres select all of r.*
    // alongside the aggregates without listing every column in GROUP BY.
    const results = await db.query(
      `SELECT r.*,
              COALESCE(AVG(rev.rating)::float, 0) AS avg_rating,
              COUNT(rev.id)::int AS review_count
       FROM resorts r
       LEFT JOIN reviews rev ON rev.resort_id = r.id
       WHERE LOWER(r.barangay) = LOWER($1)
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [barangay],
    );

    const resorts = results.map(({ avg_rating, review_count, ...resort }) => ({
      ...resort,
      rating: { average: avg_rating, count: review_count },
    }));

    res.json(resorts);
  } catch (err) {
    console.error("Error fetching resorts by barangay:", err);
    res.status(500).json({ error: "Database error" });
  }
};
