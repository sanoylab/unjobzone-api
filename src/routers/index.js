const express = require("express");

const router = express.Router();

const jobs = require("./job");


router.use("/jobs", jobs);

module.exports = router;
