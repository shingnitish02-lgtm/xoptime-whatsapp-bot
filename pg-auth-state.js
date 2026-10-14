/**
 * usePostgresAuthState — Baileys ke useMultiFileAuthState ka drop-in
 * replacement, jo session ko local disk ki jagah Postgres (Neon) mein
 * store karta hai.
 *
 * Render free plan pe filesystem ephemeral hai — har restart/deploy pe
 * .baileys_auth folder delete ho jata hai, isliye QR baar baar scan
 * karna padta tha. Ab session DB mein hai, to restart hone par bhi
 * session persist rahega — same Neon DB jo admin_app.py (DATABASE_URL)
 * use karta hai.
 *
 * Table auto-create ho jati hai: whatsapp_auth_state(key TEXT PRIMARY KEY, value JSONB)
 */

const { Pool } = require("pg");
const { proto, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");

async function usePostgresAuthState(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }, // Neon requires SSL
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const readData = async (key) => {
    const { rows } = await pool.query(
      "SELECT value FROM whatsapp_auth_state WHERE key = $1",
      [key]
    );
    if (!rows.length) return null;
    // JSONB DB se plain JS object deta hai, isliye pehle stringify karke
    // phir BufferJSON.reviver se parse karo taaki Buffer fields sahi se restore ho
    return JSON.parse(JSON.stringify(rows[0].value), BufferJSON.reviver);
  };

  const writeData = async (key, data) => {
    const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO whatsapp_auth_state (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value]
    );
  };

  const removeData = async (key) => {
    await pool.query("DELETE FROM whatsapp_auth_state WHERE key = $1", [key]);
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
    // logout/number-badalne ke waqt pura session table se clear karne ke liye
    clearAll: async () => {
      await pool.query("DELETE FROM whatsapp_auth_state");
    },
  };
}

module.exports = { usePostgresAuthState };
