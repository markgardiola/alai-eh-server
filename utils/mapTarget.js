const COORDS = /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/;
const URL_PATTERN = /^(https?:\/\/|www\.)\S+$/i;

// Full-length Google Maps URLs embed coordinates; short share links don't.
function coordsFromUrl(url) {
  let text = url;
  try {
    text = decodeURIComponent(url);
  } catch {
    /* keep the raw string */
  }
  const m =
    text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
    text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
    text.match(/[?&](?:q|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  return m ? `${m[1]},${m[2]}` : null;
}

// What directions should aim at. `exact` is true only with real coordinates;
// otherwise it's a "name, address" text search that Google may place loosely.
function getMapTarget(resort) {
  const pin = (resort.location || "").trim();
  if (COORDS.test(pin)) return { query: pin.replace(/\s+/g, ""), exact: true };

  const fromUrl = URL_PATTERN.test(pin) ? coordsFromUrl(pin) : null;
  if (fromUrl) return { query: fromUrl, exact: true };

  return {
    query: [resort.name, resort.address].filter(Boolean).join(", "),
    exact: false,
  };
}

function directionsUrl(query) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
}

// The owner's pasted pin link, but only if it really is a Google Maps link.
// Anything else is dropped rather than shown to guests as a button.
function safePinUrl(location) {
  const pin = (location || "").trim();
  if (!URL_PATTERN.test(pin)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(pin) ? pin : `https://${pin}`);
    const host = u.hostname.replace(/^www\./, "");
    const ok =
      host === "maps.app.goo.gl" ||
      host === "maps.google.com" ||
      ((host === "google.com" || host === "goo.gl") &&
        u.pathname.startsWith("/maps"));
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

module.exports = { getMapTarget, directionsUrl, safePinUrl };
