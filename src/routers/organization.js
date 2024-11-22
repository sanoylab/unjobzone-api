const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  getAll,
  getById
} = require("../controllers/organizationController");
/**
 * @swagger
 * components:
 *   schemas:
 *     Organization:
 *       type: object
 *       required:
 *        - id
 *        - organization_type
 *        - logo
 *        - banner
 *        - short_name
 *        - long_name
 *        - headquarters
 *        - founded
 *        - about
 *        - website_url
 *        - twitter_url 
 *        - facebook_url
 *       properties:
 *         id:
 *           type: int
 *           description: The unique id of the organization
 *         organization_type:
 *           type: string
 *           description: Organization Id
 *         logo:
 *           type: string
 *           description:  Organization Type
 *         banner:
 *           type: string
 *           description: Organization Logo
 *         short_name:
 *           type: string
 *           description: Short Name
 *         long_name:
 *           type: string
 *           description: Long Name
 *         headquarters:
 *           type: string
 *           description: Headquarters
 *         founded:
 *           type: string
 *           description: Founded
 *         about:
 *           type: string
 *           description: About
 *         website_url:
 *           type: string
 *           description: Website URL
 *         twitter_url:
 *           type: string 
 *           description: Twitter URL
 *         facebook_url:
 *           type: string
 *           description: Facebook URL
 *       example:
 *         id: 1
 *         organization_type: "UN Agency"
 *         logo: "https://www.example.com/logo.png"
 *         banner: "https://www.example.com/banner.png"
 *         short_name: "UNICEF"
 *         long_name: "United Nations International Children's Emergency Fund"
 *         headquarters: "New York, USA"
 *         founded: "11 December 1946"
 *         about: "UNICEF works in over 190 countries and territories to save children's lives, to defend their rights, and to help them fulfill their potential, from early childhood through adolescence."
 *         website_url: "https://www.unicef.org/"
 *         twitter_url: "https://twitter.com/unicef"
 *         facebook_url: "https://www.facebook.com/unicef"
 */

/**
 * @swagger
 * /api/v1/organizations:
 *   get:
 *     summary: Returns the list of all the organizations
 *     tags: [Organization]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: The number of organizations to skip before starting to collect the result
 *       - in: query
 *         name: size
 *         schema:
 *           type: integer
 *         required: true
 *         description: The number of organizations to return
 *     responses:
 *       200:
 *         description: The list of the organizations
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Organization'
 */
router.get("/", auth, getAll);

/**
 * @swagger
 * /api/v1/organizations/{id}:
 *   get:
 *     summary: Get a organization by id
 *     tags: [Organization]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The organization id
 *     responses:
 *       200:
 *         description: The organization information filtered by id
 *         contents:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Organization'
 *       404:
 *         description: The organization was not found
 */

router.get("/:id", auth, getById);
module.exports = router;
