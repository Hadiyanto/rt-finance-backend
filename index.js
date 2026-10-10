require("dotenv").config({ quiet: true });

const app = require("./app");

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);

  // Baileys hanya boleh jalan di 1 instance; matikan di dev dengan WHATSAPP_ENABLED=0.
  if (process.env.WHATSAPP_ENABLED !== "0") {
    const { getWhatsAppService } = require("./services/whatsappService");
    getWhatsAppService()
      .initialize()
      .catch((err) => console.error("WhatsApp initialization failed:", err));
  }
});
