const express = require("express");
const router = express.Router();
const path = require("path");
const { auth, optionalAuth, rateLimiter } = require("../middleware/auth");
const {
  getDashboard,
  getAllStatus,
  getOrganizationHistory,
  getStatistics,
  getHealthCheck,
  triggerETL,
  clearCache,
  fixDatabaseSchema,
  testLinkedInETL,
  triggerLinkedInPost,
  diagnoseLinkedInDeployment
} = require("../controllers/etlController");

// Apply rate limiting to all ETL routes
router.use(rateLimiter(15 * 60 * 1000, 100)); // 100 requests per 15 minutes

// Public routes (no authentication required)
// Serve the dashboard HTML page
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, '../views/etl-dashboard.html'));
});

// Health check endpoint (public for monitoring tools)
router.get("/health", getHealthCheck);

// Protected routes (authentication required)
/**
 * @swagger
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *   schemas:
 *     ETLStatus:
 *       type: object
 *       properties:
 *         organization_name:
 *           type: string
 *           description: Name of the organization
 *         status:
 *           type: string
 *           enum: [running, success, failed]
 *           description: Current ETL status
 *         processed_count:
 *           type: integer
 *           description: Number of jobs processed
 *         success_count:
 *           type: integer
 *           description: Number of jobs successfully inserted
 *         error_count:
 *           type: integer
 *           description: Number of jobs that failed
 *         jobs_in_db:
 *           type: integer
 *           description: Total jobs currently in database
 *         duration_seconds:
 *           type: integer
 *           description: ETL run duration in seconds
 *         start_time:
 *           type: string
 *           format: date-time
 *         end_time:
 *           type: string
 *           format: date-time
 *         created_at:
 *           type: string
 *           format: date-time
 *       example:
 *         organization_name: "UNHCR"
 *         status: "success"
 *         processed_count: 45
 *         success_count: 43
 *         error_count: 2
 *         jobs_in_db: 156
 *         duration_seconds: 125
 *         start_time: "2024-01-15T06:00:00Z"
 *         end_time: "2024-01-15T06:02:05Z"
 *     
 *     APIResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         timestamp:
 *           type: string
 *           format: date-time
 *         message:
 *           type: string
 *         error:
 *           type: string
 *         data:
 *           type: object
 *     
 *     PaginationResponse:
 *       allOf:
 *         - $ref: '#/components/schemas/APIResponse'
 *         - type: object
 *           properties:
 *             data:
 *               type: object
 *               properties:
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     size:
 *                       type: integer
 *                     totalRecords:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *                     hasNext:
 *                       type: boolean
 *                     hasPrev:
 *                       type: boolean
 */

/**
 * @swagger
 * /api/v1/etl/dashboard:
 *   get:
 *     summary: Get comprehensive ETL dashboard data
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: ETL dashboard data including status, statistics, and recent activity
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         organizations:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/ETLStatus'
 *                         statistics:
 *                           type: object
 *                           properties:
 *                             totalOrganizations:
 *                               type: integer
 *                             successfulOrgs:
 *                               type: integer
 *                             failedOrgs:
 *                               type: integer
 *                             totalJobs:
 *                               type: integer
 *                             avgDuration:
 *                               type: number
 *                         recentActivity:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/ETLStatus'
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       429:
 *         description: Too many requests
 *       500:
 *         description: Internal server error
 */
router.get("/dashboard", auth, getDashboard);

/**
 * @swagger
 * /api/v1/etl/status:
 *   get:
 *     summary: Get current ETL status for all organizations
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: size
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Latest ETL status for all organizations
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginationResponse'
 *       400:
 *         description: Invalid pagination parameters
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests
 */
router.get("/status", auth, getAllStatus);

/**
 * @swagger
 * /api/v1/etl/history/{organizationName}:
 *   get:
 *     summary: Get ETL history for a specific organization
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: organizationName
 *         required: true
 *         schema:
 *           type: string
 *           maxLength: 50
 *         description: Name of the organization (e.g., UNHCR, WFP)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 1
 *       - in: query
 *         name: size
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *     responses:
 *       200:
 *         description: ETL history for the specified organization
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/PaginationResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         organization:
 *                           type: string
 *                         history:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/ETLStatus'
 *       400:
 *         description: Invalid organization name or pagination parameters
 *       404:
 *         description: Organization not found
 *       401:
 *         description: Unauthorized
 */
router.get("/history/:organizationName", auth, getOrganizationHistory);

/**
 * @swagger
 * /api/v1/etl/statistics:
 *   get:
 *     summary: Get ETL statistics and analytics
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *           default: 7
 *         description: Number of days to include in statistics
 *     responses:
 *       200:
 *         description: ETL statistics and performance analytics
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         dailyStats:
 *                           type: array
 *                           items:
 *                             type: object
 *                         organizationStats:
 *                           type: array
 *                           items:
 *                             type: object
 *                         period:
 *                           type: string
 *                         generatedAt:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Invalid days parameter
 *       401:
 *         description: Unauthorized
 */
router.get("/statistics", auth, getStatistics);

/**
 * @swagger
 * /api/v1/etl/health:
 *   get:
 *     summary: Get ETL system health status
 *     tags: [ETL Monitoring]
 *     responses:
 *       200:
 *         description: ETL system is healthy
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           enum: [healthy, degraded]
 *                         totalOrganizations:
 *                           type: integer
 *                         recentRuns:
 *                           type: integer
 *                         currentlyRunning:
 *                           type: integer
 *                         lastActivity:
 *                           type: string
 *                           format: date-time
 *                         uptime:
 *                           type: number
 *       503:
 *         description: ETL system is degraded
 */
// Note: Health endpoint is defined above as public

/**
 * @swagger
 * /api/v1/etl/trigger:
 *   post:
 *     summary: Trigger manual ETL run
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               organizationName:
 *                 type: string
 *                 maxLength: 50
 *                 description: Optional - specific organization to run ETL for
 *     responses:
 *       202:
 *         description: ETL trigger accepted and queued
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/APIResponse'
 *       400:
 *         description: Invalid organization name
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests
 */
router.post("/trigger", auth, triggerETL);

/**
 * @swagger
 * /api/v1/etl/clear-cache:
 *   post:
 *     summary: Clear Redis cache for job data
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cache cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         clearedKeys:
 *                           type: integer
 *                           description: Number of cache keys cleared
 *                         keys:
 *                           type: array
 *                           items:
 *                             type: string
 *                           description: List of cleared cache keys
 *                         message:
 *                           type: string
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Redis server unavailable
 */
router.post("/clear-cache", auth, clearCache);

/**
 * @swagger
 * /api/v1/etl/fix-database-schema:
 *   post:
 *     summary: Fix missing database schema components (latest_etl_status view)
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Database schema fixed successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         tablesCreated:
 *                           type: integer
 *                           description: Number of tables created
 *                         viewsCreated:
 *                           type: integer
 *                           description: Number of views created
 *                         recordCount:
 *                           type: integer
 *                           description: Number of records in the view
 *                         message:
 *                           type: string
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Database error
 */
router.post("/fix-database-schema", auth, fixDatabaseSchema);

/**
 * @swagger
 * /api/v1/etl/test-linkedin:
 *   post:
 *     summary: Test LinkedIn ETL setup and configuration
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: LinkedIn ETL test completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         success:
 *                           type: boolean
 *                         message:
 *                           type: string
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: LinkedIn ETL configuration error
 */
router.post("/test-linkedin", auth, testLinkedInETL);

/**
 * @swagger
 * /api/v1/etl/trigger-linkedin-post:
 *   post:
 *     summary: Manually trigger LinkedIn job posting
 *     tags: [ETL Monitoring]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [expiring, network]
 *                 description: Type of LinkedIn post to create
 *               jobNetwork:
 *                 type: string
 *                 description: Job network category (required for type "network")
 *                 example: "Information and Telecommunication Technology"
 *     responses:
 *       200:
 *         description: LinkedIn post created successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         linkedinResponse:
 *                           type: object
 *                         message:
 *                           type: string
 *       400:
 *         description: Invalid request parameters
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: LinkedIn posting failed
 */
router.post("/trigger-linkedin-post", auth, triggerLinkedInPost);

/**
 * @swagger
 * /api/v1/etl/diagnose-linkedin-deployment:
 *   get:
 *     summary: Diagnose LinkedIn posting issues in deployment environment
 *     tags: [ETL Monitoring]
 *     responses:
 *       200:
 *         description: LinkedIn deployment diagnostics completed
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/APIResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         timestamp:
 *                           type: string
 *                         environment:
 *                           type: string
 *                         timezone:
 *                           type: object
 *                         credentials:
 *                           type: object
 *                         fileSystem:
 *                           type: object
 *                         database:
 *                           type: object
 *                         network:
 *                           type: object
 *                         system:
 *                           type: object
 *                         overall:
 *                           type: object
 *       500:
 *         description: Diagnostics failed
 */
router.get("/diagnose-linkedin-deployment", diagnoseLinkedInDeployment);

module.exports = router; 