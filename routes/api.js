const express = require("express");
const router = express.Router();

router.use(require("./auth"));
router.use(require("./resident"));
router.use(require("./finance"));
router.use(require("./extractAmount"));
router.use(require("./uploadDrive"));
router.use(require("./monthlyFee"));
router.use("/sheet", require("./sheet"));

module.exports = router;
