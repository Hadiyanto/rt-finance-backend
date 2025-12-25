const redis = require("../lib/redisClient");

/**
 * Generic caching middleware
 * @param {Function} keyGenerator (req) => string
 * @param {number} ttlSeconds Duration in seconds
 */
const cache = (keyGenerator, ttlSeconds) => {
    return async (req, res, next) => {
        // Skip cache if explicitly requested via header (optional, good for debugging)
        if (req.headers["x-no-cache"]) {
            return next();
        }

        try {
            const key = keyGenerator(req);
            if (!key) return next();

            const cached = await redis.get(key);

            if (cached) {
                console.log(`🔥 Cache HIT: ${key}`);
                return res.json(typeof cached === "string" ? JSON.parse(cached) : cached);
            }

            console.log(`❄️ Cache MISS: ${key}`);

            // Intercept res.json to save cache
            const originalJson = res.json;
            res.json = function (data) {
                // Save to Redis (async, don't await)
                redis.set(key, JSON.stringify(data), { ex: ttlSeconds }).catch(err => {
                    console.error("Redis set error:", err);
                });

                // Restore original
                return originalJson.call(this, data);
            };

            next();
        } catch (err) {
            console.error("Cache middleware error:", err);
            next();
        }
    };
};

module.exports = cache;
