const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  getAll,
  getById,
  getFeaturedBlog
} = require("../controllers/blogController");
/**
 * @swagger
 * components:
 *   schemas:
 *     Blog:
 *       type: object
 *       required:
 *        - id
 *        - title
 *        - content
 *        - featured
 *        - thumbnail
 *       properties:
 *         id:
 *           type: int
 *           description: The unique id of the blog
 *         title:
 *           type: string
 *           description: Blog Id
 *         content:
 *           type: string
 *           description:  Blog Type
 *         featured:
 *           type: string
 *           description: Blog Logo
 *         thumbnail:
 *           type: string
 *           description: Short Name
 *       example:
 *         id: 1
 *         title: "Blog Title"
 *         content: "Blog Content"
 *         featured: "Yes"
 *         thumbnail: "http://www.example.com"

 */

/**
 * @swagger
 * /api/v1/blogs:
 *   get:
 *     summary: Returns the list of all the blogs
 *     tags: [Blog]
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
 *         description: The list of the blogs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Blog'
 */
router.get("/", auth, getAll);

/**
 * @swagger
 * /api/v1/blogs/{id}:
 *   get:
 *     summary: Get a blog by id
 *     tags: [Blog]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: The blog id
 *     responses:
 *       200:
 *         description: The blog information filtered by id
 *         contents:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Blog'
 *       404:
 *         description: The blog was not found
 */

router.get("/:id", auth, getById);


/**
 * @swagger
 * /api/v1/blogs/featured/list:
 *   get:
 *     summary: Get a featured blog 
 *     tags: [Blog]
 *     responses:
 *       200:
 *         description: The featured blog
 *         contents:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Blog'
 *       404:
 *         description: The blog was not found
 */

router.get("/featured/list", auth, getFeaturedBlog);
module.exports = router;