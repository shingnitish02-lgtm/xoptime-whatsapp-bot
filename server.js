/**
 * Xoptime WhatsApp OTP Bot — internal microservice (Baileys version)
 * -------------------------------------------------------------------
 * @whiskeysockets/baileys par based. whatsapp-web.js ki jagah Baileys
 * use karta hai — koi Puppeteer/Chrome nahi chahiye, seedha WhatsApp
 * ke WebSocket protocol se baat karta hai. Bahut halka hai, Render ke
 * free/small instances pe bhi aaram se chalega.
 *
 * API surface bilkul same rakha gaya hai jaisa purane server.js mein
 * tha, taaki admin_app.py mein KOI CHANGE na karna pade:
 *   GET  /qr        -> current QR (data-url) ya connected status
 *   GET  /status     -> simple status check
 *   POST /send-otp   -> { phone, otp } bhejta hai WhatsApp pe
 *   POST /logout      -> session clear karke naya QR generate karega
 *
 * Security: Sab endpoints ek INTERNAL_SECRET header (x-internal-key)
 * se protected hain, jaisa pehle tha.
 */

const express = require("express");
const qrcode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const { usePostgresAuthState } = require("./pg-auth-state");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "change-this-secret";
const DATABASE_URL = process.env.DATABASE_URL; // same Neon DB jo admin_app.py use karta hai

if (!DATABASE_URL) {
  console.error("DATABASE_URL missing — admin_app.py wala hi Neon connection string yahan bhi set karo.");
  process.exit(1);
}

let sock = null;           // current Baileys socket instance
let latestQR = null;       // current QR (data URL) — jab tak connect na ho
let clientReady = false;   // whatsapp connected hai ya nahi
let clientNumber = null;   // connected number
let authStore = null;      // pg-backed auth store (clearAll ke liye logout pe chahiye)

const logger = pino({ level: "silent" }); // Baileys ka apna verbose logging chup rakho

// ── Baileys connection setup ──
// Session ab Postgres (Neon) mein store hota hai, disk pe nahi — isliye
// Render free plan pe bhi restart/redeploy hone par session persist
// rahega aur baar baar QR scan nahi karna padega.
async function startBot() {
  authStore = await usePostgresAuthState(DATABASE_URL);
  const { state, saveCreds } = authStore;
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["Xoptime", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = await qrcode.toDataURL(qr); // base64 PNG data-url bana lo
      clientReady = false;
      console.log("New QR generated — admin panel se scan karo.");
    }

    if (connection === "open") {
      clientReady = true;
      latestQR = null;
      clientNumber = sock.user?.id?.split(":")[0] || sock.user?.id || null;
      console.log("WhatsApp client ready:", clientNumber);
    }

    if (connection === "close") {
      clientReady = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log("WhatsApp disconnected:", statusCode, loggedOut ? "(logged out)" : "(reconnecting)");

      if (loggedOut) {
        // session invalid — naye QR ke liye clean state chahiye
        clientNumber = null;
      } else {
        // network drop / restart wagera — reconnect attempt
        startBot().catch((err) => console.error("Reconnect failed:", err.message));
      }
    }
  });
}

startBot().catch((err) => console.error("Bot start failed:", err.message));

// ── auth middleware ──
function requireInternalAuth(req, res, next) {
  const key = req.headers["x-internal-key"];
  if (!key || key !== INTERNAL_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// GET /qr  -> current QR as data-url (ya "connected" status)
app.get("/qr", requireInternalAuth, (req, res) => {
  if (clientReady) {
    return res.json({ ok: true, connected: true, number: clientNumber });
  }
  if (!latestQR) {
    return res.json({ ok: true, connected: false, qr: null, message: "QR generate ho raha hai, thoda wait karo..." });
  }
  res.json({ ok: true, connected: false, qr: latestQR });
});

// GET /status -> simple status check
app.get("/status", requireInternalAuth, (req, res) => {
  res.json({ ok: true, connected: clientReady, number: clientNumber });
});

// POST /send-otp  { phone: "91XXXXXXXXXX", otp: "123456" }
app.post("/send-otp", requireInternalAuth, async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) {
    return res.status(400).json({ ok: false, error: "phone and otp required" });
  }
  if (!clientReady || !sock) {
    return res.status(503).json({ ok: false, error: "whatsapp not connected — scan QR from admin panel" });
  }
  try {
    // phone ko "91XXXXXXXXXX@s.whatsapp.net" format me convert karo
    const digits = String(phone).replace(/\D/g, "");
    const jid = digits.length === 10 ? `91${digits}@s.whatsapp.net` : `${digits}@s.whatsapp.net`;
    const message = `Xoptime OTP: *${otp}*\n\nYeh OTP kisi ke saath share mat karo. 5 min me expire ho jayega.`;
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error("send-otp error:", err.message);
    res.status(500).json({ ok: false, error: "failed to send message" });
  }
});

// POST /logout -> WhatsApp session clear karke naya QR generate karo (number badalne ke liye)
app.post("/logout", requireInternalAuth, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    if (authStore) {
      await authStore.clearAll(); // DB se bhi purana session clear karo
    }
    clientReady = false;
    clientNumber = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`WhatsApp bot service (Baileys) running on port ${PORT}`));
