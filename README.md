
# UN Job Zone ETL API

## Environment Variables

Make sure to set the following environment variables:

```bash
# Application
NODE_ENV=development # or production
PORT=3000

# Sentry Configuration (Optional)
SENTRY_DEBUG=true # Set to true to enable Sentry in development
```

## Sentry Error Monitoring

This application includes Sentry for error monitoring and performance tracking. 

### Configuration
- Sentry is configured in `src/instrument.js`
- In development, errors are only sent to Sentry if `SENTRY_DEBUG=true` is set
- In production, all errors are automatically tracked

### Testing Sentry Integration

You can test the Sentry integration using these endpoints:

1. **Basic Error Test**: `GET /debug-sentry`
   - Throws a simple synchronous error

2. **Async Error Test**: `GET /debug-sentry/async` 
   - Throws an asynchronous error

3. **Unhandled Promise Test**: `GET /debug-sentry/unhandled`
   - Triggers an unhandled promise rejection

4. **Message Test**: `GET /debug-sentry/test`
   - Sends test messages and breadcrumbs to Sentry

### Features
- Automatic error capture and reporting
- Performance monitoring and profiling
- Database query tracking (PostgreSQL)
- HTTP request tracking
- Breadcrumb collection for better debugging

## Database Cleanup Process

The application now includes a comprehensive database cleanup process that runs automatically:

### Per-Organization Cleanup
- **When**: After each organization's ETL process completes successfully
- **What**: Removes expired jobs and duplicate entries
- **Benefits**: Keeps the database clean throughout the ETL process
- **Error Handling**: Cleanup failures don't stop the ETL process

### Final Safety Cleanup
- **When**: After all organizations have been processed
- **What**: Final safety check to catch any remaining expired or duplicate jobs
- **Purpose**: Ensures database integrity at the end of the complete ETL cycle

### Cleanup Features
- **Expired Jobs**: Automatically removes jobs where `end_date < NOW()`
- **Duplicate Detection**: 
  - Same-org duplicates: Same organization + title + dates + location
  - Cross-org duplicates: Same title + location + end date (keeps first posted)
- **Statistics**: Detailed reporting of cleanup actions
- **Error Resilience**: Individual cleanup failures don't affect the overall process

### Monitoring
The ETL summary report now includes:
- Per-organization cleanup status
- Final cleanup statistics
- Total jobs removed (expired vs duplicates)
- Error reporting for failed cleanups

---

