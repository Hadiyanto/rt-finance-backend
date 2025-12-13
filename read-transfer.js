// read-gemini.js
require("dotenv").config();
const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Inisialisasi client Gemini
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

async function readTransferImage() {
  try {
    const imagePath = "/Users/hadiyanto/Downloads/WhatsApp111.jpeg"; // ganti sesuai file kamu

    // Baca file image
    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString("base64");

    console.log("⏳ Mengirim gambar ke Gemini Vision...");

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Kirim prompt + image
    const result = await model.generateContent([
      {
        text: "Extract ONLY the transfer amount as digits only (example: 210000 or 2520000). Do not return any additional text.",
      },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image
        }
      }
    ]);

    const raw = result.response.text();
    console.log("\n📄 AI Raw Response:", raw);

    // Ambil angka saja
    const amount = parseInt(raw.replace(/\D/g, ""), 10);

    if (!amount) {
      console.log("\n❌ Tidak berhasil mendeteksi nominal.");
      return;
    }

    console.log("\n✅ Nominal terdeteksi:", amount);

  } catch (error) {
    console.error("🔥 ERROR:", error);
  }
}

readTransferImage();
