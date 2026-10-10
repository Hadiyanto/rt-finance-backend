const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const db = require("../lib/db");
const { AppError } = require("../lib/errors");
const { signToken, requireAuth } = require("../lib/auth");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { code: "TOO_MANY_ATTEMPTS", message: "Terlalu banyak percobaan login, coba lagi 15 menit lagi" },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// Hash dummy agar waktu respons sama untuk email yang tidak terdaftar (tidak bisa dipakai menebak email).
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const { rows: [user] } = await db.query(
    "SELECT id, name, email, role, password_hash, is_active FROM app_user WHERE lower(email) = $1",
    [email]
  );
  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid || !user.is_active) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Email atau kata sandi salah");
  }

  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, role: user.role },
  });
});

router.get("/me", requireAuth(), (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
