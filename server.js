const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();
require("dotenv").config();

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const resortRoutes = require("./routes/resortRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const promoRoutes = require("./routes/promoRoutes");
const stayTypeRoutes = require("./routes/stayTypeRoutes");
const destinationRoutes = require("./routes/destinationRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const ownerRoutes = require("./routes/ownerRoutes");
const chatbotRoutes = require("./routes/chatbotRoutes");

const port = process.env.PORT || 5000;

// Trailing slashes and stray spaces never match a browser's Origin header,
// so strip them. EXTRA_ALLOWED_ORIGINS is an optional comma-separated list
// (e.g. a Vercel preview URL you want to test against).
const normalizeOrigin = (o) => o.trim().replace(/\/+$/, "");
const allowedOrigins = [
  "http://localhost:5173",
  "https://alaehscape-booking.vercel.app", // old URL; remove once you're sure it's unused
  process.env.CLIENT_URL,
  ...(process.env.EXTRA_ALLOWED_ORIGINS || "").split(","),
]
  .filter(Boolean)
  .map(normalizeOrigin);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Refuse without throwing: the browser blocks the response, and the
      // log shows exactly which origin it was.
      console.warn(`CORS blocked origin: ${origin}`);
      callback(null, false);
    },
    credentials: true,
  }),
);

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/api", authRoutes);
app.use("/api", userRoutes);
app.use("/api", resortRoutes);
app.use("/api", bookingRoutes);
app.use("/api", notificationRoutes);
app.use("/api", reviewRoutes);
app.use("/api", promoRoutes);
app.use("/api", stayTypeRoutes);
app.use("/api", destinationRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", ownerRoutes);
app.use("/api", chatbotRoutes);

app.listen(port, () => console.log(`Server running on port ${port}`));
