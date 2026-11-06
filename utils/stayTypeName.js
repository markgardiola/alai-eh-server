// Known spellings of the standard stay types, matched ignoring case,
// spaces and punctuation ("Daytour", "day tour", "DAY-TOUR" are the same).
const CANONICAL = new Map([
  ["daytour", "Day Tour"],
  ["overnight", "Overnight"],
  ["overnightstay", "Overnight"],
  ["21hourstay", "21-Hour Stay"],
  ["21hoursstay", "21-Hour Stay"],
  ["21hrstay", "21-Hour Stay"],
  ["21hrsstay", "21-Hour Stay"],
]);

const keyOf = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function normalizeStayTypeName(raw) {
  const cleaned = String(raw).trim().replace(/\s+/g, " ");
  const canonical = CANONICAL.get(keyOf(cleaned));
  if (canonical) return canonical;
  // Custom names: just tidy the capitalization of each word.
  return cleaned.replace(
    /(^|\s)([a-z])/g,
    (_, space, ch) => space + ch.toUpperCase(),
  );
}

module.exports = { normalizeStayTypeName };
