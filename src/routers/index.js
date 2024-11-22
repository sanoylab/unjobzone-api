const express = require("express");

const router = express.Router();

const jobs = require("./job");
const organizations = require("./organization");


router.use("/jobs", jobs);
router.use("/organizations", organizations);


module.exports = router;
