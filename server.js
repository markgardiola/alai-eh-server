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

const allowedOrigins = [
  "http://localhost:5173",
  "https://alaehscape-booking.vercel.app", // remove after the rename is confirmed working
  process.env.CLIENT_URL, // e.g. https://alai-eh.vercel.app
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
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
