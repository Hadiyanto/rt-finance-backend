const { ZodError } = require("zod");

// Error yang boleh ditampilkan ke client apa adanya.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Data tidak valid",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details && { details: err.details }) });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ code: "INVALID_JSON", message: "Body bukan JSON yang valid" });
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ code: "FILE_TOO_LARGE", message: "Ukuran file maksimal 5MB" });
  }
  console.error(err);
  return res.status(500).json({ code: "INTERNAL_ERROR", message: "Terjadi kesalahan di server" });
}

module.exports = { AppError, errorHandler };
