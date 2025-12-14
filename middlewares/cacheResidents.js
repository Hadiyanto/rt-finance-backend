const redis = require("../lib/redisClient");

async function cacheResidents(req, res, next) {
  try {
    const cached = await redis.get("residents");

    if (cached) {
      console.log("🔥 Cache HIT: residents");
      return res.json(JSON.parse(cached));
    }

    console.log("❄️ Cache MISS: residents");
    next();
  } catch (err) {
    console.error("Redis error:", err);
    next();
  }
}

module.exports = cacheResidents;
