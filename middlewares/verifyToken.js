const jwt = require("jsonwebtoken");
require("dotenv").config();
const JWT_SECRET_KEY = process.env.JWT;

// 401 = "sign in again" (the frontend logs the user out on these codes).
// 403 stays reserved for "signed in but not allowed" (requireAdmin etc.).
const verifyToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) {
    return res
      .status(401)
      .json({ code: "NO_TOKEN", message: "No token provided!" });
  }

  jwt.verify(token, JWT_SECRET_KEY, (err, decoded) => {
    if (err) {
      const expired = err.name === "TokenExpiredError";
      return res.status(401).json({
        code: expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
        message: expired
          ? "Your session has expired. Please sign in again."
          : "Invalid token.",
      });
    }
    req.userId = decoded.id;
    req.userRole = decoded.role;
    next();
  });
};

module.exports = verifyToken;
