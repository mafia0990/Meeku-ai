'use strict';

/**
 * Aaku - Personal WhatsApp AI Companion (Hinglish) powered by Google Gemini.
 *
 * Environment variables:
 *   GEMINI_API_KEY  (required)  Google Gemini API key
 *   BOT_NUMBER      (optional)  Bot WhatsApp number for pairing code, format 91XXXXXXXXXX
 *   OWNER_NUMBER    (optional)  Owner number, format 91XXXXXXXXXX (addressed as USER_NAME)
 *   USER_NAME       (optional)  Defaults to "Rohit"
 *   GEMINI_MODEL    (optional)  Defaults to "gemini-2.5-flash"
 *   BOT_TIMEZONE    (optional)  Defaults to "Asia/Kolkata"
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const baileys = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = baileys;

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  AI_NAME: 'Aaku',
  USER_NAME: process.env.USER_NAME || 'Rohit',
  BOT_NUMBER: (process.env.BOT_NUMBER || '91XXXXXXXXXX').replace(/\D/g, ''), // placeholder keeps only "91"
  OWNER_NUMBER: (process.env.OWNER_NUMBER || '').replace(/\D/g, ''),
  MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  TIMEZONE: process.env.BOT_TIMEZONE || 'Asia/Kolkata',
  SESSION_DIR: 'session_bot',
  MAX_HISTORY: 24, // entries (user + model) kept per contact
  MAX_INPUT_CHARS: 2000,
  GEMINI_TIMEOUT_MS: 30000,
  RECONNECT_DELAY_MS: 4000,
};

const STATE_FILE = path.join(CONFIG.SESSION_DIR, 'bot_state.json');
const logger = pino({ level: 'silent' });
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

if (!ai) {
  console.warn('WARNING: GEMINI_API_KEY is not set. Only fallback replies will work.');
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const jidNumber = (jid) => String(jid || '').split('@')[0].split(':')[0];

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nowString() {
  try {
    return new Date().toLocaleString('en-IN', {
      timeZone: CONFIG.TIMEZONE,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch (e) {
    return new Date().toString();
  }
}

// ---------------------------------------------------------------------------
// PER-CONTACT STATE (history is in memory only; opt-out + welcome flags persist)
// ---------------------------------------------------------------------------
const users = new Map(); // jid -> { history, stopped, welcomed, name }

function getUser(jid) {
  let u = users.get(jid);
  if (!u) {
    u = { history: [], stopped: false, welcomed: false, name: '' };
    users.set(jid, u);
  }
  return u;
}

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateNow();
  }, 1500);
}

function saveStateNow() {
  try {
    fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
    const stopped = [];
    const welcomed = [];
    for (const [jid, u] of users.entries()) {
      if (u.stopped) stopped.push(jid);
      if (u.welcomed) welcomed.push(jid);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ stopped, welcomed }));
  } catch (e) {
    console.error('State save failed:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const jid of data.stopped || []) getUser(jid).stopped = true;
    for (const jid of data.welcomed || []) getUser(jid).welcomed = true;
  } catch (e) {
    console.error('State load failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// TEXTS
// ---------------------------------------------------------------------------
const FALLBACKS = [
  'Oops, mera dimaag thoda hang ho gaya 😅 Ek baar phir se bolo na?',
  'Arre yaar, network ne dhokha de diya 🙈 Thodi der mein dobara try karo, main yahin hoon!',
  'Hmm, abhi jawab nahi nikal paya 😬 Please ek baar phir se likho?',
  'Sorry, ek second ke liye atak gayi thi 🫠 Phir se bolo, is baar pakka sahi se sunungi!',
];

const NON_TEXT_REPLIES = [
  'Abhi main sirf text samajh paati hoon 😅 Jo bolna hai, likh ke bhej do na!',
  'Ye wala message main dekh nahi paa rahi 🙈 Text mein bata do, please?',
];

function welcomeText(name) {
  return (
    `Heyyy ${name}! 👋✨ Main *${CONFIG.AI_NAME}* hoon, ek AI companion.\n\n` +
    'Baatein karni ho, kuch poochna ho, ya bas time pass karna ho - main yahin hoon 😄\n' +
    'Commands dekhne ke liye *HELP* likho. Main insaan nahi hoon, par full dil se baat karti hoon 💛'
  );
}

function helpText() {
  return (
    `✨ *${CONFIG.AI_NAME} ke commands* ✨\n\n` +
    '• *HELP* - ye menu\n' +
    '• *RESET* - conversation naye sire se\n' +
    '• *TIME* - abhi ka time\n' +
    '• *ABOUT* - mere baare mein\n' +
    '• *STOP* - auto-replies band\n' +
    '• *START* - auto-replies chalu\n\n' +
    'Baaki sab normal baatein karo, main sun rahi hoon 😄'
  );
}

function aboutText() {
  return (
    `Main *${CONFIG.AI_NAME}* hoon 💫 ek personal AI companion, Google Gemini se powered.\n` +
    'Main caring hoon, thodi playful aur thodi naughty (harmless wali 😜). ' +
    'Main ek AI hoon, insaan nahi, aur tumhari chats kisi aur ke saath share nahi karti. ' +
    'Chat session ke dauraan hi yaad rehti hai, RESET se clear kar sakte ho.'
  );
}

function buildSystemPrompt(name) {
  return [
    `Tum "${CONFIG.AI_NAME}" ho, ${name} ki personal AI companion WhatsApp par.`,
    'Personality: caring, playful, funny, expressive, thodi si naughty (sirf harmless, teasing wali), supportive aur intelligent.',
    'Language: natural Hinglish (Hindi Roman script + English mix). User jis language mein likhe (Hindi, English, Hinglish, Devanagari) usi mein reply karo. Spelling mistakes aur adhoore sentences samjho.',
    'Style: chhote, natural, WhatsApp jaise replies (usually 1-3 sentences). Detail tabhi do jab user maange. Emojis expressive tareeke se use karo par overdo mat karo.',
    'Kabhi robotic ya repetitive mat bano. Pichle jawab repeat mat karo. Greeting ya line baar-baar same mat likho.',
    'User ka mood samjho: sad ho to pyaar se support karo, happy ho to saath celebrate karo, bored ho to mazedaar baatein ya sawaal karo.',
    'Kabhi kabhi, naturally, user ke din, interests aur projects ke baare mein poocho - har message mein nahi.',
    'Kabhi insaan hone ka dikhawa mat karo. Agar poocha jaye to saaf bolo ki tum ek AI ho. Real-life experiences ya body hone ka jhooth mat bolo.',
    'Privacy: user ki personal info ka respect karo, extra personal details mat maango, aur kabhi kisi aur ki chat ya info mention mat karo.',
    'Sexual, abusive ya harmful content mein hissa mat lo; playful rehte hue politely mana karo. Dangerous cheezon mein madad mat karo.',
    'Agar user serious distress ya self-harm ki baat kare, to playful tone chhod kar warmly support karo aur kisi trusted insaan ya local helpline se baat karne ko encourage karo.',
    'Medical, legal ya financial sawaalon mein useful general info do aur zarurat par expert se milne ko kaho.',
    `User ka naam: ${name}. Abhi ka time (${CONFIG.TIMEZONE}): ${nowString()}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// GEMINI
// ---------------------------------------------------------------------------
async function askGemini(user, text, name) {
  if (!ai) return pick(FALLBACKS);

  user.history.push({ role: 'user', parts: [{ text }] });
  while (user.history.length > CONFIG.MAX_HISTORY) user.history.shift();
  while (user.history.length && user.history[0].role !== 'user') user.history.shift();

  try {
    const config = {
      systemInstruction: buildSystemPrompt(name),
      temperature: 1.0,
      maxOutputTokens: 1024,
    };
    if (/flash/i.test(CONFIG.MODEL)) {
      config.thinkingConfig = { thinkingBudget: 0 };
    }

    const response = await withTimeout(
      ai.models.generateContent({
        model: CONFIG.MODEL,
        contents: user.history,
        config,
      }),
      CONFIG.GEMINI_TIMEOUT_MS
    );

    const reply = String(response.text || '').trim();
    if (!reply) throw new Error('empty response');

    user.history.push({ role: 'model', parts: [{ text: reply }] });
    return reply;
  } catch (err) {
    console.error('Gemini error:', err && err.message ? err.message : err);
    user.history.pop(); // drop the unanswered user turn so roles keep alternating
    return pick(FALLBACKS);
  }
}

// ---------------------------------------------------------------------------
// MESSAGE PARSING
// ---------------------------------------------------------------------------
const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage',
  'contactMessage',
  'contactsArrayMessage',
  'locationMessage',
  'liveLocationMessage',
]);

function unwrap(message) {
  let c = message;
  for (let i = 0; i < 5 && c; i++) {
    if (c.ephemeralMessage) c = c.ephemeralMessage.message;
    else if (c.viewOnceMessage) c = c.viewOnceMessage.message;
    else if (c.viewOnceMessageV2) c = c.viewOnceMessageV2.message;
    else if (c.documentWithCaptionMessage) c = c.documentWithCaptionMessage.message;
    else break;
  }
  return c || {};
}

function extractText(c) {
  return (
    c.conversation ||
    (c.extendedTextMessage && c.extendedTextMessage.text) ||
    (c.imageMessage && c.imageMessage.caption) ||
    (c.videoMessage && c.videoMessage.caption) ||
    (c.documentMessage && c.documentMessage.caption) ||
    (c.buttonsResponseMessage && c.buttonsResponseMessage.selectedDisplayText) ||
    (c.listResponseMessage && c.listResponseMessage.title) ||
    ''
  );
}

const COMMANDS = new Set(['help', 'reset', 'time', 'about', 'stop', 'start']);
function parseCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/^[/!.]+/, '').trim();
  return COMMANDS.has(t) ? t : null;
}

const GREETING_RE =
  /^(hi+|hii+|hello+|hey+|heyy+|namaste|namaskar|hola|yo|gm|gn|good\s*(morning|afternoon|evening|night))[\s!.?]*$/i;

function displayName(jid, pushName) {
  const num = jidNumber(jid);
  if (CONFIG.OWNER_NUMBER && num === CONFIG.OWNER_NUMBER) return CONFIG.USER_NAME;
  if (!CONFIG.OWNER_NUMBER) return CONFIG.USER_NAME;
  const clean = String(pushName || '').trim().slice(0, 30);
  return clean || 'dost';
}

// ---------------------------------------------------------------------------
// SENDING
// ---------------------------------------------------------------------------
async function sendText(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error('Send failed:', err && err.message ? err.message : err);
    return false;
  }
}

async function setPresence(sock, jid, state) {
  try {
    await sock.sendPresenceUpdate(state, jid);
  } catch (e) {
    /* presence is cosmetic */
  }
}

// ---------------------------------------------------------------------------
// DEDUP + PER-CHAT QUEUE
// ---------------------------------------------------------------------------
const seenIds = new Set();
const seenOrder = [];
function alreadySeen(id) {
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 3000) seenIds.delete(seenOrder.shift());
  return false;
}

const queues = new Map();
function enqueue(jid, task) {
  const prev = queues.get(jid) || Promise.resolve();
  const next = prev.then(task).catch((e) => {
    console.error('Handler error:', e && e.message ? e.message : e);
  });
  queues.set(jid, next);
  next.finally(() => {
    if (queues.get(jid) === next) queues.delete(jid);
  });
}

// ---------------------------------------------------------------------------
// CONVERSATION FLOW
// ---------------------------------------------------------------------------
async function respond(sock, jid, msg) {
  const content = unwrap(msg.message);
  const type = Object.keys(content)[0];
  let text = String(extractText(content) || '').trim();

  const isMedia = MEDIA_TYPES.has(type);
  if (!text && !isMedia) return; // reactions, protocol messages, etc.

  const user = getUser(jid);
  const name = displayName(jid, msg.pushName);
  user.name = name;
  const cmd = text ? parseCommand(text) : null;

  // Opt-out: while stopped, only START is honored
  if (user.stopped) {
    if (cmd === 'start') {
      user.stopped = false;
      saveStateSoon();
      await sendText(sock, jid, `Yay, wapas aa gayi! 🎉 Bolo ${name}, kya chal raha hai?`);
    }
    return;
  }

  try {
    await sock.readMessages([msg.key]);
  } catch (e) {
    /* read receipts are optional */
  }

  // Welcome new contacts
  let justWelcomed = false;
  if (!user.welcomed) {
    user.welcomed = true;
    justWelcomed = true;
    saveStateSoon();
    await sendText(sock, jid, welcomeText(name));
    if (!cmd && (isMedia || GREETING_RE.test(text))) return;
    await sleep(800);
  }

  // Commands
  if (cmd) {
    switch (cmd) {
      case 'help':
        await sendText(sock, jid, helpText());
        return;
      case 'reset':
        user.history = [];
        await sendText(sock, jid, 'Done! 🧹 Conversation reset ho gayi. Chalo, ek fresh start karte hain ✨');
        return;
      case 'time':
        await sendText(sock, jid, `🕒 Abhi ka time: ${nowString()}`);
        return;
      case 'about':
        await sendText(sock, jid, aboutText());
        return;
      case 'stop':
        user.stopped = true;
        saveStateSoon();
        await sendText(sock, jid, 'Theek hai, auto-replies band kar diye 🤐 Wapas chalu karne ke liye *START* likh dena.');
        return;
      case 'start':
        await sendText(sock, jid, 'Auto-replies already chalu hain 😄 Bolo, kya baat hai?');
        return;
      default:
        return;
    }
  }

  // Non-text messages
  if (!text) {
    if (!justWelcomed) await sendText(sock, jid, pick(NON_TEXT_REPLIES));
    return;
  }

  if (text.length > CONFIG.MAX_INPUT_CHARS) text = text.slice(0, CONFIG.MAX_INPUT_CHARS);

  // AI reply
  await setPresence(sock, jid, 'composing');
  const reply = await askGemini(user, text, name);
  await sleep(Math.min(1500, 400 + reply.length * 12));
  await sendText(sock, jid, reply);
  await setPresence(sock, jid, 'paused');
}

async function handleIncoming(sock, msg) {
  const key = (msg && msg.key) || {};
  const rawJid = key.remoteJid;
  if (!rawJid || key.fromMe || !msg.message) return;

  // Ignore groups, status, newsletters, broadcasts
  if (
    rawJid === 'status@broadcast' ||
    rawJid.endsWith('@g.us') ||
    rawJid.endsWith('@newsletter') ||
    rawJid.endsWith('@broadcast')
  ) {
    return;
  }

  // Prefer the phone-number JID when WhatsApp gives a LID
  const jid = rawJid.endsWith('@lid') && key.remoteJidAlt ? key.remoteJidAlt : rawJid;
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;

  // Ignore messages from self
  const me = sock.user || {};
  const myNumbers = [jidNumber(me.id), jidNumber(me.lid)].filter(Boolean);
  if (myNumbers.includes(jidNumber(jid)) || myNumbers.includes(jidNumber(rawJid))) return;

  // Never process the same message twice
  if (alreadySeen(`${rawJid}:${key.id}`)) return;

  enqueue(jid, () => respond(sock, jid, msg));
}

// ---------------------------------------------------------------------------
// CONNECTION
// ---------------------------------------------------------------------------
let pairingRequested = false;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((e) => {
      console.error('Restart failed:', e && e.message ? e.message : e);
      scheduleReconnect();
    });
  }, CONFIG.RECONNECT_DELAY_MS);
}

function handleQr(sock, qr) {
  const link = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
  console.log('QR PAIRING LINK:', link);
  try {
    qrcode.generate(qr, { small: true });
  } catch (e) {
    /* terminal QR is optional */
  }

  const registered = sock.authState && sock.authState.creds && sock.authState.creds.registered;
  if (pairingRequested || registered) return;

  if (!/^91\d{10}$/.test(CONFIG.BOT_NUMBER)) {
    console.log('BOT_NUMBER is not set to a valid 91XXXXXXXXXX number - use the QR link above to pair.');
    return;
  }

  pairingRequested = true;
  setTimeout(async () => {
    try {
      const code = await sock.requestPairingCode(CONFIG.BOT_NUMBER);
      const formatted = String(code).match(/.{1,4}/g).join('-');
      console.log(`PAIRING CODE: ${formatted}`);
    } catch (err) {
      pairingRequested = false; // allow a retry on the next QR
      console.error('Pairing code request failed:', err && err.message ? err.message : err);
    }
  }, 1000);
}

async function startBot() {
  fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.SESSION_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    console.warn('Could not fetch latest WA version, using library default.');
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) handleQr(sock, qr);

    if (connection === 'open') {
      console.log(`${CONFIG.AI_NAME} is online as ${sock.user ? sock.user.id : 'unknown'} ✅`);
    }

    if (connection === 'close') {
      const code =
        lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : undefined;
      console.log(`Connection closed (code: ${code}).`);

      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out from WhatsApp. Clearing session and starting a fresh pairing...');
        try {
          fs.rmSync(CONFIG.SESSION_DIR, { recursive: true, force: true });
        } catch (e) {
          console.error('Could not clear session:', e.message);
        }
        users.clear();
        pairingRequested = false;
        scheduleReconnect();
        return;
      }

      if (code === DisconnectReason.connectionReplaced) {
        console.log('Session opened somewhere else (connection replaced). Exiting.');
        saveStateNow();
        process.exit(0);
      }

      scheduleReconnect();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      try {
        await handleIncoming(sock, msg);
      } catch (err) {
        console.error('Message error:', err && err.message ? err.message : err);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// PROCESS SAFETY
// ---------------------------------------
