const jwt = require("jsonwebtoken");
const crypto = require("crypto");
require("dotenv").config();

// Helper function for timing-safe string comparison
const timingSafeEqual = (a, b) => {
  if (!a || !b) return false;
  
  // Ensure both strings are the same length for crypto.timingSafeEqual
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  
  // If lengths differ, compare against a dummy buffer to maintain constant time
  if (bufA.length !== bufB.length) {
    // Still perform a comparison to prevent timing attacks on length
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  
  return crypto.timingSafeEqual(bufA, bufB);
};

// Main authentication middleware - UNCHANGED to maintain backward compatibility
module.exports.auth = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
   
    if (!token) {
      return res.status(401).send("A token is required for authentication");
    }
    
    // Use timing-safe comparison to prevent timing attacks
    const validAccessToken = timingSafeEqual(token, process.env.ACCESS_TOKEN_SECRET);
    const validTempoToken = timingSafeEqual(token, process.env.TEMPO_ACCESS_TOKEN_SECRET);
    
    if(validAccessToken || validTempoToken){
        // Log authentication success for security auditing
        // Note: In production, consider using a dedicated security logging system
        console.log("Authentication success!", {
          timestamp: new Date().toISOString(),
          // Only log hashed IP for privacy compliance
          ipHash: req.ip ? crypto.createHash('sha256').update(req.ip).digest('hex').substring(0, 16) : 'unknown',
          path: req.path
        });
      next();
    } else {
        return res.status(401).send("Invalid Token");
    }

  } catch (e) {
    // Log error details for debugging but sanitize to avoid exposing sensitive data
    console.error("Authentication error:", {
      message: e.message,
      type: e.constructor.name,
      timestamp: new Date().toISOString()
    });
    res.status(500).send("Authentication error");
  }
};

// Optional authentication for dashboard (allows both authenticated and public access)
module.exports.optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
   
    if (token) {
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (!err) {
          req.user = decoded;
        }
        // Continue regardless of token validity for optional auth
        next();
      });
    } else {
      next();
    }

  } catch (error) {
    console.error('Optional authentication error:', error);
    next(); // Continue even if optional auth fails
  }
};

// Input validation middleware
module.exports.validateInput = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid input data",
        details: error.details.map(detail => detail.message)
      });
    }
    next();
  };
};

// Rate limiting middleware for API protection
module.exports.rateLimiter = (windowMs = 15 * 60 * 1000, max = 1000) => {
  const requests = new Map();
  
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - windowMs;
    
    if (!requests.has(ip)) {
      requests.set(ip, []);
    }
    
    const requestTimes = requests.get(ip);
    const recentRequests = requestTimes.filter(time => time > windowStart);
    
    if (recentRequests.length >= max) {
      return res.status(429).json({
        success: false,
        message: "Too many requests, please try again later",
        error: "RATE_LIMIT_EXCEEDED"
      });
    }
    
    recentRequests.push(now);
    requests.set(ip, recentRequests);
    
    next();
  };
};




