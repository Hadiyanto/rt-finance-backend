const express = require('express')
const router = express.Router()
const csv = require('csv-parser')
const fs = require('fs')
const multer = require('multer')
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const upload = multer({ dest: '/tmp' })

function parseAmount(value) {
  if (!value) return 0
  return Math.round(
    Number(value.toString().replace(/,/g, ''))
  )
}

router.post(
  '/cash-ledger/import-csv',
  upload.single('file'),
  async (req, res) => {
    const filePath = req.file.path
    const rows = []

    try {
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => rows.push(row))
          .on('end', resolve)
          .on('error', reject)
      })

      const result = await prisma.$transaction(async (tx) => {
        // 🔥 AMBIL SALDO CASH SAJA
        const lastCash = await tx.cashLedger.findFirst({
          where: { bucket: 'CASH' },
          orderBy: { createdAt: 'desc' },
          select: { balance: true }
        })

        let currentBalance = lastCash ? lastCash.balance : 0
        const inserted = []

        for (const row of rows) {
          const description = row['Keterangan']?.trim()
          const pengeluaran = parseAmount(row['Pengeluaran'])
          const pendapatan = parseAmount(row['Pendapatan'])

          if (!description) continue

          let type, amount

          if (pendapatan > 0) {
            type = 'IN'
            amount = pendapatan
            currentBalance += amount
          } else if (pengeluaran > 0) {
            type = 'OUT'
            amount = pengeluaran
            currentBalance -= amount
          } else {
            continue
          }

          if (currentBalance < 0) {
            throw new Error(`Saldo minus pada: ${description}`)
          }

          const entry = await tx.cashLedger.create({
            data: {
              type,
              amount,
              balance: currentBalance, // 🔥 VALID
              bucket: 'CASH',           // 🔥 WAJIB
              description,
              date: new Date(),
              source: 'MANUAL',
              createdBy: req.user?.id || 'system'
            }
          })

          inserted.push(entry)
        }

        return inserted
      })

      res.json({
        message: 'CSV imported successfully',
        total: result.length
      })
    } catch (err) {
      res.status(400).json({ message: err.message })
    }
  }
)


/**
 * POST /api/cash-ledger
 * Create new cash ledger entry (IN / OUT)
 */
router.post('/cash-ledger', async (req, res) => {
  try {
    const {
      type,
      amount,
      description,
      date,
      bucket = 'CASH',
      source = 'MANUAL',
      sourceRef
    } = req.body

    // ---- VALIDATION ----
    if (!['IN', 'OUT'].includes(type)) {
      return res.status(400).json({ message: 'Invalid type' })
    }

    if (!['CASH', 'DEFERRED'].includes(bucket)) {
      return res.status(400).json({ message: 'Invalid bucket' })
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Amount must be greater than 0' })
    }

    if (!description) {
      return res.status(400).json({ message: 'Description is required' })
    }

    const txDate = date ? new Date(date) : new Date()

    const result = await prisma.$transaction(async (tx) => {
      let balance = null // 🔥 DEFAULT NULL (AMAN)

      // ===== HITUNG BALANCE HANYA UNTUK CASH =====
      if (bucket === 'CASH') {
        const lastCash = await tx.cashLedger.findFirst({
          where: { bucket: 'CASH' },
          orderBy: { createdAt: 'desc' },
          select: { balance: true, date: true }
        })

        const lastBalance = lastCash?.balance ?? 0

        if (lastCash && txDate < lastCash.date) {
          throw new Error('Backdated transaction is not allowed')
        }

        balance =
          type === 'IN'
            ? lastBalance + amount
            : lastBalance - amount

        if (balance < 0) {
          throw new Error('Saldo kas tidak mencukupi')
        }
      }

      // ===== CREATE LEDGER (EXPLICIT DATA) =====
      return tx.cashLedger.create({
        data: {
          type,
          amount,
          bucket,
          balance, // 🔥 SELALU ADA: number atau null
          description,
          date: txDate,
          source,
          sourceRef,
          createdBy: req.user?.id || 'system'
        }
      })
    })

    res.status(201).json(result)
  } catch (err) {
    res.status(400).json({ message: err.message })
  }
})


/**
 * GET /api/cash-ledger
 * List all ledger entries (latest first)
 */
router.get('/cash-ledger', async (_req, res) => {
  const data = await prisma.cashLedger.findMany({
    orderBy: { createdAt: 'desc' }
  })

  res.json(data)
})

/**
 * GET /api/cash-ledger/balance
 * Get latest balance
 */
router.get('/balance', async (_req, res) => {
  const last = await prisma.cashLedger.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { balance: true }
  })

  res.json({
    balance: last ? last.balance : 0
  })
})

module.exports = router
