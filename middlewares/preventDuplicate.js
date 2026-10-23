// Rejects a request when an identical one (same key) is still being
// processed, so a double click, a slow connection, or a retry can't create
// the same record twice. Release happens when the response finishes.
// In-memory, which is correct for a single server instance (your Render
// free tier). Multiple instances would need a database-level constraint.
const inFlight = new Set();

const preventDuplicate = (keyFn) => (req, res, next) => {
  const key = keyFn(req);
  if (!key) return next();

  if (inFlight.has(key)) {
    const message =
      "This request is already being processed. Please wait a moment.";
    return res.status(429).json({ message, error: message });
  }

  inFlight.add(key);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inFlight.delete(key);
  };
  res.on("finish", release);
  res.on("close", release);

  next();
};

module.exports = preventDuplicate;
