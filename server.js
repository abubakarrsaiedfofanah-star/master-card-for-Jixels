const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;

function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const port = Number(process.env.PORT || 8080);
const dbPath = path.join(root, 'cards-db.json');
const auditPath = path.join(root, 'audit-log.json');
const adminConfigPath = path.join(root, 'admin-config.json');
const masterConfigPath = path.join(root, 'master-config.json');
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || '1234';
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const masterToken = String(process.env.MASTER_TOKEN || '').trim();
const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const useSupabase = Boolean(supabaseUrl && supabaseServiceRoleKey);
const sessions = new Map();
const rateBuckets = new Map();

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, data) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(data));
}

function securityHeaders(extra = {}) {
  const httpsHeader = process.env.HTTPS_KEY && process.env.HTTPS_CERT ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {};
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self' https://api.qrserver.com https://cdn.jsdelivr.net; img-src 'self' data: https://api.qrserver.com; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    ...httpsHeader,
    ...extra
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function localLoadCards() {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function localSaveCards(cards) {
  fs.writeFileSync(dbPath, JSON.stringify(cards, null, 2));
}

function localLoadAudit() {
  if (!fs.existsSync(auditPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function localSaveAudit(log) {
  fs.writeFileSync(auditPath, JSON.stringify(log, null, 2));
}

function fromSupabaseCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    branch: row.branch,
    nationalId: row.national_id,
    phone: row.phone,
    position: row.position,
    photo: row.photo,
    verificationToken: row.verification_token,
    status: row.status,
    inactiveReason: row.inactive_reason,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSupabaseCard(card) {
  return {
    id: card.id,
    name: card.name,
    location: card.location,
    branch: card.branch,
    national_id: card.nationalId,
    phone: card.phone,
    position: card.position,
    photo: card.photo,
    verification_token: card.verificationToken,
    status: card.status || 'Pending',
    inactive_reason: card.inactiveReason || null,
    approved_by: card.approvedBy || null,
    approved_at: card.approvedAt || null,
    created_at: card.createdAt,
    updated_at: card.updatedAt || null
  };
}

function fromSupabaseAudit(row) {
  return {
    action: row.action,
    cardId: row.card_id || '',
    actor: row.actor,
    at: row.created_at
  };
}

function toSupabaseAudit(item) {
  return {
    action: item.action,
    card_id: item.cardId || item.card_id || '',
    actor: item.actor || 'system',
    created_at: item.at || item.created_at || new Date().toISOString()
  };
}

function supabaseRequest(method, table, query = '', body) {
  return new Promise((resolve, reject) => {
    const base = new URL(`${supabaseUrl}/rest/v1/${table}${query}`);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(base, {
      method,
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(data || `Supabase request failed with ${res.statusCode}`));
          return;
        }
        if (!data) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadCards() {
  if (!useSupabase) return localLoadCards();
  const rows = await supabaseRequest('GET', 'cards', '?select=*&order=created_at.asc');
  return rows.map(fromSupabaseCard);
}

async function saveCards(cards) {
  if (!useSupabase) {
    localSaveCards(cards);
    return;
  }
  await supabaseRequest('DELETE', 'cards', '?id=not.is.null');
  if (cards.length) await supabaseRequest('POST', 'cards', '', cards.map(toSupabaseCard));
}

async function loadAudit() {
  if (!useSupabase) return localLoadAudit();
  const rows = await supabaseRequest('GET', 'audit_log', '?select=*&order=created_at.desc');
  return rows.map(fromSupabaseAudit);
}

async function saveAudit(log) {
  if (!useSupabase) {
    localSaveAudit(log);
    return;
  }
  await supabaseRequest('DELETE', 'audit_log', '?id=not.is.null');
  if (log.length) await supabaseRequest('POST', 'audit_log', '', log.map(toSupabaseAudit));
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function loadAdminConfig() {
  if (fs.existsSync(adminConfigPath)) {
    try { return JSON.parse(fs.readFileSync(adminConfigPath, 'utf8')); } catch {}
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    username: adminUser,
    salt,
    passwordHash: hashPassword(adminPass, salt),
    role: 'super-admin',
    branch: ''
  };
  fs.writeFileSync(adminConfigPath, JSON.stringify(config, null, 2));
  return config;
}

function saveAdminConfig(config) {
  fs.writeFileSync(adminConfigPath, JSON.stringify(config, null, 2));
}

function loadMasterConfig() {
  if (masterToken) return { token: masterToken };
  if (fs.existsSync(masterConfigPath)) {
    try { return JSON.parse(fs.readFileSync(masterConfigPath, 'utf8')); } catch {}
  }
  const config = { token: crypto.randomBytes(24).toString('hex') };
  fs.writeFileSync(masterConfigPath, JSON.stringify(config, null, 2));
  return config;
}

function appBaseUrl(req) {
  if (publicBaseUrl) return publicBaseUrl;
  const protocol = process.env.HTTPS_KEY && process.env.HTTPS_CERT ? 'https' : 'http';
  return `${protocol}://${req.headers.host}`;
}

function checkRate(req, key, limit, windowMs) {
  const ip = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const bucketKey = `${key}:${ip}`;
  const bucket = rateBuckets.get(bucketKey) || [];
  const fresh = bucket.filter((time) => now - time < windowMs);
  fresh.push(now);
  rateBuckets.set(bucketKey, fresh);
  return fresh.length <= limit;
}

function normalizePosition(position) {
  return String(position || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function positionCode(position) {
  const normalized = normalizePosition(position);
  if (normalized === 'director') return 'D';

  const words = normalizePosition(position)
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean);

  if (!words.length) return 'GEN';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((word) => word[0]).join('').slice(0, 4).toUpperCase();
}

function createUniqueId(cards, position) {
  const normalized = normalizePosition(position);
  const code = positionCode(position);
  const existing = new Set(cards.map((card) => card.id));

  if (normalized === 'director' && !existing.has('JIX/D')) return 'JIX/D';

  const positionCount = cards.filter((card) => normalizePosition(card.position) === normalized).length;
  let sequence = positionCount + 1;
  let id = '';

  do {
    id = `JIX/${code}/${String(sequence).padStart(3, '0')}`;
    sequence += 1;
  } while (existing.has(id));

  return id;
}

function createVerificationToken() {
  return crypto.randomBytes(24).toString('hex');
}

function currentAdmin(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && sessions.has(token)) {
    const session = sessions.get(token);
    if (Date.now() < session.expiresAt) return session;
    sessions.delete(token);
  }
  return null;
}

function isAdmin(req) {
  return Boolean(currentAdmin(req));
}

async function appendAudit(action, card, actor = 'system') {
  const entry = { action, cardId: card?.id || '', actor, at: new Date().toISOString() };
  if (!useSupabase) {
    const log = localLoadAudit();
    log.push(entry);
    localSaveAudit(log);
    return;
  }
  await supabaseRequest('POST', 'audit_log', '', toSupabaseAudit(entry));
}

function publicCard(card) {
  if (!card) return null;
  const valid = (card.status || 'Pending') === 'Approved';
  const status = card.status || 'Pending';
  const invalidReason = valid ? '' : (
    status === 'Inactive' ? (card.inactiveReason || 'This worker is no longer active.') :
    status === 'Suspended' ? 'This worker has been suspended.' :
    status === 'Lost' ? 'This ID card was reported lost.' :
    status === 'Rejected' ? 'This registration was rejected by admin.' :
    'This worker has not been approved by admin.'
  );
  const nationalId = String(card.nationalId || '');
  return {
    id: card.id,
    name: card.name,
    location: card.location,
    branch: card.branch,
    nationalIdLast4: nationalId ? nationalId.slice(-4) : '',
    photo: card.photo || '',
    position: card.position,
    status,
    valid,
    validity: valid ? 'Valid Worker' : 'Not Valid',
    invalidReason,
    inactiveReason: card.inactiveReason || '',
    verifiedAt: new Date().toISOString(),
    createdAt: card.createdAt
  };
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith('/api/') && !checkRate(req, url.pathname, 120, 60_000)) {
    sendJson(res, 429, { error: 'Too many requests. Please slow down.' });
    return true;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, storage: useSupabase ? 'supabase' : 'local-json' });
    return true;
  }

  if (url.pathname === '/api/master-link' && req.method === 'GET') {
    const masterUrl = new URL('/', appBaseUrl(req));
    masterUrl.searchParams.set('master', loadMasterConfig().token);
    masterUrl.hash = 'apply';
    sendJson(res, 200, { url: masterUrl.href });
    return true;
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!checkRate(req, 'login', 8, 15 * 60_000)) {
      sendJson(res, 429, { error: 'Too many login attempts. Try again later.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const config = loadAdminConfig();
      const ok = String(payload.username || '') === config.username &&
        hashPassword(payload.password || '', config.salt) === config.passwordHash;
      if (!ok) {
        sendJson(res, 401, { error: 'Invalid username or password.' });
        return true;
      }
      const token = crypto.randomBytes(24).toString('hex');
      const session = {
        username: config.username,
        role: config.role || 'super-admin',
        branch: config.branch || '',
        expiresAt: Date.now() + 8 * 60 * 60 * 1000
      };
      sessions.set(token, session);
      sendJson(res, 200, { token, username: session.username, role: session.role, branch: session.branch, expiresAt: session.expiresAt });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname === '/api/change-password' && req.method === 'POST') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const config = loadAdminConfig();
      const salt = crypto.randomBytes(16).toString('hex');
      config.username = String(payload.username || config.username).trim() || config.username;
      config.salt = salt;
      config.passwordHash = hashPassword(payload.password || '', salt);
      saveAdminConfig(config);
      await appendAudit('password-changed', { id: config.username }, admin.username);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname === '/api/cards' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'Admin PIN required.' });
      return true;
    }
    sendJson(res, 200, { cards: await loadCards() });
    return true;
  }

  if (url.pathname === '/api/audit' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'Admin PIN required.' });
      return true;
    }
    sendJson(res, 200, { log: await loadAudit() });
    return true;
  }

  if (url.pathname === '/api/backup' && req.method === 'GET') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    sendJson(res, 200, { cards: await loadCards(), audit: await loadAudit(), exportedAt: new Date().toISOString() });
    return true;
  }

  if (url.pathname === '/api/restore' && req.method === 'POST') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      if (!Array.isArray(payload.cards)) {
        sendJson(res, 400, { error: 'Backup must include cards array.' });
        return true;
      }
      await saveCards(payload.cards);
      if (Array.isArray(payload.audit)) await saveAudit(payload.audit);
      await appendAudit('restored-backup', { id: 'backup' }, admin.username);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid backup.' });
    }
    return true;
  }

  if (url.pathname === '/api/verify' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const card = (await loadCards()).find((item) => item.verificationToken === token);
    if (!card) {
      sendJson(res, 200, {
        card: {
          id: 'Unknown',
          name: 'Card Not Found',
          position: '',
          branch: '',
          nationalIdLast4: '',
          photo: '',
          status: 'Deleted',
          valid: false,
          validity: 'Not Valid',
          invalidReason: 'This card is not active in the system.',
          verifiedAt: new Date().toISOString()
        }
      });
      return true;
    }
    sendJson(res, 200, { card: publicCard(card) });
    return true;
  }

  if (url.pathname === '/api/cards' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const cards = await loadCards();
      const card = {
        id: '',
        name: String(payload.name || '').trim(),
        location: String(payload.location || '').trim(),
        branch: String(payload.branch || '').trim(),
        nationalId: String(payload.nationalId || '').trim(),
        phone: String(payload.phone || '').trim(),
        position: String(payload.position || '').trim(),
        photo: String(payload.photo || ''),
        inactiveReason: '',
        status: 'Pending',
        createdAt: new Date().toISOString()
      };

      if (String(payload.masterToken || '') !== loadMasterConfig().token && !isAdmin(req)) {
        sendJson(res, 403, { error: 'Registration must come from the master card QR.' });
        return true;
      }

      if (!card.name || !card.location || !card.branch || !card.nationalId || !card.phone || !card.position || !card.photo) {
        sendJson(res, 400, { error: 'All fields are required.' });
        return true;
      }

      if (cards.some((item) => String(item.phone || '').trim() === card.phone)) {
        sendJson(res, 409, { error: 'This phone number is already registered.' });
        return true;
      }
      if (cards.some((item) => String(item.nationalId || '').trim() === card.nationalId)) {
        sendJson(res, 409, { error: 'This National ID is already registered.' });
        return true;
      }

      if (normalizePosition(card.position) === 'director') {
        const directorExists = cards.some((item) => normalizePosition(item.position) === 'director');
        if (directorExists) {
          sendJson(res, 409, { error: 'Director card already exists. Only one Director can register.' });
          return true;
        }
      }

      card.id = createUniqueId(cards, card.position);
      card.verificationToken = createVerificationToken();
      cards.push(card);
      await saveCards(cards);
      await appendAudit('created', card, isAdmin(req) ? 'admin' : 'public');
      sendJson(res, 201, { card });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cards/') && req.method === 'PUT') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'Admin PIN required.' });
      return true;
    }
    try {
      const id = decodeURIComponent(url.pathname.replace('/api/cards/', ''));
      const payload = JSON.parse(await readBody(req));
      const cards = await loadCards();
      const index = cards.findIndex((card) => card.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Card not found.' });
        return true;
      }

      cards[index] = {
        ...cards[index],
        name: String(payload.name || '').trim(),
        location: String(payload.location || '').trim(),
        branch: String(payload.branch || '').trim(),
        nationalId: String(payload.nationalId || '').trim(),
        phone: String(payload.phone || '').trim(),
        position: String(payload.position || '').trim(),
        status: String(payload.status || cards[index].status || 'Pending').trim() || 'Pending',
        inactiveReason: String(payload.inactiveReason || cards[index].inactiveReason || '').trim(),
        photo: payload.photo ? String(payload.photo) : cards[index].photo,
        updatedAt: new Date().toISOString()
      };

      if (!cards[index].name || !cards[index].location || !cards[index].branch || !cards[index].nationalId || !cards[index].phone || !cards[index].position || !cards[index].photo) {
        sendJson(res, 400, { error: 'Name, location, branch, National ID, phone, position, and picture are required.' });
        return true;
      }

      if (cards.some((item, itemIndex) => itemIndex !== index && String(item.phone || '').trim() === cards[index].phone)) {
        sendJson(res, 409, { error: 'This phone number is already registered.' });
        return true;
      }
      if (cards.some((item, itemIndex) => itemIndex !== index && String(item.nationalId || '').trim() === cards[index].nationalId)) {
        sendJson(res, 409, { error: 'This National ID is already registered.' });
        return true;
      }

      await saveCards(cards);
      await appendAudit('edited', cards[index], 'admin');
      sendJson(res, 200, { card: cards[index] });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cards/') && url.pathname.endsWith('/status') && req.method === 'PATCH') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'Admin PIN required.' });
      return true;
    }
    try {
      const id = decodeURIComponent(url.pathname.replace('/api/cards/', '').replace('/status', ''));
      const payload = JSON.parse(await readBody(req));
      const status = String(payload.status || '').trim();
      if (!['Pending', 'Approved', 'Rejected', 'Suspended', 'Lost', 'Inactive'].includes(status)) {
        sendJson(res, 400, { error: 'Invalid status.' });
        return true;
      }
      const cards = await loadCards();
      const card = cards.find((item) => item.id === id);
      if (!card) {
        sendJson(res, 404, { error: 'Card not found.' });
        return true;
      }
      card.status = status;
      card.inactiveReason = status === 'Inactive' ? String(payload.inactiveReason || payload.reason || card.inactiveReason || 'This worker is no longer active.').trim() : '';
      if (status === 'Approved') {
        card.verificationToken = card.verificationToken || createVerificationToken();
        card.approvedAt = new Date().toISOString();
        card.approvedBy = currentAdmin(req)?.username || req.headers['x-admin-user'] || 'admin';
      }
      card.updatedAt = new Date().toISOString();
      await saveCards(cards);
      await appendAudit(`status:${status}`, card, req.headers['x-admin-user'] || 'admin');
      sendJson(res, 200, { card });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cards/') && req.method === 'DELETE') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'Admin PIN required.' });
      return true;
    }
    const id = decodeURIComponent(url.pathname.replace('/api/cards/', ''));
    const cards = await loadCards();
    const card = cards.find((item) => item.id === id);
    if (!card) {
      sendJson(res, 404, { error: 'Card not found.' });
      return true;
    }
    card.status = 'Inactive';
    card.inactiveReason = 'Marked inactive instead of deleted.';
    card.updatedAt = new Date().toISOString();
    await saveCards(cards);
    await appendAudit('inactive-via-delete-request', card, currentAdmin(req)?.username || 'admin');
    sendJson(res, 200, { ok: true, card, message: 'Card marked inactive instead of deleted.' });
    return true;
  }

  return false;
}

const app = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleApi(req, res, url)) return;

  const requested = url.pathname === '/' ? '/index.html' : (url.pathname === '/admin' ? '/admin.html' : url.pathname);
  const filePath = path.join(root, path.normalize(requested));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, securityHeaders({ 'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream' }));
    res.end(data);
  });
};

const server = process.env.HTTPS_KEY && process.env.HTTPS_CERT
  ? https.createServer({
      key: fs.readFileSync(process.env.HTTPS_KEY),
      cert: fs.readFileSync(process.env.HTTPS_CERT)
    }, app)
  : http.createServer(app);

server.listen(port, '0.0.0.0', () => {
  const protocol = process.env.HTTPS_KEY && process.env.HTTPS_CERT ? 'https' : 'http';
  console.log(`Jixels ID app running at ${protocol}://localhost:${port}`);
});
