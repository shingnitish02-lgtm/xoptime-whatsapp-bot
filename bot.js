const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const app = express();
app.use(express.json());

let sock = null;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 WHATSAPP QR CODE - Apne phone se scan karo:\n');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot Connected!');
        }
    });
}

// Flask se OTP request aayegi yahan
app.post('/send-otp', async (req, res) => {
    const { phone, otp } = req.body;
    
    if (!sock) {
        return res.status(500).json({ success: false, message: 'Bot not connected' });
    }
    
    try {
        // Indian number format
        const jid = '91' + phone + '@s.whatsapp.net';
        
        await sock.sendMessage(jid, {
            text: `🔐 *Xoptime OTP*\n\nYour verification code is:\n\n*${otp}*\n\nYe code 10 minutes tak valid hai.\nKisi ke saath share mat karo.`
        });
        
        res.json({ success: true, message: 'OTP sent' });
    } catch (err) {
        console.error('Send error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: sock !== null });
});

app.listen(3000, () => {
    console.log('🤖 Bot server running on port 3000');
});

startBot();