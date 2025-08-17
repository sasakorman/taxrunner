// index.js
import dotenv from 'dotenv';
dotenv.config({ override: true });

// ==== Feature flags ====
const PAYMENTS_ENABLED = false;

import express from 'express';
import fs from 'fs';
import bodyParser from 'body-parser';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // VAŽNO na Renderu

const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-key';
const port = process.env.PORT || 3000;

// HTTPS + kanonski host
app.use((req, res, next) => {
  const host = req.headers.host;
  const wantHost = 'taxrunner.online';
  if (!req.secure) {
    return res.redirect(301, 'https://' + host + req.originalUrl);
  }
  if (host !== wantHost) {
    return res.redirect(301, 'https://' + wantHost + req.originalUrl);
  }
  next();
});

// Enable compression
app.use(compression());

app.use(cors());
// --- pending grants ---
const pendingGrants = new Map(); // playerId -> { ITEM: count, ... }

function queueGrant(playerId, item, count = 1) {
  const cur = pendingGrants.get(playerId) || {};
  cur[item] = (cur[item] || 0) + count;
  pendingGrants.set(playerId, cur);
  // pokušaj i real-time push (ako je user spojen)
  sseSendTo(playerId, 'purchaseCompleted', { item, count });
}


app.get('/claim-grants', (req, res) => {
  const playerId = req.query.playerId;
  const grants = pendingGrants.get(playerId) || {};
  pendingGrants.delete(playerId);
  res.json(grants);
});

// --- TEK SAD JSON ZA OSTALE RUTE ---
app.use(express.json());

// Serve static frontend from ../public with .html extension support
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '30d',
  etag: true,
  immutable: true,
  extensions: ['html']
}));

// /play as main game route
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Redirect root to /play
app.get('/', (req, res) => res.redirect(302, '/play'));

// robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /
Sitemap: https://taxrunner.online/sitemap.xml`
  );
});

// sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const urls = [
    '/', '/play', '/earn-money-playing-games',
    '/play-to-earn', '/free-games-that-pay', '/how-it-works',
    '/earn-money-by-playing-games/us',
    '/earn-money-by-playing-games/uk',
    '/earn-money-by-playing-games/de',
    '/earn-money-by-playing-games/hr'
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urls.map(u => `<url><loc>https://taxrunner.online${u}</loc></url>`).join('')}
  </urlset>`;
  res.type('application/xml').send(body);
});

// Explicit ads.txt route (AdSense requirement)
app.get('/ads.txt', (req, res) => {
  res.type('text/plain').send('google.com, pub-9184399190245939, DIRECT, f08c47fec0942fa0');
});

// Root -> index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Play route -> index.html
app.get('/play', (_req, res) => {
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

function saveState() {
  fs.writeFileSync('players.json', JSON.stringify(players, null, 2));
}

function loadState() {
  if (fs.existsSync('players.json')) {
    const data = fs.readFileSync('players.json', 'utf8');
    Object.assign(players, JSON.parse(data));
  }
}

loadState();
setInterval(saveState, 30000); // svake 30s spremi

const leaderboards = { [currentDay]: new Map() };
const sseClients = new Map();
const runs = new Map(); // runId -> { playerId, startedAt }

let lastManualReset = 0;
const RESET_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

/** ===== Game constants ===== */
const ADMIN_TRIGGER = 'xfiles75';
let MONEY_DROP_AMOUNT = 100; // globalni drop (server-side)
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

/** ===== Clean up old runs ===== */
function cleanupOldRuns() {
  const now = Date.now();
  const hourAgo = now - 3600000; // 1 hour
  for (const [runId, run] of runs.entries()) {
    if (run.startedAt < hourAgo) {
      runs.delete(runId);
    }
  }
}

/** ===== Daily rollover checker ===== */
setInterval(() => {
  cleanupOldRuns();
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
      // Generate verification secret for winner
      const claimSecret = crypto.randomBytes(32).toString('hex');
      const claimCode = 'win-' + crypto.randomBytes(8).toString('hex');
      const claimHash = crypto.createHash('sha256').update(claimSecret).digest('hex');
      
      winners[prevDay] = {
        day: prevDay,
        playerId: top1.playerId,
        name: top1.name,
        score: top1.score,
        prize: MONEY_DROP_AMOUNT,
        paid: false,
        verified: false,
        claimHash,
        claimCode
      };
      
      // Notify winner via SSE
      sseSendTo(top1.playerId, 'youWon', {
        day: prevDay,
        claimCode,
        claimSecret,
        prize: MONEY_DROP_AMOUNT
      });
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
  const raw = (req.body?.name || '').toString().trim();

  // Dozvoli duže dok tražimo admin trigger, ali prikaz skratimo na 16
  if (!raw || raw.length > 32) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  const isAdmin = raw.includes(ADMIN_TRIGGER) || raw === ADMIN_TRIGGER;

  // ⚠️ NE prikazuj trigger u imenu — samo služi za detekciju
  const baseName  = raw.replaceAll(ADMIN_TRIGGER, '').trim();
  const cleanName = baseName.slice(0, 16); // što se vidi u igri

  const playerId  = uuidv4();
  const claimCode = 'drop-' + playerId.slice(0, 8);

  players[playerId] = {
    name: cleanName,
    credits: isAdmin ? 9999 : 100,
    flashShieldActive: false,
    saveFromReset: 0,
    isAdmin,
    claimCode,
  };

  res.json({ playerId, name: cleanName, credits: players[playerId].credits, day: currentDay, claimCode });
});

/** ===== Public status ===== */
app.get('/status', (req, res) => {
  res.json({ day: currentDay, itemPrices: ITEM_PRICES, prize: MONEY_DROP_AMOUNT });
});

/** ===== Private winner info ===== */
app.get('/me/winner', (req, res) => {
  const { playerId } = req.query;
  if (!players[playerId]) return res.json(null);
  const days = Object.keys(winners).sort();
  if (!days.length) return res.json(null);
  const last = days[days.length - 1];
  const w = winners[last];
  if (!w || w.playerId !== playerId) return res.json(null);
  // ne vraćamo secret, samo status
  res.json({ day: w.day, prize: w.prize, verified: !!w.verified, paid: !!w.paid });
});

/** ===== Admin verification ===== */
app.post('/admin/verify-claim', express.json(), (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const { day, playerId, claimSecret } = req.body || {};
  const w = winners[day];
  if (!w || w.playerId !== playerId) return res.status(404).json({ error: 'not-found' });

  const hash = crypto.createHash('sha256').update(String(claimSecret)).digest('hex');
  if (hash !== w.claimHash) return res.status(400).json({ error: 'bad-secret' });

  w.verified = true;
  w.verifiedAt = new Date().toISOString();
  saveState();

  res.json({ ok: true, winner: { ...w, claimHash: undefined } });
});

/** ===== Verify winner claim ===== */
app.post('/verify-winner', (req, res) => {
  const { playerId, claimCode, claimSecret } = req.body || {};
  if (!playerId || !claimCode || !claimSecret) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const day = Object.keys(winners).find(d =>
    winners[d].playerId === playerId && winners[d].claimCode === claimCode
  );
  if (!day) return res.status(404).json({ error: 'Invalid claim' });

  const w = winners[day];
  const hash = crypto.createHash('sha256').update(String(claimSecret)).digest('hex');
  if (hash !== w.claimHash) return res.status(403).json({ error: 'Invalid verification' });

  w.verified = true;
  w.verifiedAt = new Date().toISOString();
  return res.json({ ok:true, name:w.name, score:w.score, prize:w.prize, day:w.day });
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

/** ===== Start a new game run ===== */
app.post('/start-run', (req, res) => {
  const { playerId } = req.body || {};
  if (!players[playerId]) return res.status(400).json({ error: 'Invalid player' });
  const runId = uuidv4();
  runs.set(runId, { playerId, startedAt: Date.now() });
  res.json({ ok: true, runId });
});

/** ===== Submit score ===== */
app.post('/submit-score', (req, res) => {
  const { playerId, playerName, score, runId, jumpIntervals } = req.body || {};
  if (!players[playerId]) return res.status(400).json({ error: 'Invalid player' });
  if (typeof score !== 'number' || !isFinite(score) || score < 0)
    return res.status(400).json({ error: 'Invalid score' });
  if (!leaderboards[currentDay]) leaderboards[currentDay] = new Map();

  // === Anti-cheat (preskoči za admina)
  if (!players[playerId].isAdmin) {
    const run = runs.get(runId);
    if (!run || run.playerId !== playerId)
      return res.status(400).json({ error: 'No active run' });

    const elapsedSec = (Date.now() - run.startedAt) / 1000;
    // lakši prag + 2s grace da ne pukne zbog sitnih odgoda
    const minSec = Math.max(score / 6, 8);     // prije 10
    if (elapsedSec + 2 < minSec) {
      return res.status(400).json({ error: 'Too fast', need: Math.ceil(minSec), elapsed: Math.floor(elapsedSec) });
    }

    if (Array.isArray(jumpIntervals) && jumpIntervals.length >= 10) {
      const avg = jumpIntervals.reduce((a, b) => a + b, 0) / jumpIntervals.length;
      const variance = jumpIntervals.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / jumpIntervals.length;
      const stddev = Math.sqrt(variance);
      if (stddev < 50) {
        return res.status(400).json({ error: 'Unnatural rhythm' });
      }
    }

    runs.delete(runId);
  }

  // Ažuriraj ime (opcionalno)
  if (playerName && typeof playerName === 'string' && playerName.length > 0 && playerName.length <= 16) {
    players[playerId].name = playerName;
  }

  const existing = leaderboards[currentDay].get(playerId);
  const best = existing ? Math.max(existing.score, Math.floor(score)) : Math.floor(score);
  leaderboards[currentDay].set(playerId, { playerId, name: players[playerId].name, score: best });

  // 🔔 Reci SVIMA da se leaderboard promijenio
  broadcast('leaderboardUpdated', { playerId, name: players[playerId].name, score: best });

  res.json({ ok: true, best });
});

/** ===== Get today leaderboard ===== */
app.get('/leaderboard', (req, res) => {
  if (!leaderboards[currentDay]) leaderboards[currentDay] = new Map(); // safety
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

// ALIAS ROUTES - for HTML client compatibility
app.get('/api/leaderboard', (req, res) => {
  res.redirect(307, '/leaderboard');
});

app.post('/api/submit', (req, res) => {
  req.url = '/submit-score';
  app._router.handle(req, res);
});

// ===== Admin: set daily drop =====
app.post('/set-drop', (req, res) => {
  const { playerId, amount } = req.body || {};
  if (!players[playerId]) return res.status(400).json({ error: 'Invalid player' });
  if (!players[playerId].isAdmin) return res.status(403).json({ error: 'Not admin' });

  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const val = Math.round(num * 100) / 100; // 2 decimale
  MONEY_DROP_AMOUNT = val;

  // pošalji svima preko SSE-a
  broadcast('dropUpdated', { amount: val });

  return res.json({ ok: true, amount: val });
});


// umjesto prave checkout rute:
app.post('/create-checkout-session', (_req, res) => {
  return res.status(410).json({ error: 'PAYMENTS_DISABLED' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'running' });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
