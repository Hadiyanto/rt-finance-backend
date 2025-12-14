const express = require("express");
const router = express.Router();

router.use(require("./auth"));
router.use(require("./resident"));
router.use(require("./finance"));
router.use("/sheet", require("./sheet"));

module.exports = router;
