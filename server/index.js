// index.js
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend from ../public (jer je index.js u /server)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  extensions: ['html']
}));

// Explicit ads.txt route (AdSense requirement)
app.get('/ads.txt', (req, res) => {
  res.type('text/plain').send('google.com, 9184399190245939, DIRECT, f08c47fec0942fa0');
});

// Root -> index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/** ===== Utilities (Europe/Zagreb day key) ===== */
const tz = 'Europe/Zagreb';
function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d);
}
let currentDay = dayKey();

/** ===== In-memory state =====
 * players: { [playerId]: { name, credits, flashShieldActive (bool), saveFromReset (int) } }
 * leaderboards: { [YYYY-MM-DD]: Map<playerId, { playerId, name, score }> }  (today is currentDay)
 * sseClients: Map<playerId, res> for SSE
*/
const players = {};
const leaderboards = { [currentDay]: new Map() };
const sseClients = new Map();

let lastManualReset = 0;
const RESET_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

/** ===== Game constants ===== */
const ADMIN_TRIGGER = 'xfiles75';
const MONEY_DROP_AMOUNT = 100; // $ iznos dropa (MVP)
const winners = {}; // { [YYYY-MM-DD]: { day, playerId, name, score, prize, paid:false } }

/** ===== Items & prices (MVP) ===== */
const ITEM_PRICES = {
  FLASHBANG: 10,
  RESET_LEADERBOARD: 50,
  SAVE_FROM_RESET: 25,
  SAVE_FROM_FLASHBANGS: 15,
};

/** ===== SSE (Server-Sent Events) ===== */
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  
  const playerId = req.query.playerId || (Math.random().toString(36).slice(2));
  sseClients.set(playerId, res);
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, day: currentDay, playerId })}\n\n`);
  
  req.on('close', () => sseClients.delete(playerId));
});

function sseSendTo(playerId, event, data) {
  const res = sseClients.get(playerId);
  if (!res) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [, res] of sseClients) res.write(msg);
}

/** ===== Daily rollover checker ===== */
setInterval(() => {
  const nowKey = dayKey();
  if (nowKey !== currentDay) {
    // Prepare next day
    const prevDay = currentDay;
    currentDay = nowKey;
    if (!leaderboards[currentDay]) leaderboards[currentDay] = new Map();

    // Odredi pobjednika prethodnog dana i spremi ga
    const prevLB = leaderboards[prevDay] ? Array.from(leaderboards[prevDay].values()) : [];
    if (prevLB.length) {
      const top1 = prevLB.sort((a,b)=>b.score-a.score)[0];
      winners[prevDay] = {
        day: prevDay,
        playerId: top1.playerId,
        name: top1.name,
        score: top1.score,
        prize: MONEY_DROP_AMOUNT,
        paid: false
      };
    }

    // Apply "save from reset": carry over best score once
    for (const [pid, p] of Object.entries(players)) {
      if (p.saveFromReset > 0) {
        const prev = leaderboards[prevDay]?.get(pid);
        if (prev && prev.score > 0) {
          leaderboards[currentDay].set(pid, { playerId: pid, name: p.name, score: prev.score });
          p.saveFromReset -= 1;
        }
      }
    }

    broadcast('forceReset', { newDay: currentDay });
  }
}, 1000);

/** ===== Auth-lite: register or get player ===== */
app.post('/register', (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 16) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const isAdmin = name.includes(ADMIN_TRIGGER);
  const cleanName = isAdmin ? name.replaceAll(ADMIN_TRIGGER, '').trim() : name;
  const playerId = uuidv4();
  const claimCode = 'drop-' + playerId.slice(0, 8);
  players[playerId] = {
    name: cleanName,
    credits: isAdmin ? 9999 : 100,  // admin gets more credits
    flashShieldActive: false,
    saveFromReset: 0,
    isAdmin,
    claimCode
  };
  return res.json({ 
    playerId, 
    name, 
    credits: players[playerId].credits, 
    day: currentDay,
    claimCode
  });
});

/** ===== Public status ===== */
app.get('/status', (req, res) => {
  res.json({ day: currentDay, itemPrices: ITEM_PRICES, prize: MONEY_DROP_AMOUNT });
});

/** ===== Get yesterday's winner ===== */
app.get('/yesterday-winner', (req, res) => {
  // vrati pobjednika za zadnji dan prije currentDay koji postoji
  const days = Object.keys(winners).sort(); // YYYY-MM-DD
  if (!days.length) return res.json(null);
  const last = days[days.length - 1];
  return res.json(winners[last]);
});

/** ===== Get recent winners ===== */
app.get('/winners', (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '7', 10), 30));
  const days = Object.keys(winners).sort();
  const slice = days.slice(-limit).map(d => winners[d]);
  res.json(slice);
});

/** ===== Submit score ===== */
app.post('/submit-score', (req, res) => {
  const { playerId, playerName, score } = req.body || {};
  if (!players[playerId]) return res.status(400).json({ error: 'Invalid player' });
  if (typeof score !== 'number' || !isFinite(score) || score < 0) return res.status(400).json({ error: 'Invalid score' });
  if (!leaderboards[currentDay]) leaderboards[currentDay] = new Map();

  // Update player name if new one provided
  if (playerName && typeof playerName === 'string' && playerName.length > 0 && playerName.length <= 16) {
    players[playerId].name = playerName;
  }

  const existing = leaderboards[currentDay].get(playerId);
  const best = existing ? Math.max(existing.score, Math.floor(score)) : Math.floor(score);
  leaderboards[currentDay].set(playerId, { 
    playerId, 
    name: players[playerId].name, 
    score: best 
  });
  res.json({ ok: true, best });
});

/** ===== Get today leaderboard ===== */
app.get('/leaderboard', (req, res) => {
  const lb = Array.from(leaderboards[currentDay].values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
  res.json(lb);
});

/** ===== Purchases ===== */
app.post('/purchase', (req, res) => {
  const { playerId, item } = req.body || {};
  if (!players[playerId]) return res.status(400).json({ error: 'Invalid player' });
  if (!ITEM_PRICES[item]) return res.status(400).json({ error: 'Invalid item' });

  const p = players[playerId];
  const price = ITEM_PRICES[item];
  if (p.credits < price) return res.status(400).json({ error: 'Not enough credits' });

  p.credits -= price;

  if (item === 'SAVE_FROM_RESET') {
    p.saveFromReset += 1;
  } else if (item === 'SAVE_FROM_FLASHBANGS') {
    p.flashShieldActive = true; // trajno ON (MVP)
  }

  res.json({ ok: true, credits: p.credits, player: { flashShieldActive: p.flashShieldActive, saveFromReset: p.saveFromReset } });
});

/** ===== Use active items that trigger events ===== */
app.post('/use-item', (req, res) => {
  const { playerId, item } = req.body || {};
  if (!players[playerId]) return res.status(400).json({ error: 'Invalid player' });

  if (item === 'FLASHBANG') {
    // Get all connected players except sender
    const all = Array.from(sseClients.keys());
    const pool = all.filter(id => id !== playerId);
    
    // Shuffle and pick 50 random targets
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const targets = pool.slice(0, 50);
    
    // Send flashbang to selected targets
    targets.forEach(id => sseSendTo(id, 'flashbang', { by: playerId, ts: Date.now() }));
    
    return res.json({ ok: true });
  }
  if (item === 'RESET_LEADERBOARD') {
    const now = Date.now();
    const diff = now - lastManualReset;
    if (diff < RESET_COOLDOWN_MS) {
      const left = Math.ceil((RESET_COOLDOWN_MS - diff)/1000);
      return res.status(429).json({ error: 'RESET_COOLDOWN', secondsLeft: left });
    }
    lastManualReset = now;
    leaderboards[currentDay] = new Map();
    broadcast('forceReset', { manual: true, newDay: currentDay });
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'Item cannot be used or not implemented' });
});

/** ===== Simple player profile ===== */
app.get('/me', (req, res) => {
  const { playerId } = req.query;
  if (!players[playerId]) return res.status(404).json({ error: 'Invalid player' });
  const p = players[playerId];
  res.json({ playerId, name: p.name, credits: p.credits, flashShieldActive: p.flashShieldActive, saveFromReset: p.saveFromReset, day: currentDay });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
