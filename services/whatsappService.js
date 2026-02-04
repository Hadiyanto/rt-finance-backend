const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

class WhatsAppService {
    constructor() {
        this.sock = null;
        this.qr = null;
        this.isConnected = false;
        this.authPath = path.join(__dirname, '../whatsapp-session');
        this.logger = pino({ level: 'silent' }); // Silent mode to reduce logs
    }

    async initialize() {
        try {
            // Ensure auth directory exists
            if (!fs.existsSync(this.authPath)) {
                fs.mkdirSync(this.authPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                logger: this.logger,
                auth: state,
                browser: ['GMM 001', 'Chrome', '1.0.0'],
            });

            // Connection updates
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qr = qr;
                    console.log('QR Code generated');
                }

                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    console.log('Connection closed, reconnecting:', shouldReconnect);

                    this.isConnected = false;
                    this.qr = null;

                    if (shouldReconnect) {
                        setTimeout(() => this.initialize(), 3000);
                    }
                } else if (connection === 'open') {
                    console.log('WhatsApp Connected!');
                    this.isConnected = true;
                    this.qr = null;
                }
            });

            // Save credentials
            this.sock.ev.on('creds.update', saveCreds);

        } catch (error) {
            console.error('WhatsApp initialization error:', error);
            throw error;
        }
    }

    async getQRCode() {
        if (this.isConnected) {
            return { connected: true, qr: null };
        }

        if (!this.qr) {
            return { connected: false, qr: null, message: 'QR not yet generated, please wait...' };
        }

        try {
            const qrDataURL = await QRCode.toDataURL(this.qr);
            return { connected: false, qr: qrDataURL };
        } catch (error) {
            console.error('QR generation error:', error);
            return { connected: false, qr: null, error: error.message };
        }
    }

    async regenerateQR() {
        try {
            // Logout current session
            if (this.sock) {
                await this.sock.logout();
            }

            // Delete session files
            if (fs.existsSync(this.authPath)) {
                fs.rmSync(this.authPath, { recursive: true, force: true });
            }

            // Reinitialize
            this.isConnected = false;
            this.qr = null;
            await this.initialize();

            return { success: true, message: 'QR regenerated, please scan' };
        } catch (error) {
            console.error('Regenerate QR error:', error);
            return { success: false, error: error.message };
        }
    }

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            hasQR: !!this.qr,
        };
    }

    async sendMessage(phone, message) {
        if (!this.isConnected) {
            throw new Error('WhatsApp not connected');
        }

        try {
            // Format phone number (remove +, spaces, etc)
            const formattedPhone = phone.replace(/[^0-9]/g, '');
            const jid = formattedPhone.includes('@s.whatsapp.net')
                ? formattedPhone
                : `${formattedPhone}@s.whatsapp.net`;

            await this.sock.sendMessage(jid, { text: message });
            return { success: true, message: 'Message sent' };
        } catch (error) {
            console.error('Send message error:', error);
            throw error;
        }
    }

    async sendBroadcast(phones, message) {
        if (!this.isConnected) {
            throw new Error('WhatsApp not connected');
        }

        const results = [];
        for (const phone of phones) {
            try {
                await this.sendMessage(phone, message);
                results.push({ phone, success: true });
            } catch (error) {
                results.push({ phone, success: false, error: error.message });
            }
        }

        return results;
    }

    async getContacts() {
        if (!this.isConnected) {
            return [];
        }

        try {
            // Note: Baileys doesn't provide easy access to contacts
            // This is a placeholder - you might need to maintain your own contact list
            return [];
        } catch (error) {
            console.error('Get contacts error:', error);
            return [];
        }
    }
}

// Singleton instance
let waService = null;

const getWhatsAppService = () => {
    if (!waService) {
        waService = new WhatsAppService();
    }
    return waService;
};

module.exports = { getWhatsAppService };
