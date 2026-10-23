const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/connectDB");
const { notifyUser } = require("../utils/notify");
const sendEmail = require("../utils/sendEmail");
const { sendOtpSms } = require("../utils/textbeeClient");
const {
  generateOtp,
  hashOtp,
  compareOtp,
  normalizePhilippinePhone,
  maskEmail,
  maskPhone,
} = require("../utils/otp");
require("dotenv").config();
const JWT_SECRET_KEY = process.env.JWT;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

const OTP_TTL_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS_PER_HOUR = 5;

// ---------------------------------------------------------------------
// Shared OTP helpers
// ---------------------------------------------------------------------

const canSendNewOtp = async (identifier, purpose) => {
  const recentRows = await db.query(
    `SELECT created_at FROM otps WHERE identifier = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    [identifier, purpose],
  );

  if (recentRows.length > 0) {
    const secondsSinceLast =
      (Date.now() - new Date(recentRows[0].created_at).getTime()) / 1000;
    if (secondsSinceLast < OTP_RESEND_COOLDOWN_SECONDS) {
      return {
        ok: false,
        message: `Please wait ${Math.ceil(
          OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLast,
        )}s before requesting another code.`,
      };
    }
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const countRows = await db.query(
    `SELECT COUNT(*) AS "count" FROM otps WHERE identifier = $1 AND purpose = $2 AND created_at > $3`,
    [identifier, purpose, hourAgo],
  );
  if (Number(countRows[0].count) >= OTP_MAX_SENDS_PER_HOUR) {
    return {
      ok: false,
      message: "Too many code requests. Please try again later.",
    };
  }

  return { ok: true };
};

const createOtp = async ({ identifier, purpose, channel, payload }) => {
  const code = generateOtp();
  const hash = await hashOtp(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  const result = await db.query(
    `INSERT INTO otps (purpose, identifier, channel, otp_hash, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      purpose,
      identifier,
      channel,
      hash,
      payload ? JSON.stringify(payload) : null,
      expiresAt,
    ],
  );

  return { code, otpId: result[0].id };
};

// If the actual send (SMS/email) fails after the OTP row was already
// created, remove it -- otherwise the user is stuck in limbo: unable to
// verify a code they never received, and blocked from retrying immediately
// by the cooldown check, which looks at the most recent row regardless of
// whether it was ever successfully delivered.
const discardOtp = (otpId) =>
  db
    .query(`DELETE FROM otps WHERE id = $1`, [otpId])
    .catch((err) => console.error("Failed to discard undeliverable OTP:", err));

const getActiveOtp = async (identifier, purpose) => {
  const rows = await db.query(
    `SELECT * FROM otps
      WHERE identifier = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [identifier, purpose],
  );
  return rows[0] || null;
};

// ---------------------------------------------------------------------
// Registration (SMS OTP verification before the account is created)
// ---------------------------------------------------------------------

exports.requestRegistrationOtp = async (req, res) => {
  const { username, email, phone, password } = req.body;

  if (!username || !email || !phone || !password) {
    return res.status(400).json({ message: "All fields are required." });
  }

  const normalizedPhone = normalizePhilippinePhone(phone);
  if (!normalizedPhone) {
    return res
      .status(400)
      .json({ message: "Please enter a valid Philippine mobile number." });
  }

  try {
    const existingEmail = await db.query(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );
    if (existingEmail.length > 0) {
      return res.status(400).json({ message: "Email is already registered." });
    }

    const existingPhone = await db.query(
      "SELECT id FROM users WHERE phone = $1",
      [normalizedPhone],
    );
    if (existingPhone.length > 0) {
      return res
        .status(400)
        .json({ message: "This mobile number is already registered." });
    }

    const rateCheck = await canSendNewOtp(email, "registration");
    if (!rateCheck.ok) {
      return res.status(429).json({ message: rateCheck.message });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Replace any earlier unfinished attempt for this email
    await db.query(
      `DELETE FROM otps WHERE identifier = $1 AND purpose = 'registration' AND consumed_at IS NULL`,
      [email],
    );

    const { code, otpId } = await createOtp({
      identifier: email,
      purpose: "registration",
      channel: "sms",
      payload: { username, phone: normalizedPhone, passwordHash },
    });

    try {
      await sendOtpSms(normalizedPhone, code, "Welcome to ALAI-eh!");
    } catch (sendErr) {
      await discardOtp(otpId);
      throw sendErr;
    }

    res.json({ message: "We sent a verification code to your phone.", email });
  } catch (err) {
    console.error("Registration OTP error:", err);
    res
      .status(500)
      .json({ message: "Failed to send verification code. Please try again." });
  }
};

exports.resendRegistrationOtp = async (req, res) => {
  const { email } = req.body;

  try {
    const pending = await getActiveOtp(email, "registration");
    if (!pending) {
      return res.status(404).json({
        message:
          "No pending registration found for this email. Please start over.",
      });
    }

    const rateCheck = await canSendNewOtp(email, "registration");
    if (!rateCheck.ok) {
      return res.status(429).json({ message: rateCheck.message });
    }

    await db.query(`UPDATE otps SET consumed_at = NOW() WHERE id = $1`, [
      pending.id,
    ]);

    const { code, otpId } = await createOtp({
      identifier: email,
      purpose: "registration",
      channel: "sms",
      payload: pending.payload,
    });

    try {
      await sendOtpSms(
        pending.payload.phone,
        code,
        "Your new ALAI-eh verification code.",
      );
    } catch (sendErr) {
      await discardOtp(otpId);
      throw sendErr;
    }

    res.json({ message: "A new code has been sent." });
  } catch (err) {
    console.error("Resend registration OTP error:", err);
    res.status(500).json({ message: "Failed to resend code." });
  }
};

exports.verifyRegistrationOtp = async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ message: "Email and code are required." });
  }

  try {
    const pending = await getActiveOtp(email, "registration");
    if (!pending) {
      return res.status(400).json({
        message:
          "No pending registration found, or it has expired. Please start over.",
      });
    }

    if (new Date(pending.expires_at) < new Date()) {
      return res
        .status(400)
        .json({ message: "This code has expired. Please request a new one." });
    }

    if (pending.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many incorrect attempts. Please request a new code.",
      });
    }

    const isMatch = await compareOtp(otp, pending.otp_hash);
    if (!isMatch) {
      await db.query(`UPDATE otps SET attempts = attempts + 1 WHERE id = $1`, [
        pending.id,
      ]);
      return res
        .status(400)
        .json({ message: "Incorrect code. Please try again." });
    }

    const { username, phone, passwordHash } = pending.payload;

    const result = await db.query(
      `INSERT INTO users (username, email, password, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, email, passwordHash, phone],
    );
    const userId = result[0].id;

    await db.query(`UPDATE otps SET consumed_at = NOW() WHERE id = $1`, [
      pending.id,
    ]);

    notifyUser(userId, {
      type: "registration",
      title: "Welcome to ALAI-eh!",
      message: "Your account has been created and verified successfully.",
      link: "/profile",
    });

    // Auto-login right after verification -- no reason to make them sign in
    // again immediately after proving who they are.
    const token = jwt.sign(
      { id: userId, username, email, role: "user" },
      JWT_SECRET_KEY,
      { expiresIn: "1h" },
    );

    res.json({
      success: "Account verified successfully!",
      token,
      user: { id: userId, username, email, role: "user" },
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        message:
          "This email or phone number was just registered by someone else. Please try again with different details.",
      });
    }
    console.error("Verify registration OTP error:", err);
    res
      .status(500)
      .json({ message: "Something went wrong verifying your code." });
  }
};

// ---------------------------------------------------------------------
// Password recovery (user picks SMS or email for the OTP)
// ---------------------------------------------------------------------

// Step 1: look up the account and return masked contact options, so the
// frontend can show "Send to jo****e@gmail.com" / "Send to 0917****567"
// without exposing the full address/number.
exports.lookupRecoveryOptions = async (req, res) => {
  const { email } = req.body;

  try {
    const rows = await db.query("SELECT phone FROM users WHERE email = $1", [
      email,
    ]);
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ message: "We couldn't find an account with that email." });
    }

    const phone = rows[0].phone;
    res.json({
      maskedEmail: maskEmail(email),
      maskedPhone: phone ? maskPhone(phone) : null,
      smsAvailable: !!phone,
    });
  } catch (err) {
    console.error("Recovery lookup error:", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
};

// Step 2: send the OTP via whichever channel the user picked.
exports.requestPasswordResetOtp = async (req, res) => {
  const { email, channel } = req.body;

  if (!email || !["email", "sms"].includes(channel)) {
    return res
      .status(400)
      .json({ message: "Email and a valid recovery method are required." });
  }

  try {
    const rows = await db.query(
      "SELECT id, username, phone FROM users WHERE email = $1",
      [email],
    );
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ message: "We couldn't find an account with that email." });
    }
    const user = rows[0];

    if (channel === "sms" && !user.phone) {
      return res.status(400).json({
        message:
          "No phone number is on file for this account. Try email recovery instead.",
      });
    }

    const rateCheck = await canSendNewOtp(email, "password_reset");
    if (!rateCheck.ok) {
      return res.status(429).json({ message: rateCheck.message });
    }

    await db.query(
      `DELETE FROM otps WHERE identifier = $1 AND purpose = 'password_reset' AND consumed_at IS NULL`,
      [email],
    );

    const { code, otpId } = await createOtp({
      identifier: email,
      purpose: "password_reset",
      channel,
    });

    try {
      if (channel === "sms") {
        await sendOtpSms(user.phone, code, "ALAI-eh password reset request.");
      } else {
        await sendEmail(
          email,
          "Reset your ALAI-eh password",
          `<div style="font-family:Arial,Helvetica,sans-serif;color:#333;line-height:1.6">
             <p>Hi ${user.username},</p>
             <p>Your password reset code is <b style="font-size:1.2em;letter-spacing:2px">${code}</b>.
                It expires in ${OTP_TTL_MINUTES} minutes.</p>
             <p>If you didn't request this, you can safely ignore this email -- your password won't change.</p>
           </div>`,
        );
      }
    } catch (sendErr) {
      await discardOtp(otpId);
      throw sendErr;
    }

    res.json({
      message: `A verification code has been sent via ${channel === "sms" ? "SMS" : "email"}.`,
    });
  } catch (err) {
    console.error("Password reset OTP request error:", err);
    res
      .status(500)
      .json({ message: "Failed to send reset code. Please try again." });
  }
};

exports.resendPasswordResetOtp = async (req, res) => {
  const { email } = req.body;

  try {
    const pending = await getActiveOtp(email, "password_reset");
    if (!pending) {
      return res.status(404).json({
        message:
          "No pending reset request found for this email. Please start over.",
      });
    }

    const rateCheck = await canSendNewOtp(email, "password_reset");
    if (!rateCheck.ok) {
      return res.status(429).json({ message: rateCheck.message });
    }

    const rows = await db.query(
      "SELECT username, phone FROM users WHERE email = $1",
      [email],
    );
    const user = rows[0];

    await db.query(`UPDATE otps SET consumed_at = NOW() WHERE id = $1`, [
      pending.id,
    ]);

    const { code, otpId } = await createOtp({
      identifier: email,
      purpose: "password_reset",
      channel: pending.channel,
    });

    try {
      if (pending.channel === "sms") {
        await sendOtpSms(
          user.phone,
          code,
          "Your new ALAI-eh password reset code.",
        );
      } else {
        await sendEmail(
          email,
          "Your new ALAI-eh password reset code",
          `<p>Hi ${user.username},</p><p>Your new password reset code is <b>${code}</b>. It expires in ${OTP_TTL_MINUTES} minutes.</p>`,
        );
      }
    } catch (sendErr) {
      await discardOtp(otpId);
      throw sendErr;
    }

    res.json({ message: "A new code has been sent." });
  } catch (err) {
    console.error("Resend password reset OTP error:", err);
    res.status(500).json({ message: "Failed to resend code." });
  }
};

// Step 3: verify the code, issue a short-lived reset token.
exports.verifyPasswordResetOtp = async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ message: "Email and code are required." });
  }

  try {
    const pending = await getActiveOtp(email, "password_reset");
    if (!pending) {
      return res.status(400).json({
        message:
          "No pending reset request found, or it has expired. Please start over.",
      });
    }

    if (new Date(pending.expires_at) < new Date()) {
      return res
        .status(400)
        .json({ message: "This code has expired. Please request a new one." });
    }

    if (pending.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many incorrect attempts. Please request a new code.",
      });
    }

    const isMatch = await compareOtp(otp, pending.otp_hash);
    if (!isMatch) {
      await db.query(`UPDATE otps SET attempts = attempts + 1 WHERE id = $1`, [
        pending.id,
      ]);
      return res
        .status(400)
        .json({ message: "Incorrect code. Please try again." });
    }

    // Not marked consumed here -- only once the password is actually
    // changed (see resetPassword), so the reset token below can't be
    // replayed to reset the password a second time.
    const resetToken = jwt.sign(
      { purpose: "password_reset", email, otpId: pending.id },
      JWT_SECRET_KEY,
      { expiresIn: "10m" },
    );

    res.json({ message: "Code verified.", resetToken });
  } catch (err) {
    console.error("Verify password reset OTP error:", err);
    res
      .status(500)
      .json({ message: "Something went wrong verifying your code." });
  }
};

// Step 4: actually set the new password.
exports.resetPassword = async (req, res) => {
  const { resetToken, newPassword } = req.body;

  if (!resetToken || !newPassword) {
    return res
      .status(400)
      .json({ message: "Missing reset token or new password." });
  }
  if (newPassword.length < 6) {
    return res
      .status(400)
      .json({ message: "Password must be at least 6 characters." });
  }

  let decoded;
  try {
    decoded = jwt.verify(resetToken, JWT_SECRET_KEY);
  } catch {
    return res
      .status(400)
      .json({ message: "This reset session has expired. Please start over." });
  }

  if (decoded.purpose !== "password_reset") {
    return res.status(400).json({ message: "Invalid reset token." });
  }

  try {
    // The OTP row must still be un-consumed -- this is what actually
    // prevents the same reset token being replayed to change the
    // password more than once.
    const otpRows = await db.query(
      `SELECT id FROM otps
        WHERE id = $1 AND identifier = $2 AND purpose = 'password_reset' AND consumed_at IS NULL`,
      [decoded.otpId, decoded.email],
    );

    if (otpRows.length === 0) {
      return res.status(400).json({
        message: "This reset link has already been used. Please start over.",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = await db.query(
      "UPDATE users SET password = $1 WHERE email = $2 RETURNING id",
      [passwordHash, decoded.email],
    );

    if (result.length === 0) {
      return res.status(404).json({ message: "Account not found." });
    }

    await db.query(`UPDATE otps SET consumed_at = NOW() WHERE id = $1`, [
      decoded.otpId,
    ]);

    notifyUser(result[0].id, {
      type: "password_reset",
      title: "Password changed",
      message:
        "Your password was reset successfully. If this wasn't you, please contact us immediately.",
      link: "/profile",
    });

    res.json({ success: "Password reset successfully. You can now sign in." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ message: "Failed to reset password." });
  }
};

// ---------------------------------------------------------------------
// Resort owner password recovery (email OTP only -- no SMS option,
// unlike the customer flow above, since owners aren't required to have
// a phone number on file)
// ---------------------------------------------------------------------

exports.requestOwnerPasswordResetOtp = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const rows = await db.query(
      "SELECT id, username FROM resort_owners WHERE email = $1",
      [email],
    );
    if (rows.length === 0) {
      return res.status(404).json({
        message: "We couldn't find an owner account with that email.",
      });
    }
    const owner = rows[0];

    const rateCheck = await canSendNewOtp(email, "owner_password_reset");
    if (!rateCheck.ok) {
      return res.status(429).json({ message: rateCheck.message });
    }

    await db.query(
      `DELETE FROM otps WHERE identifier = $1 AND purpose = 'owner_password_reset' AND consumed_at IS NULL`,
      [email],
    );

    const { code, otpId } = await createOtp({
      identifier: email,
      purpose: "owner_password_reset",
      channel: "email",
    });

    try {
      await sendEmail(
        email,
        "Reset your ALAI-eh Owner Portal password",
        `<div style="font-family:Arial,Helvetica,sans-serif;color:#333;line-height:1.6">
           <p>Hi ${owner.username},</p>
           <p>Your password reset code is <b style="font-size:1.2em;letter-spacing:2px">${code}</b>.
              It expires in ${OTP_TTL_MINUTES} minutes.</p>
           <p>If you didn't request this, you can safely ignore this email -- your password won't change.</p>
         </div>`,
      );
    } catch (sendErr) {
      await discardOtp(otpId);
      throw sendErr;
    }

    res.json({
      message: "A verification code has been sent to your email.",
      maskedEmail: maskEmail(email),
    });
  } catch (err) {
    console.error("Owner password reset OTP request error:", err);
    res
      .status(500)
      .json({ message: "Failed to send reset code. Please try again." });
  }
};

exports.resendOwnerPasswordResetOtp = async (req, res) => {
  const { email } = req.body;

  try {
    const pending = await getActiveOtp(email, "owner_password_reset");
    if (!pending) {
      return res.status(404).json({
        message:
          "No pending reset request found for this email. Please start over.",
      });
    }

    const rateCheck = await canSendNewOtp(email, "owner_password_reset");
    if (!rateCheck.ok) {
      return res.status(429).json({ message: rateCheck.message });
    }

    const rows = await db.query(
      "SELECT username FROM resort_owners WHERE email = $1",
      [email],
    );
    const owner = rows[0];

    await db.query(`UPDATE otps SET consumed_at = NOW() WHERE id = $1`, [
      pending.id,
    ]);

    const { code, otpId } = await createOtp({
      identifier: email,
      purpose: "owner_password_reset",
      channel: "email",
    });

    try {
      await sendEmail(
        email,
        "Your new ALAI-eh Owner Portal reset code",
        `<p>Hi ${owner.username},</p><p>Your new password reset code is <b>${code}</b>. It expires in ${OTP_TTL_MINUTES} minutes.</p>`,
      );
    } catch (sendErr) {
      await discardOtp(otpId);
      throw sendErr;
    }

    res.json({ message: "A new code has been sent." });
  } catch (err) {
    console.error("Resend owner password reset OTP error:", err);
    res.status(500).json({ message: "Failed to resend code." });
  }
};

exports.verifyOwnerPasswordResetOtp = async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ message: "Email and code are required." });
  }

  try {
    const pending = await getActiveOtp(email, "owner_password_reset");
    if (!pending) {
      return res.status(400).json({
        message:
          "No pending reset request found, or it has expired. Please start over.",
      });
    }

    if (new Date(pending.expires_at) < new Date()) {
      return res
        .status(400)
        .json({ message: "This code has expired. Please request a new one." });
    }

    if (pending.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many incorrect attempts. Please request a new code.",
      });
    }

    const isMatch = await compareOtp(otp, pending.otp_hash);
    if (!isMatch) {
      await db.query(`UPDATE otps SET attempts = attempts + 1 WHERE id = $1`, [
        pending.id,
      ]);
      return res
        .status(400)
        .json({ message: "Incorrect code. Please try again." });
    }

    const resetToken = jwt.sign(
      { purpose: "owner_password_reset", email, otpId: pending.id },
      JWT_SECRET_KEY,
      { expiresIn: "10m" },
    );

    res.json({ message: "Code verified.", resetToken });
  } catch (err) {
    console.error("Verify owner password reset OTP error:", err);
    res
      .status(500)
      .json({ message: "Something went wrong verifying your code." });
  }
};

exports.resetOwnerPassword = async (req, res) => {
  const { resetToken, newPassword } = req.body;

  if (!resetToken || !newPassword) {
    return res
      .status(400)
      .json({ message: "Missing reset token or new password." });
  }
  if (newPassword.length < 6) {
    return res
      .status(400)
      .json({ message: "Password must be at least 6 characters." });
  }

  let decoded;
  try {
    decoded = jwt.verify(resetToken, JWT_SECRET_KEY);
  } catch {
    return res
      .status(400)
      .json({ message: "This reset session has expired. Please start over." });
  }

  if (decoded.purpose !== "owner_password_reset") {
    return res.status(400).json({ message: "Invalid reset token." });
  }

  try {
    const otpRows = await db.query(
      `SELECT id FROM otps
        WHERE id = $1 AND identifier = $2 AND purpose = 'owner_password_reset' AND consumed_at IS NULL`,
      [decoded.otpId, decoded.email],
    );

    if (otpRows.length === 0) {
      return res.status(400).json({
        message: "This reset link has already been used. Please start over.",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = await db.query(
      "UPDATE resort_owners SET password = $1 WHERE email = $2 RETURNING id",
      [passwordHash, decoded.email],
    );

    if (result.length === 0) {
      return res.status(404).json({ message: "Account not found." });
    }

    await db.query(`UPDATE otps SET consumed_at = NOW() WHERE id = $1`, [
      decoded.otpId,
    ]);

    res.json({ success: "Password reset successfully. You can now sign in." });
  } catch (err) {
    console.error("Reset owner password error:", err);
    res.status(500).json({ message: "Failed to reset password." });
  }
};

// ---------------------------------------------------------------------
// Login (unchanged)
// ---------------------------------------------------------------------

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    let result = await db.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    let user = result[0];

    if (!user) {
      result = await db.query("SELECT * FROM admin WHERE email = $1", [email]);
      user = result[0];
    }

    if (!user) {
      result = await db.query("SELECT * FROM resort_owners WHERE email = $1", [
        email,
      ]);
      user = result[0];
    }

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await handleLogin(user, password, res);
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Used only by the admin sign-in page. Unlike login() above, this never
// touches the users table, so there's no ambiguity if an email happens to
// exist in both tables (e.g. an admin who also has/had a customer account).
exports.adminLogin = async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await db.query("SELECT * FROM admin WHERE email = $1", [
      email,
    ]);
    const user = result[0];

    if (!user) {
      return res.status(404).json({ message: "Admin account not found" });
    }

    await handleLogin(user, password, res);
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Used only by the resort owner sign-in page. Same reasoning as
// adminLogin -- a dedicated table and a dedicated endpoint avoids any
// ambiguity with the customer-facing users table.
exports.ownerLogin = async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await db.query(
      "SELECT * FROM resort_owners WHERE email = $1",
      [email],
    );
    const user = result[0];

    if (!user) {
      return res
        .status(404)
        .json({ message: "Resort owner account not found" });
    }

    await handleLogin(user, password, res);
  } catch (err) {
    console.error("Owner login error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const handleLogin = async (user, password, res) => {
  try {
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role || "user",
      },
      JWT_SECRET_KEY,
      { expiresIn: JWT_EXPIRES_IN },
    );

    res.json({
      success: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role || "user",
      },
    });
  } catch (err) {
    console.error("Password compare error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
