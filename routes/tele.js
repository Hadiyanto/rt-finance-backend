const express = require('express')
const { Telegraf, Markup } = require('telegraf')
const { PrismaClient } = require("@prisma/client");
const redis = require("../lib/redisClient");
const cloudinary = require("../config/cloudinary");
const axios = require("axios");
const fs = require("fs");
const router = express.Router();

const prisma = new PrismaClient();
require('dotenv').config()

// ============================================================
// DEFENSIVE: Cek BOT_TOKEN sebelum inisialisasi
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

// ============================================================
// SESSION STORE (In-Memory) untuk multi-step flow
// ============================================================
const sessions = new Map();

const getSession = (chatId) => {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {});
  }
  return sessions.get(chatId);
};

const clearSession = (chatId) => {
  sessions.delete(chatId);
};

// ============================================================
// KATEGORI PENGELUARAN (dari Redis)
// ============================================================
const getExpenseCategories = async () => {
  try {
    const cached = await redis.get('expense_categories');
    if (cached) {
      // Upstash returns parsed JSON directly
      return Array.isArray(cached) ? cached : JSON.parse(cached);
    }
    // Fallback jika Redis kosong
    return [
      { id: 1, name: 'Operasional' },
      { id: 2, name: 'Kebersihan' },
      { id: 3, name: 'Perbaikan' },
      { id: 4, name: 'Konsumsi' },
      { id: 5, name: 'Administrasi' },
      { id: 6, name: 'Sosial' },
      { id: 7, name: 'Lain-lain' }
    ];
  } catch (err) {
    console.error('Redis get categories error:', err);
    return [
      { id: 1, name: 'Operasional' },
      { id: 2, name: 'Kebersihan' },
      { id: 3, name: 'Perbaikan' },
      { id: 4, name: 'Konsumsi' },
      { id: 5, name: 'Administrasi' },
      { id: 6, name: 'Sosial' },
      { id: 7, name: 'Lain-lain' }
    ];
  }
};

const getIncomeCategories = async () => {
  try {
    const cached = await redis.get('income_categories');
    if (cached) {
      return Array.isArray(cached) ? cached : JSON.parse(cached);
    }
    return [
      { id: 1, name: 'Iuran Bulanan' },
      { id: 2, name: 'Donasi' },
      { id: 3, name: 'Sumbangan' },
      { id: 4, name: 'Lain-lain' }
    ];
  } catch (err) {
    console.error('Redis get income categories error:', err);
    return [
      { id: 1, name: 'Iuran Bulanan' },
      { id: 2, name: 'Donasi' },
      { id: 3, name: 'Sumbangan' },
      { id: 4, name: 'Lain-lain' }
    ];
  }
};

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  // Middleware untuk logging
  bot.use(async (ctx, next) => {
    await next();
  });

  bot.start((ctx) => ctx.reply('Halo! Bot RT sudah aktif 😊\nGunakan /myid untuk mengetahui ID chat ini.\nGunakan /out untuk mencatat pengeluaran.'))

  bot.help((ctx) => ctx.reply('Commands:\n/start - Mulai bot\n/myid - Lihat Chat ID\n/out - Catat pengeluaran'))

  bot.command('myid', (ctx) => {
    ctx.reply(`Chat ID Anda: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' })
  });

  // ============================================================
  // /out COMMAND - EXPENSE RECORDING FLOW
  // ============================================================
  bot.command('out', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.step = 'date';
    session.data = {};

    await ctx.reply(
      '📅 *Pilih Tanggal Pengeluaran:*',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📆 Hari Ini', 'out_date_today')],
          [Markup.button.callback('📅 Pilih Tanggal Lain', 'out_date_custom')]
        ])
      }
    );
  });

  // STEP 1: Date Selection
  bot.action('out_date_today', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.data.date = new Date();
    session.step = 'category';

    const categories = await getExpenseCategories();
    session.categories = categories; // simpan untuk referensi

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📅 Tanggal: *${session.data.date.toLocaleDateString('id-ID')}*\n\n📁 *Pilih Kategori Pengeluaran:*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(
          categories.map(cat => [Markup.button.callback(cat.name, `out_cat_${cat.id}`)])
        )
      }
    );
  });

  bot.action('out_date_custom', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.step = 'date_input';

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '📅 *Masukkan tanggal dengan format:*\n`DD-MM-YYYY` atau `DD/MM/YYYY`\n\nContoh: `25-12-2024`',
      { parse_mode: 'Markdown' }
    );
  });

  // STEP 2: Category Selection (dynamic from Redis)
  bot.action(/^out_cat_(\d+)$/, async (ctx) => {
    const session = getSession(ctx.chat.id);
    const catId = parseInt(ctx.match[1]);

    // Cari nama kategori dari session atau fetch ulang
    let catName = 'Unknown';
    if (session.categories) {
      const found = session.categories.find(c => c.id === catId);
      if (found) catName = found.name;
    }

    session.data.category = catName;
    session.data.categoryId = catId;
    session.step = 'amount';

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📅 Tanggal: *${session.data.date.toLocaleDateString('id-ID')}*\n📁 Kategori: *${catName}*\n\n💰 *Masukkan nominal pengeluaran (angka saja):*`,
      { parse_mode: 'Markdown' }
    );
  });

  // STEP 5: Confirmation Actions
  bot.action('out_confirm_save', async (ctx) => {
    const session = getSession(ctx.chat.id);

    try {
      // typeId = 2 untuk pengeluaran (OUT)
      await prisma.financeEntry.create({
        data: {
          amount: session.data.amount,
          description: session.data.description || null,
          imageUrl: session.data.imageUrl || null,
          date: session.data.date,
          categoryId: session.data.categoryId,
          typeId: 2 // OUT / Pengeluaran
        }
      });

      await ctx.answerCbQuery("✅ Data tersimpan!");
      await ctx.editMessageText(
        `✅ *PENGELUARAN TERSIMPAN*\n\n📅 Tanggal: ${session.data.date.toLocaleDateString('id-ID')}\n📁 Kategori: ${session.data.category}\n💰 Nominal: Rp ${session.data.amount.toLocaleString('id-ID')}\n📝 Keterangan: ${session.data.description || '-'}`,
        { parse_mode: 'Markdown' }
      );

      clearSession(ctx.chat.id);
    } catch (err) {
      console.error("Save expense error:", err);
      await ctx.answerCbQuery("❌ Gagal menyimpan!");
      ctx.reply("❌ Terjadi error saat menyimpan data.");
    }
  });

  bot.action('out_confirm_cancel', async (ctx) => {
    clearSession(ctx.chat.id);
    await ctx.answerCbQuery("Dibatalkan");
    await ctx.editMessageText("❌ *Pengeluaran dibatalkan.*", { parse_mode: 'Markdown' });
  });

  // ============================================================
  // /in COMMAND - INCOME RECORDING FLOW
  // ============================================================
  bot.command('in', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.step = 'in_date';
    session.data = {};
    session.flow = 'income';

    await ctx.reply(
      '📅 *Pilih Tanggal Pemasukan:*',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📆 Hari Ini', 'in_date_today')],
          [Markup.button.callback('📅 Pilih Tanggal Lain', 'in_date_custom')]
        ])
      }
    );
  });

  // INCOME: Date Selection
  bot.action('in_date_today', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.data.date = new Date();
    session.step = 'in_category';

    const categories = await getIncomeCategories();
    session.categories = categories;

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📅 Tanggal: *${session.data.date.toLocaleDateString('id-ID')}*\n\n📁 *Pilih Kategori Pemasukan:*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(
          categories.map(cat => [Markup.button.callback(cat.name, `in_cat_${cat.id}`)])
        )
      }
    );
  });

  bot.action('in_date_custom', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.step = 'in_date_input';

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '📅 *Masukkan tanggal dengan format:*\n`DD-MM-YYYY` atau `DD/MM/YYYY`\n\nContoh: `25-12-2024`',
      { parse_mode: 'Markdown' }
    );
  });

  // INCOME: Category Selection
  bot.action(/^in_cat_(\d+)$/, async (ctx) => {
    const session = getSession(ctx.chat.id);
    const catId = parseInt(ctx.match[1]);

    let catName = 'Unknown';
    if (session.categories) {
      const found = session.categories.find(c => c.id === catId);
      if (found) catName = found.name;
    }

    session.data.category = catName;
    session.data.categoryId = catId;
    session.step = 'in_amount';

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📅 Tanggal: *${session.data.date.toLocaleDateString('id-ID')}*\n📁 Kategori: *${catName}*\n\n💰 *Masukkan nominal pemasukan (angka saja):*`,
      { parse_mode: 'Markdown' }
    );
  });

  // INCOME: Confirmation Actions
  bot.action('in_confirm_save', async (ctx) => {
    const session = getSession(ctx.chat.id);

    try {
      // typeId = 1 untuk pemasukan (IN)
      await prisma.financeEntry.create({
        data: {
          amount: session.data.amount,
          description: session.data.description || null,
          imageUrl: session.data.imageUrl || null,
          date: session.data.date,
          categoryId: session.data.categoryId,
          typeId: 1 // IN / Pemasukan
        }
      });

      await ctx.answerCbQuery("✅ Data tersimpan!");
      await ctx.editMessageText(
        `✅ *PEMASUKAN TERSIMPAN*\n\n📅 Tanggal: ${session.data.date.toLocaleDateString('id-ID')}\n📁 Kategori: ${session.data.category}\n💰 Nominal: Rp ${session.data.amount.toLocaleString('id-ID')}\n📝 Keterangan: ${session.data.description || '-'}`,
        { parse_mode: 'Markdown' }
      );

      clearSession(ctx.chat.id);
    } catch (err) {
      console.error("Save income error:", err);
      await ctx.answerCbQuery("❌ Gagal menyimpan!");
      ctx.reply("❌ Terjadi error saat menyimpan data.");
    }
  });

  bot.action('in_confirm_cancel', async (ctx) => {
    clearSession(ctx.chat.id);
    await ctx.answerCbQuery("Dibatalkan");
    await ctx.editMessageText("❌ *Pemasukan dibatalkan.*", { parse_mode: 'Markdown' });
  });

  // ============================================================
  // TEXT HANDLER - Multi-purpose
  // ============================================================
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const session = getSession(ctx.chat.id);

    console.log(`[Tele] Pesan dari ${ctx.from.first_name}: ${text} | Step: ${session.step}`);

    // --- /out FLOW: Custom Date Input ---
    if (session.step === 'date_input') {
      const dateMatch = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
      if (!dateMatch) {
        return ctx.reply("❌ Format salah. Gunakan `DD-MM-YYYY` atau `DD/MM/YYYY`", { parse_mode: 'Markdown' });
      }

      const [, day, month, year] = dateMatch;
      const parsedDate = new Date(year, month - 1, day);

      if (isNaN(parsedDate.getTime())) {
        return ctx.reply("❌ Tanggal tidak valid.");
      }

      session.data.date = parsedDate;
      session.step = 'category';

      const categories = await getExpenseCategories();
      session.categories = categories;

      return ctx.reply(
        `📅 Tanggal: *${parsedDate.toLocaleDateString('id-ID')}*\n\n📁 *Pilih Kategori Pengeluaran:*`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(
            categories.map(cat => [Markup.button.callback(cat.name, `out_cat_${cat.id}`)])
          )
        }
      );
    }

    // --- /out FLOW: Amount Input ---
    if (session.step === 'amount') {
      const amountStr = text.replace(/\D/g, '');
      const amount = parseInt(amountStr);

      if (!amount || amount < 1000) {
        return ctx.reply("❌ Nominal tidak valid. Masukkan angka minimal 1000.");
      }

      session.data.amount = amount;
      session.step = 'description';

      return ctx.reply(
        `📅 Tanggal: *${session.data.date.toLocaleDateString('id-ID')}*\n📁 Kategori: *${session.data.category}*\n💰 Nominal: *Rp ${amount.toLocaleString('id-ID')}*\n\n📝 *Masukkan keterangan (atau ketik "-" untuk skip):*`,
        { parse_mode: 'Markdown' }
      );
    }

    // --- /out FLOW: Description Input ---
    if (session.step === 'description') {
      session.data.description = text === '-' ? '' : text;
      session.step = 'out_photo';

      const summary = `
📋 *RINGKASAN PENGELUARAN*

📅 Tanggal: ${session.data.date.toLocaleDateString('id-ID')}
📁 Kategori: ${session.data.category}
💰 Nominal: Rp ${session.data.amount.toLocaleString('id-ID')}
📝 Keterangan: ${session.data.description || '-'}

📷 *Kirim foto bukti (atau ketik "skip" untuk lewati):*
`;

      return ctx.reply(summary, { parse_mode: 'Markdown' });
    }

    // --- /out FLOW: Skip Photo ---
    if (session.step === 'out_photo' && text.toLowerCase() === 'skip') {
      session.data.imageUrl = null;
      session.step = 'out_confirm';

      const summary = `
📋 *RINGKASAN PENGELUARAN*

📅 Tanggal: ${session.data.date.toLocaleDateString('id-ID')}
📁 Kategori: ${session.data.category}
💰 Nominal: Rp ${session.data.amount.toLocaleString('id-ID')}
📝 Keterangan: ${session.data.description || '-'}
📷 Foto: Tidak ada

Apakah data sudah benar?
`;

      return ctx.reply(summary, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ SIMPAN', 'out_confirm_save')],
          [Markup.button.callback('❌ BATAL', 'out_confirm_cancel')]
        ])
      });
    }

    // --- /in FLOW: Custom Date Input ---
    if (session.step === 'in_date_input') {
      const dateMatch = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
      if (!dateMatch) {
        return ctx.reply("❌ Format salah. Gunakan `DD-MM-YYYY` atau `DD/MM/YYYY`", { parse_mode: 'Markdown' });
      }

      const [, day, month, year] = dateMatch;
      const parsedDate = new Date(year, month - 1, day);

      if (isNaN(parsedDate.getTime())) {
        return ctx.reply("❌ Tanggal tidak valid.");
      }

      session.data.date = parsedDate;
      session.step = 'in_category';

      const categories = await getIncomeCategories();
      session.categories = categories;

      return ctx.reply(
        `📅 Tanggal: *${parsedDate.toLocaleDateString('id-ID')}*\n\n📁 *Pilih Kategori Pemasukan:*`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(
            categories.map(cat => [Markup.button.callback(cat.name, `in_cat_${cat.id}`)])
          )
        }
      );
    }

    // --- /in FLOW: Amount Input ---
    if (session.step === 'in_amount') {
      const amountStr = text.replace(/\D/g, '');
      const amount = parseInt(amountStr);

      if (!amount || amount < 1000) {
        return ctx.reply("❌ Nominal tidak valid. Masukkan angka minimal 1000.");
      }

      session.data.amount = amount;
      session.step = 'in_description';

      return ctx.reply(
        `📅 Tanggal: *${session.data.date.toLocaleDateString('id-ID')}*\n📁 Kategori: *${session.data.category}*\n💰 Nominal: *Rp ${amount.toLocaleString('id-ID')}*\n\n📝 *Masukkan keterangan (atau ketik "-" untuk skip):*`,
        { parse_mode: 'Markdown' }
      );
    }

    // --- /in FLOW: Description Input ---
    if (session.step === 'in_description') {
      session.data.description = text === '-' ? '' : text;
      session.step = 'in_photo';

      const summary = `
📋 *RINGKASAN PEMASUKAN*

📅 Tanggal: ${session.data.date.toLocaleDateString('id-ID')}
📁 Kategori: ${session.data.category}
💰 Nominal: Rp ${session.data.amount.toLocaleString('id-ID')}
📝 Keterangan: ${session.data.description || '-'}

📷 *Kirim foto bukti (atau ketik "skip" untuk lewati):*
`;

      return ctx.reply(summary, { parse_mode: 'Markdown' });
    }

    // --- /in FLOW: Skip Photo ---
    if (session.step === 'in_photo' && text.toLowerCase() === 'skip') {
      session.data.imageUrl = null;
      session.step = 'in_confirm';

      const summary = `
📋 *RINGKASAN PEMASUKAN*

📅 Tanggal: ${session.data.date.toLocaleDateString('id-ID')}
📁 Kategori: ${session.data.category}
💰 Nominal: Rp ${session.data.amount.toLocaleString('id-ID')}
📝 Keterangan: ${session.data.description || '-'}
📷 Foto: Tidak ada

Apakah data sudah benar?
`;

      return ctx.reply(summary, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ SIMPAN', 'in_confirm_save')],
          [Markup.button.callback('❌ BATAL', 'in_confirm_cancel')]
        ])
      });
    }

    // --- REPLY to Manual Input Request (existing) ---
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
  // PHOTO HANDLER - Upload to Cloudinary
  // ============================================================
  bot.on('photo', async (ctx) => {
    const session = getSession(ctx.chat.id);

    // Check if we're expecting a photo
    if (session.step !== 'out_photo' && session.step !== 'in_photo') {
      return; // Ignore if not in photo step
    }

    try {
      // Get the largest photo (last in array)
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const fileId = photo.file_id;

      // Get file link from Telegram
      const fileLink = await ctx.telegram.getFileLink(fileId);

      // Download photo
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      const tmpPath = `tmp_photo_${ctx.chat.id}_${Date.now()}.jpg`;
      fs.writeFileSync(tmpPath, response.data);

      // Upload to Cloudinary
      const uploaded = await cloudinary.uploader.upload(tmpPath, {
        folder: "inout",
        resource_type: "image",
      });

      // Cleanup temp file
      fs.unlinkSync(tmpPath);

      // Save URL to session
      session.data.imageUrl = uploaded.secure_url;

      // Determine flow type and show summary
      const isOut = session.step === 'out_photo';
      session.step = isOut ? 'out_confirm' : 'in_confirm';

      const summary = `
📋 *RINGKASAN ${isOut ? 'PENGELUARAN' : 'PEMASUKAN'}*

📅 Tanggal: ${session.data.date.toLocaleDateString('id-ID')}
📁 Kategori: ${session.data.category}
💰 Nominal: Rp ${session.data.amount.toLocaleString('id-ID')}
📝 Keterangan: ${session.data.description || '-'}
📷 Foto: ✅ Terupload

Apakah data sudah benar?
`;

      await ctx.reply(summary, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ SIMPAN', isOut ? 'out_confirm_save' : 'in_confirm_save')],
          [Markup.button.callback('❌ BATAL', isOut ? 'out_confirm_cancel' : 'in_confirm_cancel')]
        ])
      });

    } catch (err) {
      console.error("Photo upload error:", err);
      ctx.reply("❌ Gagal mengupload foto. Coba lagi atau ketik 'skip' untuk lewati.");
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
