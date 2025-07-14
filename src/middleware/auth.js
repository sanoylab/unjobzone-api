const jwt = require("jsonwebtoken");
require("dotenv").config();

// Main authentication middleware - UNCHANGED to maintain backward compatibility
module.exports.auth = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
   
    if (!token) {
      return res.status(401).send("A token is required for authentication");
    }
    
    if(token == process.env.ACCESS_TOKEN_SECRET || token == process.env.TEMPO_ACCESS_TOKEN_SECRET){
        console.log("Authentication success!")
      next();
    } else {
        return res.status(401).send("Invalid Token");
    }

  } catch (e) {
    res.send(e).status(500);
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
module.exports.rateLimiter = (windowMs = 15 * 60 * 1000, max = 100) => {
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




