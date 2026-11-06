const db = require("../config/connectDB");
const { normalizeStayTypeName } = require("../utils/stayTypeName");

const validateStayTypeInput = ({ name, checkInTime, checkOutTime, price }) => {
  if (!name || !name.trim()) return "A name is required.";
  if (!checkInTime || !checkOutTime)
    return "Check-in and check-out times are required.";
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0)
    return "Price must be a positive number.";
  return null;
};

// GET /api/resorts/:resortId/stay-types
// Public -- lists a resort's stay-type packages (Overnight, Day Tour, etc.),
// each resort owner defines their own.
exports.getStayTypesByResort = async (req, res) => {
  const { resortId } = req.params;

  try {
    const rows = await db.query(
      `SELECT id, resort_id, name,
              TO_CHAR(check_in_time, 'HH24:MI') AS check_in_time,
              TO_CHAR(check_out_time, 'HH24:MI') AS check_out_time,
              spans_next_day, price
         FROM stay_types
        WHERE resort_id = $1
        ORDER BY created_at ASC`,
      [resortId],
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching stay types:", err);
    res
      .status(500)
      .json({ message: "Server error while fetching stay types." });
  }
};

// POST /api/resorts/:resortId/stay-types (admin)
exports.createStayType = async (req, res) => {
  const { resortId } = req.params;
  const { name, checkInTime, checkOutTime, spansNextDay, price } = req.body;

  const validationError = validateStayTypeInput({
    name,
    checkInTime,
    checkOutTime,
    price,
  });
  if (validationError)
    return res.status(400).json({ message: validationError });

  try {
    const result = await db.query(
      `INSERT INTO stay_types (resort_id, name, check_in_time, check_out_time, spans_next_day, price)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        resortId,
        normalizeStayTypeName(name),
        checkInTime,
        checkOutTime,
        !!spansNextDay,
        price,
      ],
    );
    res.status(201).json({ id: result[0].id, message: "Stay type added." });
  } catch (err) {
    console.error("Error creating stay type:", err);
    res.status(500).json({ message: "Server error while creating stay type." });
  }
};

// PUT /api/stay-types/:id (admin)
exports.updateStayType = async (req, res) => {
  const { id } = req.params;
  const { name, checkInTime, checkOutTime, spansNextDay, price } = req.body;

  const validationError = validateStayTypeInput({
    name,
    checkInTime,
    checkOutTime,
    price,
  });
  if (validationError)
    return res.status(400).json({ message: validationError });

  try {
    const result = await db.query(
      `UPDATE stay_types
          SET name = $1, check_in_time = $2, check_out_time = $3,
              spans_next_day = $4, price = $5
        WHERE id = $6
        RETURNING id`,
      [
        normalizeStayTypeName(name),
        checkInTime,
        checkOutTime,
        !!spansNextDay,
        price,
        id,
      ],
    );

    if (result.length === 0)
      return res.status(404).json({ message: "Stay type not found." });

    res.json({ message: "Stay type updated." });
  } catch (err) {
    console.error("Error updating stay type:", err);
    res.status(500).json({ message: "Server error while updating stay type." });
  }
};

// DELETE /api/stay-types/:id (admin)
exports.deleteStayType = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      "DELETE FROM stay_types WHERE id = $1 RETURNING id",
      [id],
    );

    if (result.length === 0)
      return res.status(404).json({ message: "Stay type not found." });

    res.json({ message: "Stay type deleted." });
  } catch (err) {
    console.error("Error deleting stay type:", err);
    res.status(500).json({ message: "Server error while deleting stay type." });
  }
};
