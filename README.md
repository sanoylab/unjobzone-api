
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

---

