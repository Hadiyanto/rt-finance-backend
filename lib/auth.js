const jwt = require("jsonwebtoken");
const { AppError } = require("./errors");

const ADMIN_ROLES = ["admin", "bendahara"];

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) {
    throw new Error("JWT_SECRET belum diset");
  }
  return s;
}

function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, name: user.name }, secret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

// requireAuth() = login apa saja; requireAuth(["admin"]) = role tertentu.
function requireAuth(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return next(new AppError(401, "UNAUTHORIZED", "Silakan login terlebih dahulu"));
    }

    let payload;
    try {
      payload = jwt.verify(token, secret());
    } catch {
      return next(new AppError(401, "INVALID_TOKEN", "Sesi login tidak valid atau sudah habis"));
    }

    if (roles.length > 0 && !roles.includes(payload.role)) {
      return next(new AppError(403, "FORBIDDEN", "Anda tidak punya akses ke fitur ini"));
    }

    req.user = { id: Number(payload.sub), role: payload.role, name: payload.name };
    next();
  };
}

module.exports = { ADMIN_ROLES, signToken, requireAuth };
