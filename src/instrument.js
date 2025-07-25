// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");

Sentry.init({
  dsn: "https://f91aa38c9dfee8c8a50a13db3d37151f@o4504957350445056.ingest.us.sentry.io/4509729367785472",

  // Set environment
  environment: process.env.NODE_ENV || 'development',

  // Set sample rate for performance monitoring
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Set sample rate for profiling
  profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Additional integrations
  integrations: [
    // Add profiling integration
    nodeProfilingIntegration(),
    // Enable automatic span creation for database queries
    Sentry.mongoIntegration(),
    Sentry.postgresIntegration(),
    // Enable automatic span creation for HTTP requests
    Sentry.httpIntegration({ tracing: true }),
  ],

  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: false, // Changed to false for better privacy

  // Add release information if available
  release: process.env.npm_package_version,

  // Configure beforeSend to filter out certain errors
  beforeSend(event, hint) {
    // Don't send events in development unless explicitly testing
    if (process.env.NODE_ENV === 'development' && !process.env.SENTRY_DEBUG) {
      return null;
    }
    return event;
  },

  // Enable debug mode in development
  debug: process.env.NODE_ENV === 'development',
});