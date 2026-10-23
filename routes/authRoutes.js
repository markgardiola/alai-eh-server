const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const preventDuplicate = require("../middlewares/preventDuplicate");
const byEmail = (name) => (req) =>
  `${name}:${String(req.body?.email || "").toLowerCase()}`;

// Registration (SMS OTP verification)
router.post(
  "/register/request-otp",
  preventDuplicate(byEmail("reg-otp")),
  authController.requestRegistrationOtp,
);
router.post(
  "/register/resend-otp",
  preventDuplicate(byEmail("reg-resend")),
  authController.resendRegistrationOtp,
);
router.post(
  "/register/verify-otp",
  preventDuplicate(byEmail("reg-verify")),
  authController.verifyRegistrationOtp,
);

// Password recovery (SMS or email OTP, user's choice)
router.post("/password-reset/lookup", authController.lookupRecoveryOptions);
router.post(
  "/password-reset/request-otp",
  authController.requestPasswordResetOtp,
);
router.post(
  "/password-reset/resend-otp",
  authController.resendPasswordResetOtp,
);
router.post(
  "/password-reset/verify-otp",
  authController.verifyPasswordResetOtp,
);
router.post("/password-reset/reset", authController.resetPassword);

// Resort owner password recovery (email OTP only)
router.post(
  "/owner/password-reset/request-otp",
  authController.requestOwnerPasswordResetOtp,
);
router.post(
  "/owner/password-reset/resend-otp",
  authController.resendOwnerPasswordResetOtp,
);
router.post(
  "/owner/password-reset/verify-otp",
  authController.verifyOwnerPasswordResetOtp,
);
router.post("/owner/password-reset/reset", authController.resetOwnerPassword);

// Login
router.post("/login", authController.login);
router.post("/admin-login", authController.adminLogin);
router.post("/owner-login", authController.ownerLogin);

module.exports = router;
