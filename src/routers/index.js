const express = require("express");

const router = express.Router();

const jobs = require("./job");
const organizations = require("./organization");
const blogs = require("./blog");


router.use("/jobs", jobs);
router.use("/organizations", organizations);
router.use("/blogs", blogs);


module.exports = router;
