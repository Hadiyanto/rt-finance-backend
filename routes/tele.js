const express = require('express')
const { Telegraf, Markup } = require('telegraf')
const { PrismaClient } = require("@prisma/client");
const router = express.Router();

const prisma = new PrismaClient();
require('dotenv').config()

// ============================================================
// DEFENSIVE: Cek BOT_TOKEN sebelum inisialisasi
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  // Middleware untuk logging (opsional)
  bot.use(async (ctx, next) => {
    await next();
  });

  bot.start((ctx) => ctx.reply('Halo! Bot RT sudah aktif 😊\nGunakan /myid untuk mengetahui ID chat ini.'))

  bot.help((ctx) => ctx.reply('Gunakan /start atau kirim pesan biasa.'))

  bot.command('myid', (ctx) => {
    ctx.reply(`Chat ID Anda: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' })
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    console.log(`[Tele] Pesan dari ${ctx.from.first_name}: ${text}`);

    // CEK APAKAH INI REPLY DARI REQUEST MANUAL INPUT
    const replyMsg = ctx.message.reply_to_message;
    if (replyMsg && replyMsg.caption && replyMsg.caption.includes("ID:")) {
      const match = replyMsg.caption.match(/ID: #(\d+)/);
      if (match) {
        const feeId = parseInt(match[1]);
        const amountStr = text.replace(/\D/g, '');
        const amount = parseInt(amountStr);

        if (!amount || amount < 100000) {
          return ctx.reply("❌ Nominal tidak valid. Masukkan angka saja (min 100000).");
        }

        try {
          await prisma.monthlyFee.update({
            where: { id: feeId },
            data: {
              amount: amount,
              status: "COMPLETED",
              notes: `Manual input by ${ctx.from.first_name}`
            }
          });

          await ctx.reply(`✅ Data Updated! ID: ${feeId}\n💰 Nominal: Rp ${amount.toLocaleString('id-ID')}\nStatus: COMPLETED`);
        } catch (err) {
          console.error("Manual update error:", err);
          ctx.reply("❌ Gagal update database.");
        }
        return;
      }
    }
  });

  // ============================================================
  // ADMIN APPROVAL ACTION HANDLERS
  // ============================================================

  bot.action(/^approve_(\d+)$/, async (ctx) => {
    const feeId = parseInt(ctx.match[1]);

    try {
      await prisma.monthlyFee.update({
        where: { id: feeId },
        data: { status: 'COMPLETED' }
      });

      await ctx.editMessageCaption(
        `${ctx.callbackQuery.message.caption}\n\n✅ *APPROVED* by ${ctx.from.first_name}`,
        { parse_mode: 'Markdown' }
      );

      await ctx.answerCbQuery("Data berhasil diapprove!");

    } catch (error) {
      console.error("Approve Error:", error);
      await ctx.answerCbQuery("Gagal mengupdate data.");
    }
  });

  bot.action(/^reject_(\d+)$/, async (ctx) => {
    const feeId = parseInt(ctx.match[1]);

    try {
      await prisma.monthlyFee.update({
        where: { id: feeId },
        data: { status: 'REJECTED' }
      });

      await ctx.editMessageCaption(
        `${ctx.callbackQuery.message.caption}\n\n❌ *REJECTED* by ${ctx.from.first_name}`,
        { parse_mode: 'Markdown' }
      );

      await ctx.answerCbQuery("Data ditolak.");

    } catch (error) {
      console.error("Reject Error:", error);
      await ctx.answerCbQuery("Gagal menolak data.");
    }
  });

  // Start Bot
  bot.launch().then(() => {
    console.log('🤖 Telegram Bot Started');
  }).catch(err => console.error("Bot launch failed:", err));

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'))
  process.once('SIGTERM', () => bot.stop('SIGTERM'))

} else {
  console.warn("⚠️ BOT_TOKEN not set, Telegram Bot is DISABLED.");
}


// ============================================================
// EXPORT HELPER UNTUK MODULE LAIN
// ============================================================
const sendApprovalRequest = async (data) => {
  if (!bot) {
    console.warn("⚠️ Bot not initialized, skipping approval request.");
    return;
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn("⚠️ TELEGRAM_CHAT_ID not set, skipping notification.");
    return;
  }

  try {
    const caption = `
🆕 *Iuran Baru Menunggu Approval*

🏠 *Rumah*: ${data.block}/${data.houseNumber}
👤 *Nama*: ${data.fullName || "Unknown"}
🗓 *Bulan*: ${data.date.toISOString().slice(0, 7)}
💰 *Nominal*: Rp ${data.amount?.toLocaleString('id-ID')}
📝 *Catatan*: ${data.notes || "-"}

Mohon konfirmasi validitas transfer ini.
`;

    await bot.telegram.sendPhoto(chatId, data.imageUrl, {
      caption: caption,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Approve', `approve_${data.id}`),
        Markup.button.callback('❌ Reject', `reject_${data.id}`)
      ])
    });
    console.log(`📨 Approval request sent for ID ${data.id}`);
  } catch (e) {
    console.error("Failed to send telegram approval:", e);
  }
};

const sendManualInputRequest = async (data) => {
  if (!bot) {
    console.warn("⚠️ Bot not initialized, skipping manual input request.");
    return;
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;

  try {
    const caption = `
⚠️ *OCR GAGAL / TIDAK DITEMUKAN*

ID: #${data.id}
🏠 *Rumah*: ${data.block}/${data.houseNumber}
🗓 *Bulan*: ${data.date.toISOString().slice(0, 7)}

Bot tidak dapat membaca nominal dari gambar.
👉 *Silakan Reply pesan ini dengan nominal yang benar (angka saja).*
`;

    await bot.telegram.sendPhoto(chatId, data.imageUrl, {
      caption: caption,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error("Failed to send manual input request:", e);
  }
};

module.exports = { router, sendApprovalRequest, sendManualInputRequest };
