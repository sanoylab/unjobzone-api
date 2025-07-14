const express = require("express");

const router = express.Router();

const jobs = require("./job");
const organizations = require("./organization");
const blogs = require("./blog");
const etl = require("./etl");

router.use("/jobs", jobs);
router.use("/organizations", organizations);
router.use("/blogs", blogs);
router.use("/etl", etl);

module.exports = router;
