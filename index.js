const express = require("express");
// const sheetRoutes = require("./routes/sheet");
// const financeRoutes = require("./routes/finance");
const apiRoutes = require("./routes/api");
const prisma = require("./lib/prisma");
const app = express();
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');


const port = process.env.PORT || 3000;
const cors = require("cors");
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: ["http://localhost:3001", "http://192.168.18.52:3001", "https://rt-finance-frontend.vercel.app"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true,
}));

app.use("/api", apiRoutes);

app.get("/health", async (req, res) => {
  try {
    const category = await prisma.category.findUnique({
      where: {
        id: 1,
      },
    });

    if (!category || category.name !== "Operasional") {
      return res.status(500).json({ status: "error", message: "Health check failed: Category 1 matches 'Operasional' check failed" });
    }

    res.json({ status: "ok", db: "connected", data: category });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);

  // Initialize WhatsApp service
  const { getWhatsAppService } = require('./services/whatsappService');
  const waService = getWhatsAppService();
  waService.initialize().catch(err => {
    console.error('WhatsApp initialization failed:', err);
  });
});
