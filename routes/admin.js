const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");

// Hanya role admin & bendahara yang boleh akses
router.get("/dashboard", auth(["admin", "bendahara"]), (req, res) => {
  res.json({ message: "Dashboard OK" });
});

module.exports = router;
