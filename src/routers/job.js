const express = require("express");
const router = express.Router();
const {auth} = require("../middleware/auth");

const {
  getAll,
  getById, 
  getFilteredJobs,
  getAllJobCategories,
  getAllJobOrganizations
} = require("../controllers/jobController");
/**
 * @swagger
 * components:
 *   schemas:
 *     Job:
 *       type: object
 *       required:
 *        - id
 *        - job_id
 *        - language
 *        - category_code
 *        - job_title
 *        - job_code_title
 *        - job_description
 *        - job_family_code
 *        - job_level
 *        - duty_station
 *        - recruitment_type
 *        - start_date
 *        - end_date
 *        - dept
 *        - jn
 *        - jf
 *        - jc
 *        - jl
 *        - created
 *        - data_source 
 *       properties:
 *         id:
 *           type: int
 *           description: The unique id of the job
 *         job_id:
 *           type: string
 *           description: Job Id
 *         language:
 *           type: string
 *           description: Language
 *         category_code:
 *           type: string
 *           description: Category Code
 *         job_title:
 *           type: string
 *           description: Job Title
 *         job_code_title:
 *           type: string
 *           description: Job Code Title
 *         job_description:
 *           type: string
 *           description: Job Description
 *         job_family_code:
 *           type: string
 *           description: Job Family Code
 *         job_level:
 *           type: string
 *           description: Job Level
 *         duty_station:
 *           type: string
 *           description: Duty Station
 *         recruitment_type:
 *           type: string 
 *           description: Recruitment Type
 *         start_date:
 *           type: string
 *           description: Start Date
 *         end_date:
 *           type: string
 *           description: End Date
 *         dept:
 *           type: string
 *           description: Department
 *         jn:
 *           type: string
 *           description: JN
 *         jf:
 *           type: string
 *           description: JF
 *         jc:
 *           type: string
 *           description: JC
 *         jl:
 *           type: string
 *           description: JL
 *         created:
 *           type: string
 *           description: Created
 *         data_source:
 *           type: string
 *           description: Data Source
 *       example:
 *         id: 1
 *         job_id: "1"
 *         language: "en"
 *         category_code: "CON"
 *         job_title: "Software Engineer"
 *         job_code_title: "Software Engineer"
 *         job_description: "Software Engineer description here"
 *         job_family_code: "123"
 *         job_level: "123"
 *         duty_station: "New York, USA"
 *         recruitment_type: "Full Time"
 *         start_date: "2021-09-01"
 *         end_date: "2021-09-01"
 *         dept: "International Monetary Fund"
 *         jn: "Economic, Social and Development"
 *         jf: "Environmental Affairs"
 *         jc: "Consultants"
 *         jl: "CON"
 *         created: "2021-09-01"
 *         data_source: "inspira"
 */

/**
 * @swagger
 * /api/v1/jobs:
 *   get:
 *     summary: Returns the list of all the jobs
 *     tags: [Job]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: The number of jobs to skip before starting to collect the result
 *       - in: query
 *         name: size
 *         schema:
 *           type: integer
 *         description: The number of jobs to return
 *     responses:
 *       200:
 *         description: The list of the jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Job'
 */
router.get("/", auth, getAll);

/**
 * @swagger
 * /api/v1/jobs/{id}:
 *   get:
 *     summary: Get a job by id
 *     tags: [Job]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The job id
 *     responses:
 *       200:
 *         description: The job information filtered by id
 *         contents:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Job'
 *       404:
 *         description: The job was not found
 */

router.get("/:id", auth, getById);

/**
 * @swagger
 * /api/v1/jobs/filtered/{query}:
 *   get:
 *     summary: Get jobs by filters
 *     tags: [Job]
 *     parameters:
 *       - in: query
 *         name: duty_station
 *         schema:
 *           type: string
 *         description: Duty Station
 *       - in: query
 *         name: dept
 *         schema:
 *           type: string
 *         description: Department
 *       - in: query
 *         name: recruitment_type
 *         schema:
 *           type: string
 *         description: Recruitment Type
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *         description: Start Date
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *         description: End Date
 *       - in: query
 *         name: jn
 *         schema:
 *           type: string
 *         description: JN
 *       - in: query
 *         name: jf
 *         schema:
 *           type: string
 *         description: JF
 *       - in: query
 *         name: jc
 *         schema:
 *           type: string
 *         description: JC
 *       - in: query
 *         name: jl
 *         schema:
 *           type: string
 *         description: JL
 *     responses:
 *       200:
 *         description: The job information filtered by the provided parameters
 *         contents:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Job'
 */
router.get("/filtered/:query", auth, getFilteredJobs);


/**
 * @swagger
 * /api/v1/jobs/categories/list:
 *   get:
 *     summary: Returns the list of all the job categories
 *     tags: [Job]
 *     responses:
 *       200:
 *         description: The list of the job categories
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Job'
 */
router.get("/categories/list",auth,  getAllJobCategories);



/**
 * @swagger
 * /api/v1/jobs/organizations/list:
 *   get:
 *     summary: Returns the list of all the job organizations
 *     tags: [Job]
 *     responses:
 *       200:
 *         description: The list of the job organizations
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Job'
 */
router.get("/organizations/list",auth,  getAllJobOrganizations);


module.exports = router;
