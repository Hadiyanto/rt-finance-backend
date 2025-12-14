const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const auth = require("../middlewares/auth");
const { PrismaClient } = require("@prisma/client");
const router = express.Router();

const prisma = new PrismaClient();


router.get("/auth/hash/:password", async (req, res) => {
  try {
    const hash = await bcrypt.hash(req.params.password, 10);
    res.json({ hash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate hash" });
  }
});

router.get("/auth/validate", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    res.json({ "valid": true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate hash" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    return res.status(400).json({ error: "User not found" });
  }

  const valid = await bcrypt.compare(password, user.password);

  if (!valid) {
    return res.status(400).json({ error: "Invalid password" });
  }

  // Generate JWT
  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({
    message: "Login success",
    token,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
    },
  });
});

module.exports = router;
