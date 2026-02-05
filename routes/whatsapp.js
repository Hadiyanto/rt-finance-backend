const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const { getWhatsAppService } = require("../services/whatsappService");
const prisma = require("../lib/prisma");

/**
 * GET /api/whatsapp/qr
 * Get QR code for WhatsApp connection
 * Admin only
 */
router.get("/whatsapp/qr", auth(), async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'bendahara') {
            return res.status(403).json({ message: 'Forbidden: Admin only' });
        }

        const waService = getWhatsAppService();
        const qrData = await waService.getQRCode();

        res.json(qrData);
    } catch (error) {
        console.error('Get QR error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * POST /api/whatsapp/regenerate
 * Regenerate QR code (logout and start new session)
 * Admin only
 */
router.post("/whatsapp/regenerate", auth(), async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'bendahara') {
            return res.status(403).json({ message: 'Forbidden: Admin only' });
        }

        const waService = getWhatsAppService();
        const result = await waService.regenerateQR();

        res.json(result);
    } catch (error) {
        console.error('Regenerate QR error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * GET /api/whatsapp/status
 * Get WhatsApp connection status
 * Admin only
 */
router.get("/whatsapp/status", auth(), async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'bendahara') {
            return res.status(403).json({ message: 'Forbidden: Admin only' });
        }

        const waService = getWhatsAppService();
        const status = waService.getConnectionStatus();

        res.json(status);
    } catch (error) {
        console.error('Get status error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * GET /api/whatsapp/contacts
 * Get list of residents with phone numbers for sending messages
 * Admin only
 */
router.get("/whatsapp/contacts", auth(), async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'bendahara') {
            return res.status(403).json({ message: 'Forbidden: Admin only' });
        }

        // Get all residents with phone numbers from database
        const residents = await prisma.resident.findMany({
            where: {
                AND: [
                    { phoneNumber: { not: null } },
                    { phoneNumber: { not: '' } }
                ]
            },
            select: {
                id: true,
                fullName: true,
                phoneNumber: true,
                block: true,
                houseNumber: true,
            },
            orderBy: [
                { block: 'asc' },
                { houseNumber: 'asc' },
            ],
        });

        res.json({
            contacts: residents,
            total: residents.length,
        });
    } catch (error) {
        console.error('Get contacts error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * POST /api/whatsapp/send
 * Send WhatsApp message
 * Admin only
 * 
 * Body:
 * {
 *   "recipient": "individual" | "group" | "all",
 *   "phone": "628123456789", // For individual
 *   "phones": ["628123...", "628456..."], // For group
 *   "message": "Your message here"
 * }
 */
router.post("/whatsapp/send", auth(), async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'bendahara') {
            return res.status(403).json({ message: 'Forbidden: Admin only' });
        }

        const { recipient, phone, phones, message } = req.body;

        if (!message) {
            return res.status(400).json({ message: 'Message is required' });
        }

        const waService = getWhatsAppService();

        if (!waService.isConnected) {
            return res.status(400).json({ message: 'WhatsApp not connected. Please scan QR code first.' });
        }

        let result;

        if (recipient === 'individual') {
            if (!phone) {
                return res.status(400).json({ message: 'Phone number is required for individual message' });
            }
            result = await waService.sendMessage(phone, message);
        } else if (recipient === 'group') {
            if (!phones || !Array.isArray(phones) || phones.length === 0) {
                return res.status(400).json({ message: 'Phone numbers array is required for group message' });
            }
            result = await waService.sendBroadcast(phones, message);
        } else if (recipient === 'all') {
            // Get all residents with phone numbers
            const residents = await prisma.resident.findMany({
                where: {
                    phoneNumber: {
                        not: null,
                        not: '',
                    }
                },
                select: {
                    phoneNumber: true,
                },
            });

            const allPhones = residents.map(r => r.phoneNumber);
            result = await waService.sendBroadcast(allPhones, message);
        } else {
            return res.status(400).json({ message: 'Invalid recipient type' });
        }

        res.json({
            success: true,
            result,
        });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
