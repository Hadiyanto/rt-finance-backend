const express = require('express')
const router = express.Router()
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * POST /api/deferred-subscriptions
 * Create new deferred subscription
 */
router.post('/deferred-subscription', async (req, res) => {
  try {
    const {
      block,
      houseNumber,
      totalAmount,
      monthlyAmount,
      startMonth,
      endMonth,
      sourceRef
    } = req.body

    // ---- VALIDATION ----
    if (!block || !houseNumber) {
      return res.status(400).json({ message: 'Resident identity is required' })
    }

    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ message: 'totalAmount must be > 0' })
    }

    if (!monthlyAmount || monthlyAmount <= 0) {
      return res.status(400).json({ message: 'monthlyAmount must be > 0' })
    }

    if (totalAmount % monthlyAmount !== 0) {
      return res.status(400).json({
        message: 'totalAmount must be divisible by monthlyAmount'
      })
    }

    if (!startMonth || !endMonth) {
      return res.status(400).json({ message: 'startMonth and endMonth required' })
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ CREATE SUBSCRIPTION
      const subscription = await tx.deferredSubscription.create({
        data: {
          block,
          houseNumber,
          totalAmount,
          monthlyAmount,
          remaining: totalAmount,
          startMonth,
          endMonth,
          sourceRef
        }
      })

      return subscription
    })

    res.status(201).json(result)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})


/**
 * GET /api/deferred-subscriptions
 * List all subscriptions
 */
router.get('/deferred-subscription', async (_req, res) => {
  const data = await prisma.deferredSubscription.findMany({
    orderBy: { createdAt: 'desc' }
  })

  res.json(data)
})

/**
 * GET /api/deferred-subscriptions/active
 * List active subscriptions only
 */
router.get('/deferred-subscription/active', async (_req, res) => {
  const data = await prisma.deferredSubscription.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' }
  })

  res.json(data)
})

/**
 * PATCH /api/deferred-subscriptions/:id/deactivate
 * Manual deactivate (edge case only)
 */
router.patch('/deferred-subscription/:id/deactivate', async (req, res) => {
  try {
    const { id } = req.params

    const sub = await prisma.deferredSubscription.update({
      where: { id },
      data: { isActive: false }
    })

    res.json(sub)
  } catch (err) {
    res.status(404).json({ message: 'Subscription not found' })
  }
})

module.exports = router
