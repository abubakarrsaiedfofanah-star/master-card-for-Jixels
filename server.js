const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

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
const attendancePath = path.join(root, 'attendance-log.json');
const scannerDevicesPath = path.join(root, 'scanner-devices.json');
const adminConfigPath = path.join(root, 'admin-config.json');
const masterConfigPath = path.join(root, 'master-config.json');
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || '1234';
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const masterToken = String(process.env.MASTER_TOKEN || '').trim();
function normalizeSupabaseUrl(value) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9]{15,}$/i.test(raw)) return `https://${raw}.supabase.co`;
  return `https://${raw}`;
}

const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
const resetFromEmail = String(process.env.RESET_FROM_EMAIL || 'Jixels ID Cards <onboarding@resend.dev>').trim();
const useSupabase = Boolean(supabaseUrl && supabaseServiceRoleKey);
const sessions = new Map();
const rateBuckets = new Map();
const resetCodes = new Map();

const loginRequiredMessage = 'Please log in again as admin.';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
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
    'Content-Security-Policy': "default-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
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

function localLoadAttendance() {
  if (!fs.existsSync(attendancePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(attendancePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function localSaveAttendance(log) {
  fs.writeFileSync(attendancePath, JSON.stringify(log, null, 2));
}

function localLoadScannerDevices() {
  if (!fs.existsSync(scannerDevicesPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(scannerDevicesPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function localSaveScannerDevices(devices) {
  fs.writeFileSync(scannerDevicesPath, JSON.stringify(devices, null, 2));
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
    email: row.email || '',
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
    email: card.email || '',
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

function fromSupabaseAttendance(row) {
  return {
    id: row.id,
    cardId: row.card_id,
    workerName: row.worker_name,
    workerId: row.worker_id,
    branch: row.branch || '',
    position: row.position || '',
    attendanceDate: row.attendance_date,
    signedInAt: row.signed_in_at,
    signedOutAt: row.signed_out_at,
    signInLatitude: row.sign_in_latitude,
    signInLongitude: row.sign_in_longitude,
    signOutLatitude: row.sign_out_latitude,
    signOutLongitude: row.sign_out_longitude,
    locationAccuracy: row.location_accuracy,
    scanSource: row.scan_source || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSupabaseAttendance(item) {
  return {
    id: item.id,
    card_id: item.cardId,
    worker_name: item.workerName,
    worker_id: item.workerId,
    branch: item.branch || '',
    position: item.position || '',
    attendance_date: item.attendanceDate,
    signed_in_at: item.signedInAt || null,
    signed_out_at: item.signedOutAt || null,
    sign_in_latitude: item.signInLatitude ?? null,
    sign_in_longitude: item.signInLongitude ?? null,
    sign_out_latitude: item.signOutLatitude ?? null,
    sign_out_longitude: item.signOutLongitude ?? null,
    location_accuracy: item.locationAccuracy ?? null,
    scan_source: item.scanSource || '',
    status: item.status || 'Signed Out',
    created_at: item.createdAt,
    updated_at: item.updatedAt || null
  };
}

function fromSupabaseScannerDevice(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceSecret: row.device_secret || '',
    passwordSalt: row.password_salt || '',
    passwordHash: row.password_hash || '',
    deviceName: row.device_name || '',
    deviceOwner: row.device_owner || '',
    devicePhone: row.device_phone || '',
    registeredBy: row.registered_by || 'admin',
    status: row.status || 'Active',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSupabaseScannerDevice(item) {
  return {
    id: item.id,
    device_id: item.deviceId,
    device_secret: item.deviceSecret || '',
    password_salt: item.passwordSalt || '',
    password_hash: item.passwordHash || '',
    device_name: item.deviceName || '',
    device_owner: item.deviceOwner || '',
    device_phone: item.devicePhone || '',
    registered_by: item.registeredBy || 'admin',
    status: item.status || 'Active',
    created_at: item.createdAt,
    updated_at: item.updatedAt || null
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
          let errorData = null;
          try { errorData = data ? JSON.parse(data) : null; } catch {}
          const message = errorData?.message || errorData?.error || data || `Supabase request failed with ${res.statusCode}`;
          const error = new Error(message);
          error.code = errorData?.code;
          error.details = errorData?.details;
          error.hint = errorData?.hint;
          reject(error);
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

async function loadAttendance() {
  if (!useSupabase) return localLoadAttendance();
  const rows = await supabaseRequest('GET', 'attendance_records', '?select=*&order=created_at.desc');
  return rows.map(fromSupabaseAttendance);
}

async function saveAttendance(log) {
  if (!useSupabase) {
    localSaveAttendance(log);
    return;
  }
  await supabaseRequest('DELETE', 'attendance_records', '?id=not.is.null');
  if (log.length) await supabaseRequest('POST', 'attendance_records', '', log.map(toSupabaseAttendance));
}

async function loadScannerDevices() {
  if (!useSupabase) return localLoadScannerDevices();
  const rows = await supabaseRequest('GET', 'scanner_devices', '?select=*&order=created_at.desc');
  return rows.map(fromSupabaseScannerDevice);
}

async function saveScannerDevices(devices) {
  if (!useSupabase) {
    localSaveScannerDevices(devices);
    return;
  }
  await supabaseRequest('DELETE', 'scanner_devices', '?id=not.is.null');
  if (devices.length) await supabaseRequest('POST', 'scanner_devices', '', devices.map(toSupabaseScannerDevice));
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function loadAdminConfig() {
  if (fs.existsSync(adminConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(adminConfigPath, 'utf8'));
      if (!config.email && adminEmail) {
        config.email = adminEmail;
        saveAdminConfig(config);
      }
      return config;
    } catch {}
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    username: adminUser,
    email: adminEmail,
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

function sendEmail(to, subject, text) {
  if (!resendApiKey) {
    return Promise.reject(new Error('Email is not configured. Add RESEND_API_KEY and RESET_FROM_EMAIL on Render.'));
  }
  const payload = JSON.stringify({
    from: resetFromEmail,
    to: [to],
    subject,
    text
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(data || 'Unable to send reset email.'));
          return;
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendResetEmail(to, code) {
  return sendEmail(
    to,
    'Jixels admin password reset code',
    `Your Jixels admin password reset code is ${code}. It expires in 10 minutes.`
  );
}

function workerClaimUrl(req, token) {
  const url = new URL('/', appBaseUrl(req));
  url.searchParams.set('claim', token);
  return url.href;
}

function sendWorkerApprovalEmail(req, card) {
  if (!card.email) return Promise.resolve(false);
  const link = workerClaimUrl(req, signQrPayload(card));
  return sendEmail(
    card.email,
    'Your Jixels ID card is ready',
    `Hello ${card.name},\n\nYour Jixels ID card has been approved and is ready.\n\nOpen this link to view, print, or download your ID card:\n${link}\n\nJixels Technologies Ltd`
  ).then(() => true);
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
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers.host || '').trim();
  const protocol = forwardedProtocol || (/onrender\.com$/i.test(host) ? 'https' : (process.env.HTTPS_KEY && process.env.HTTPS_CERT ? 'https' : 'http'));
  const requestBaseUrl = `${protocol}://${host}`;
  if (publicBaseUrl && !/mapphex-id-cards-portal/i.test(publicBaseUrl)) return publicBaseUrl;
  return requestBaseUrl;
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

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function qrSigningSecret() {
  return String(process.env.QR_SIGNING_SECRET || loadMasterConfig().token);
}

function signQrPayload(card) {
  if (!card?.verificationToken) return '';
  const payload = base64UrlEncode(JSON.stringify({
    token: card.verificationToken,
    id: card.id,
    issuedAt: new Date().toISOString()
  }));
  const signature = crypto
    .createHmac('sha256', qrSigningSecret())
    .update(payload)
    .digest('base64url');
  return `v1.${payload}.${signature}`;
}

function withQrToken(card) {
  if (!card) return card;
  return { ...card, qrToken: signQrPayload(card) };
}

function readQrPayload(value) {
  const token = String(value || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { verificationToken: token, signed: false };
  const [, payload, signature] = parts;
  const expected = crypto
    .createHmac('sha256', qrSigningSecret())
    .update(payload)
    .digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { verificationToken: '', signed: true, invalidSignature: true };
  }
  try {
    const data = JSON.parse(base64UrlDecode(payload));
    return { verificationToken: String(data.token || ''), cardId: String(data.id || ''), signed: true };
  } catch {
    return { verificationToken: '', signed: true, invalidSignature: true };
  }
}

function extractVerificationToken(value) {
  const text = String(value || '').trim();
  if (!text) return { verificationToken: '', signed: false };
  try {
    const parsed = new URL(text);
    const signed = parsed.searchParams.get('token') || parsed.searchParams.get('claim') || parsed.searchParams.get('q') || '';
    return readQrPayload(signed || text);
  } catch {
    const tokenMatch = text.match(/[?&](?:token|claim|q)=([^&]+)/);
    if (tokenMatch) return readQrPayload(decodeURIComponent(tokenMatch[1]));
    return readQrPayload(text);
  }
}

function shouldRotateVerificationToken(status) {
  return ['Inactive', 'Suspended', 'Lost'].includes(status);
}

function confirmAdminPassword(password) {
  const config = loadAdminConfig();
  return hashPassword(password || '', config.salt) === config.passwordHash;
}

function scanAction(value) {
  const action = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['sign-in', 'signin', 'in'].includes(action)) return 'sign-in';
  if (['sign-out', 'signout', 'out'].includes(action)) return 'sign-out';
  return '';
}

function scanMeta(payload = {}) {
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const locationAccuracy = Number(payload.locationAccuracy);
  return {
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    locationAccuracy: Number.isFinite(locationAccuracy) ? locationAccuracy : null,
    scanSource: String(payload.scanSource || 'card-scan').trim() || 'card-scan'
  };
}

function normalizeDeviceId(value) {
  return String(value || '').trim().slice(0, 120);
}

async function requireRegisteredScannerDevice(payload) {
  const deviceId = normalizeDeviceId(payload.deviceId);
  if (!deviceId) throw new Error('This phone is not registered for scanning.');
  const devices = await loadScannerDevices();
  const device = devices.find((item) => item.deviceId === deviceId && (item.status || 'Active') === 'Active');
  if (!device) throw new Error('This phone is not registered for scanning.');
  const session = readScannerSession(payload.scannerSession);
  if (!session || session.deviceId !== device.deviceId) throw new Error('Scanner password login is required.');
  return device;
}

function publicScannerDevice(device) {
  if (!device) return device;
  const { deviceSecret, passwordSalt, passwordHash, ...safeDevice } = device;
  return safeDevice;
}

function signScannerSession(device) {
  const payload = base64UrlEncode(JSON.stringify({
    scope: 'scanner',
    deviceId: device.deviceId,
    exp: Date.now() + 12 * 60 * 60 * 1000
  }));
  const signature = crypto
    .createHmac('sha256', qrSigningSecret())
    .update(payload)
    .digest('base64url');
  return `v1.${payload}.${signature}`;
}

function readScannerSession(value) {
  const token = String(value || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, signature] = parts;
  const expected = crypto
    .createHmac('sha256', qrSigningSecret())
    .update(payload)
    .digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const data = JSON.parse(base64UrlDecode(payload));
    if (data.scope !== 'scanner' || Date.now() > Number(data.exp || 0)) return null;
    return data;
  } catch {
    return null;
  }
}

function normalizePhoneNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  return digits;
}

function signScannerInvite(deviceName, phone, ownerName) {
  const scannerPhone = normalizePhoneNumber(phone);
  if (!scannerPhone) throw new Error('Scanner phone number is required.');
  const payload = base64UrlEncode(JSON.stringify({
    scope: 'scanner-invite',
    deviceName: String(deviceName || 'Scanner phone').trim() || 'Scanner phone',
    ownerName: String(ownerName || '').trim(),
    phone: scannerPhone,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    nonce: crypto.randomBytes(12).toString('hex')
  }));
  const signature = crypto
    .createHmac('sha256', qrSigningSecret())
    .update(payload)
    .digest('base64url');
  return `v1.${payload}.${signature}`;
}

function readScannerInvite(value) {
  const token = String(value || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, signature] = parts;
  const expected = crypto
    .createHmac('sha256', qrSigningSecret())
    .update(payload)
    .digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const data = JSON.parse(base64UrlDecode(payload));
    if (data.scope !== 'scanner-invite' || Date.now() > Number(data.exp || 0)) return null;
    return data;
  } catch {
    return null;
  }
}

function scannerInviteUrl(req, token) {
  const url = new URL('/scanner', appBaseUrl(req));
  url.searchParams.set('invite', token);
  return url.href;
}

function verifyScannerPassword(device, password) {
  return Boolean(device?.passwordSalt && device?.passwordHash) &&
    hashPassword(password || '', device.passwordSalt) === device.passwordHash;
}

function currentOpenAttendance(records, cardId) {
  return records
    .filter((record) => record.cardId === cardId && record.status === 'Signed In' && !record.signedOutAt)
    .sort((a, b) => String(b.signedInAt || '').localeCompare(String(a.signedInAt || '')))[0] || null;
}

async function recordAttendanceScan(card, action, payload = {}) {
  if ((card.status || 'Pending') !== 'Approved') {
    throw new Error('Only approved worker cards can sign in or sign out.');
  }
  const attendance = await loadAttendance();
  const now = new Date().toISOString();
  const meta = scanMeta(payload);
  const openRecord = currentOpenAttendance(attendance, card.id);

  if (action === 'sign-in') {
    if (openRecord) throw new Error(`${card.name} is already signed in.`);
    const record = {
      id: `ATT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      cardId: card.id,
      workerName: card.name,
      workerId: card.id,
      branch: card.branch || '',
      position: card.position || '',
      attendanceDate: now.slice(0, 10),
      signedInAt: now,
      signedOutAt: '',
      signInLatitude: meta.latitude,
      signInLongitude: meta.longitude,
      signOutLatitude: null,
      signOutLongitude: null,
      locationAccuracy: meta.locationAccuracy,
      scanSource: meta.scanSource,
      status: 'Signed In',
      createdAt: now,
      updatedAt: now
    };
    attendance.unshift(record);
    await saveAttendance(attendance);
    await appendAudit('worker-signed-in', card, 'card-scan');
    return record;
  }

  if (action === 'sign-out') {
    if (!openRecord) throw new Error(`${card.name} is not signed in.`);
    openRecord.signedOutAt = now;
    openRecord.signOutLatitude = meta.latitude;
    openRecord.signOutLongitude = meta.longitude;
    openRecord.locationAccuracy = meta.locationAccuracy;
    openRecord.scanSource = meta.scanSource;
    openRecord.status = 'Signed Out';
    openRecord.updatedAt = now;
    await saveAttendance(attendance);
    await appendAudit('worker-signed-out', card, 'card-scan');
    return openRecord;
  }

  throw new Error('Choose Sign In or Sign Out.');
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

async function scannerInviteUsed(nonce) {
  const audit = await loadAudit();
  return audit.some((entry) => entry.action === 'scanner-invite-used' && entry.cardId === nonce);
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
    nationalId: valid ? nationalId : '',
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
    sendJson(res, 200, {
      ok: true,
      storage: useSupabase ? 'supabase' : 'local-json',
      supabaseUrlOk: !supabaseUrl || /^https?:\/\/[^/]+\.supabase\.co/i.test(supabaseUrl)
    });
    return true;
  }

  if (url.pathname === '/api/master-link' && req.method === 'GET') {
    const masterUrl = new URL('/', appBaseUrl(req));
    masterUrl.searchParams.set('master', loadMasterConfig().token);
    masterUrl.hash = 'apply';
    sendJson(res, 200, { url: masterUrl.href });
    return true;
  }

  if (url.pathname === '/api/qr' && req.method === 'GET') {
    try {
      const data = String(url.searchParams.get('data') || '');
      if (!data) {
        sendJson(res, 400, { error: 'QR data is required.' });
        return true;
      }
      if (data.length > 2048) {
        sendJson(res, 400, { error: 'QR data is too long.' });
        return true;
      }
      const svg = await QRCode.toString(data, {
        type: 'svg',
        margin: Number(url.searchParams.get('margin') || 0),
        width: Number(url.searchParams.get('size') || 240),
        errorCorrectionLevel: 'M'
      });
      res.writeHead(200, securityHeaders({ 'Content-Type': 'image/svg+xml; charset=utf-8' }));
      res.end(svg);
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to generate QR.' });
    }
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

  if (url.pathname === '/api/forgot-password' && req.method === 'POST') {
    if (!checkRate(req, 'forgot-password', 5, 15 * 60_000)) {
      sendJson(res, 429, { error: 'Too many reset attempts. Try again later.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const config = loadAdminConfig();
      const email = String(payload.email || '').trim().toLowerCase();
      if (!config.email || email !== String(config.email).toLowerCase()) {
        sendJson(res, 404, { error: 'This email is not registered for admin password reset.' });
        return true;
      }
      const code = String(crypto.randomInt(100000, 1000000));
      resetCodes.set(email, {
        codeHash: hashPassword(code, config.salt),
        expiresAt: Date.now() + 10 * 60 * 1000
      });
      await sendResetEmail(email, code);
      sendJson(res, 200, { ok: true, message: 'Reset code sent to the registered admin email.' });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to send reset code.' });
    }
    return true;
  }

  if (url.pathname === '/api/reset-password' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const config = loadAdminConfig();
      const email = String(payload.email || '').trim().toLowerCase();
      const reset = resetCodes.get(email);
      if (!config.email || email !== String(config.email).toLowerCase() || !reset || Date.now() > reset.expiresAt) {
        sendJson(res, 400, { error: 'Invalid or expired reset code.' });
        return true;
      }
      if (hashPassword(String(payload.code || '').trim(), config.salt) !== reset.codeHash) {
        sendJson(res, 400, { error: 'Invalid or expired reset code.' });
        return true;
      }
      const password = String(payload.password || '');
      if (password.length < 10) {
        sendJson(res, 400, { error: 'Password must be at least 10 characters.' });
        return true;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      config.salt = salt;
      config.passwordHash = hashPassword(password, salt);
      saveAdminConfig(config);
      resetCodes.delete(email);
      await appendAudit('password-reset', { id: config.username }, config.username);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to reset password.' });
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
      config.email = String(payload.email || config.email || '').trim().toLowerCase();
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
      sendJson(res, 401, { error: loginRequiredMessage });
      return true;
    }
    sendJson(res, 200, { cards: (await loadCards()).map(withQrToken) });
    return true;
  }

  if (url.pathname === '/api/audit' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: loginRequiredMessage });
      return true;
    }
    sendJson(res, 200, { log: await loadAudit() });
    return true;
  }

  if (url.pathname === '/api/attendance' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: loginRequiredMessage });
      return true;
    }
    sendJson(res, 200, { attendance: await loadAttendance() });
    return true;
  }

  if (url.pathname === '/api/scanner-devices' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: loginRequiredMessage });
      return true;
    }
    try {
      sendJson(res, 200, { devices: (await loadScannerDevices()).map(publicScannerDevice) });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Unable to load scanner phones.' });
    }
    return true;
  }

  if (url.pathname === '/api/scanner-invite' && req.method === 'POST') {
    const admin = currentAdmin(req);
    if (!admin) {
      sendJson(res, 401, { error: loginRequiredMessage });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const phone = normalizePhoneNumber(payload.phone);
      if (!phone) {
        sendJson(res, 400, { error: 'Scanner phone number is required.' });
        return true;
      }
      const token = signScannerInvite(payload.deviceName, phone, payload.ownerName);
      const inviteUrl = scannerInviteUrl(req, token);
      await appendAudit('scanner-invite-created', { id: `${String(payload.ownerName || payload.deviceName || 'Scanner phone')}:${phone}` }, admin.username);
      sendJson(res, 200, { url: inviteUrl, token });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to create scanner setup link.' });
    }
    return true;
  }

  if (url.pathname === '/api/scanner-invite/accept' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const invite = readScannerInvite(payload.invite);
      if (!invite) {
        sendJson(res, 403, { error: 'Scanner setup link is invalid or expired. Ask admin for a new link.' });
        return true;
      }
      const scannerPhone = normalizePhoneNumber(payload.phone);
      if (!scannerPhone || scannerPhone !== invite.phone) {
        sendJson(res, 403, { error: 'This scanner setup link is only for the phone number admin registered.' });
        return true;
      }
      if (await scannerInviteUsed(invite.nonce)) {
        sendJson(res, 403, { error: 'This scanner setup link has already been used. Ask admin for a new link.' });
        return true;
      }
      const deviceId = normalizeDeviceId(payload.deviceId);
      if (!deviceId) {
        sendJson(res, 400, { error: 'Device ID is required.' });
        return true;
      }
      const scannerPassword = String(payload.scannerPassword || '').trim();
      if (scannerPassword.length < 4) {
        sendJson(res, 400, { error: 'Scanner password must be at least 4 characters.' });
        return true;
      }
      const devices = await loadScannerDevices();
      const existing = devices.find((item) => item.deviceId === deviceId);
      const now = new Date().toISOString();
      const passwordSalt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(scannerPassword, passwordSalt);
      const deviceName = String(payload.deviceName || invite.deviceName || 'Scanner phone').trim() || 'Scanner phone';
      const deviceOwner = String(payload.ownerName || invite.ownerName || '').trim();
      if (existing) {
        existing.deviceName = deviceName;
        existing.deviceOwner = deviceOwner;
        existing.devicePhone = scannerPhone;
        existing.deviceSecret = existing.deviceSecret || crypto.randomBytes(32).toString('hex');
        existing.passwordSalt = passwordSalt;
        existing.passwordHash = passwordHash;
        existing.status = 'Active';
        existing.updatedAt = now;
      } else {
        devices.unshift({
          id: `SCN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
          deviceId,
          deviceSecret: crypto.randomBytes(32).toString('hex'),
          passwordSalt,
          passwordHash,
          deviceName,
          deviceOwner,
          devicePhone: scannerPhone,
          registeredBy: 'scanner-invite',
          status: 'Active',
          createdAt: now,
          updatedAt: now
        });
      }
      await saveScannerDevices(devices);
      await appendAudit('scanner-phone-registered', { id: deviceId }, 'scanner-invite');
      await appendAudit('scanner-invite-used', { id: invite.nonce }, scannerPhone);
      const currentDevice = devices.find((item) => item.deviceId === deviceId);
      sendJson(res, 200, { device: publicScannerDevice(currentDevice), scannerSession: currentDevice ? signScannerSession(currentDevice) : '' });
    } catch (error) {
      if (error.code === 'PGRST204' && String(error.message || '').includes('password_hash')) {
        sendJson(res, 400, { error: 'Supabase scanner_devices table is missing password_hash. Run supabase-scanner-password-migration.sql in the Supabase SQL editor, then try again.' });
        return true;
      }
      sendJson(res, 400, { error: error.message || 'Unable to register scanner phone.' });
    }
    return true;
  }

  if (url.pathname === '/api/scanner-devices' && req.method === 'POST') {
    const admin = currentAdmin(req);
    if (!admin) {
      sendJson(res, 401, { error: loginRequiredMessage });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const deviceId = normalizeDeviceId(payload.deviceId);
      if (!deviceId) {
        sendJson(res, 400, { error: 'Device ID is required.' });
        return true;
      }
      const scannerPassword = String(payload.scannerPassword || '').trim();
      if (scannerPassword.length < 4) {
        sendJson(res, 400, { error: 'Scanner password must be at least 4 characters.' });
        return true;
      }
      const devices = await loadScannerDevices();
      const existing = devices.find((item) => item.deviceId === deviceId);
      const now = new Date().toISOString();
      const passwordSalt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(scannerPassword, passwordSalt);
      if (existing) {
        existing.deviceName = String(payload.deviceName || existing.deviceName || 'Scanner phone').trim();
        existing.deviceSecret = existing.deviceSecret || crypto.randomBytes(32).toString('hex');
        existing.passwordSalt = passwordSalt;
        existing.passwordHash = passwordHash;
        existing.status = 'Active';
        existing.updatedAt = now;
      } else {
        const deviceSecret = crypto.randomBytes(32).toString('hex');
        devices.unshift({
          id: `SCN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
          deviceId,
          deviceSecret,
          passwordSalt,
          passwordHash,
          deviceName: String(payload.deviceName || 'Scanner phone').trim(),
          registeredBy: admin.username,
          status: 'Active',
          createdAt: now,
          updatedAt: now
        });
      }
      await saveScannerDevices(devices);
      await appendAudit('scanner-phone-registered', { id: deviceId }, admin.username);
      const currentDevice = devices.find((item) => item.deviceId === deviceId);
      sendJson(res, 200, { devices: devices.map(publicScannerDevice), scannerSession: currentDevice ? signScannerSession(currentDevice) : '' });
    } catch (error) {
      if (error.code === 'PGRST204' && String(error.message || '').includes('password_hash')) {
        sendJson(res, 400, { error: 'Supabase scanner_devices table is missing password_hash. Run supabase-scanner-password-migration.sql in the Supabase SQL editor, then try again.' });
        return true;
      }
      sendJson(res, 400, { error: error.message || 'Unable to register scanner phone.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/scanner-devices/') && req.method === 'PATCH') {
    const admin = currentAdmin(req);
    if (!admin) {
      sendJson(res, 401, { error: loginRequiredMessage });
      return true;
    }
    try {
      const id = decodeURIComponent(url.pathname.replace('/api/scanner-devices/', ''));
      const payload = JSON.parse(await readBody(req));
      const devices = await loadScannerDevices();
      const device = devices.find((item) => item.id === id);
      if (!device) {
        sendJson(res, 404, { error: 'Scanner phone not found.' });
        return true;
      }
      device.status = payload.status === 'Disabled' ? 'Disabled' : 'Active';
      device.updatedAt = new Date().toISOString();
      await saveScannerDevices(devices);
      await appendAudit(`scanner-phone:${device.status}`, { id: device.deviceId }, admin.username);
      sendJson(res, 200, { device: publicScannerDevice(device), devices: devices.map(publicScannerDevice) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to update scanner phone.' });
    }
    return true;
  }

  if (url.pathname === '/api/scanner-login' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const deviceId = normalizeDeviceId(payload.deviceId);
      const devices = await loadScannerDevices();
      const device = devices.find((item) => item.deviceId === deviceId && (item.status || 'Active') === 'Active');
      if (!device || !verifyScannerPassword(device, payload.password)) {
        sendJson(res, 401, { error: 'Invalid scanner password or unregistered phone.' });
        return true;
      }
      sendJson(res, 200, { scannerSession: signScannerSession(device), device: publicScannerDevice(device) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to login scanner.' });
    }
    return true;
  }

  if (url.pathname === '/api/scanner-password' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const deviceId = normalizeDeviceId(payload.deviceId);
      const devices = await loadScannerDevices();
      const device = devices.find((item) => item.deviceId === deviceId && (item.status || 'Active') === 'Active');
      const session = readScannerSession(payload.scannerSession);
      if (!device || !session || session.deviceId !== device.deviceId) {
        sendJson(res, 401, { error: 'Scanner password login is required.' });
        return true;
      }
      if (!verifyScannerPassword(device, payload.currentPassword)) {
        sendJson(res, 403, { error: 'Current scanner password is incorrect.' });
        return true;
      }
      const nextPassword = String(payload.newPassword || '').trim();
      if (nextPassword.length < 4) {
        sendJson(res, 400, { error: 'New scanner password must be at least 4 characters.' });
        return true;
      }
      device.passwordSalt = crypto.randomBytes(16).toString('hex');
      device.passwordHash = hashPassword(nextPassword, device.passwordSalt);
      device.updatedAt = new Date().toISOString();
      await saveScannerDevices(devices);
      await appendAudit('scanner-password-changed', { id: device.deviceId }, device.deviceName || 'scanner');
      sendJson(res, 200, { ok: true, scannerSession: signScannerSession(device) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to change scanner password.' });
    }
    return true;
  }

  if (url.pathname === '/api/backup' && req.method === 'POST') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      if (!confirmAdminPassword(payload.currentPassword)) {
        sendJson(res, 403, { error: 'Current admin password is required.' });
        return true;
      }
      await appendAudit('backup-exported', { id: 'backup' }, admin.username);
      sendJson(res, 200, { cards: await loadCards(), audit: await loadAudit(), attendance: await loadAttendance(), scannerDevices: await loadScannerDevices(), exportedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid backup request.' });
    }
    return true;
  }

  if (url.pathname === '/api/backup' && req.method === 'GET') {
    sendJson(res, 405, { error: 'Use POST with current admin password to create a backup.' });
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
      if (!confirmAdminPassword(payload.currentPassword)) {
        sendJson(res, 403, { error: 'Current admin password is required.' });
        return true;
      }
      const backup = payload.backup || {};
      if (!Array.isArray(backup.cards)) {
        sendJson(res, 400, { error: 'Backup must include cards array.' });
        return true;
      }
      await saveCards(backup.cards);
      if (Array.isArray(backup.audit)) await saveAudit(backup.audit);
      if (Array.isArray(backup.attendance)) await saveAttendance(backup.attendance);
      if (Array.isArray(backup.scannerDevices)) await saveScannerDevices(backup.scannerDevices);
      await appendAudit('restored-backup', { id: 'backup' }, admin.username);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid backup.' });
    }
    return true;
  }

  if (url.pathname === '/api/verify' && req.method === 'GET') {
    const token = extractVerificationToken(url.searchParams.get('token'));
    const card = token.verificationToken
      ? (await loadCards()).find((item) => item.verificationToken === token.verificationToken && (!token.cardId || item.id === token.cardId))
      : null;
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
    await appendAudit(token.signed ? 'verified:signed-qr' : 'verified:legacy-token', card, 'public-scan');
    sendJson(res, 200, { card: publicCard(card) });
    return true;
  }

  if (url.pathname === '/api/scan' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const action = scanAction(payload.action);
      if (!action) {
        sendJson(res, 400, { error: 'Choose Sign In or Sign Out.' });
        return true;
      }
      const scannerDevice = await requireRegisteredScannerDevice(payload);
      const token = extractVerificationToken(payload.token);
      const card = token.verificationToken
        ? (await loadCards()).find((item) => item.verificationToken === token.verificationToken && (!token.cardId || item.id === token.cardId))
        : null;
      if (!card) {
        sendJson(res, 404, { error: 'Card token was not found.' });
        return true;
      }
      const scannerLabel = scannerDevice.deviceOwner || scannerDevice.deviceName || scannerDevice.devicePhone || 'registered-phone';
      const attendance = await recordAttendanceScan(card, action, { ...payload, scanSource: scannerLabel });
      sendJson(res, 200, {
        attendance,
        card: publicCard(card),
        message: action === 'sign-in' ? `${card.name} signed in.` : `${card.name} signed out.`
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to record scan.' });
    }
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
        email: String(payload.email || '').trim().toLowerCase(),
        position: String(payload.position || '').trim(),
        photo: String(payload.photo || ''),
        inactiveReason: '',
        status: isAdmin(req) ? String(payload.status || 'Pending').trim() || 'Pending' : 'Pending',
        createdAt: new Date().toISOString()
      };

      if (String(payload.masterToken || '') !== loadMasterConfig().token && !isAdmin(req)) {
        sendJson(res, 403, { error: 'Registration must come from the master card QR.' });
        return true;
      }

      if (!card.name || !card.location || !card.branch || !card.nationalId || !card.phone || !card.email || !card.position || !card.photo) {
        sendJson(res, 400, { error: 'All fields are required.' });
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(card.email)) {
        sendJson(res, 400, { error: 'Enter a valid email address.' });
        return true;
      }

      if (cards.some((item) => String(item.phone || '').trim() === card.phone)) {
        sendJson(res, 409, { error: 'This phone number is already registered.' });
        return true;
      }
      if (cards.some((item) => String(item.email || '').trim().toLowerCase() === card.email)) {
        sendJson(res, 409, { error: 'This email address is already registered.' });
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
      sendJson(res, 201, { card: withQrToken(card) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cards/') && req.method === 'PUT') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: loginRequiredMessage });
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

      const previousStatus = cards[index].status || 'Pending';
      cards[index] = {
        ...cards[index],
        name: String(payload.name || '').trim(),
        location: String(payload.location || '').trim(),
        branch: String(payload.branch || '').trim(),
        nationalId: String(payload.nationalId || '').trim(),
        phone: String(payload.phone || '').trim(),
        email: String(payload.email || '').trim().toLowerCase(),
        position: String(payload.position || '').trim(),
        status: String(payload.status || cards[index].status || 'Pending').trim() || 'Pending',
        inactiveReason: String(payload.inactiveReason || cards[index].inactiveReason || '').trim(),
        photo: payload.photo ? String(payload.photo) : cards[index].photo,
        updatedAt: new Date().toISOString()
      };
      if (cards[index].status !== previousStatus && shouldRotateVerificationToken(cards[index].status)) {
        cards[index].verificationToken = createVerificationToken();
      }

      if (!cards[index].name || !cards[index].location || !cards[index].branch || !cards[index].nationalId || !cards[index].phone || !cards[index].email || !cards[index].position || !cards[index].photo) {
        sendJson(res, 400, { error: 'Name, location, branch, National ID, phone, email, position, and picture are required.' });
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cards[index].email)) {
        sendJson(res, 400, { error: 'Enter a valid email address.' });
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
      if (cards.some((item, itemIndex) => itemIndex !== index && String(item.email || '').trim().toLowerCase() === cards[index].email)) {
        sendJson(res, 409, { error: 'This email address is already registered.' });
        return true;
      }

      await saveCards(cards);
      await appendAudit('edited', cards[index], 'admin');
      sendJson(res, 200, { card: withQrToken(cards[index]) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cards/') && url.pathname.endsWith('/status') && req.method === 'PATCH') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: loginRequiredMessage });
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
      const wasApproved = (card.status || 'Pending') === 'Approved';
      const previousStatus = card.status || 'Pending';
      card.status = status;
      card.inactiveReason = status === 'Inactive' ? String(payload.inactiveReason || payload.reason || card.inactiveReason || 'This worker is no longer active.').trim() : '';
      if (status !== previousStatus && shouldRotateVerificationToken(status)) {
        card.verificationToken = createVerificationToken();
      }
      if (status === 'Approved') {
        card.verificationToken = card.verificationToken || createVerificationToken();
        card.approvedAt = new Date().toISOString();
        card.approvedBy = currentAdmin(req)?.username || req.headers['x-admin-user'] || 'admin';
      }
      card.updatedAt = new Date().toISOString();
      await saveCards(cards);
      let emailSent = false;
      let emailError = '';
      if (status === 'Approved' && !wasApproved) {
        try {
          emailSent = await sendWorkerApprovalEmail(req, card);
          if (emailSent) await appendAudit('worker-email-sent', card, currentAdmin(req)?.username || 'admin');
        } catch (error) {
          emailError = error.message || 'Unable to send worker email.';
          await appendAudit('worker-email-failed', card, currentAdmin(req)?.username || 'admin');
        }
      }
      await appendAudit(`status:${status}`, card, req.headers['x-admin-user'] || 'admin');
      sendJson(res, 200, { card: withQrToken(card), emailSent, emailError });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid request.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cards/') && req.method === 'DELETE') {
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: loginRequiredMessage });
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
    card.verificationToken = createVerificationToken();
    card.updatedAt = new Date().toISOString();
    await saveCards(cards);
    await appendAudit('inactive-via-delete-request', card, currentAdmin(req)?.username || 'admin');
    sendJson(res, 200, { ok: true, card: withQrToken(card), message: 'Card marked inactive instead of deleted.' });
    return true;
  }

  return false;
}

const app = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleApi(req, res, url)) return;

  const requested = url.pathname === '/'
    ? '/index.html'
    : (url.pathname === '/admin' ? '/admin.html' : (url.pathname === '/scanner' ? '/scanner.html' : url.pathname));
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

function createServer() {
  return process.env.HTTPS_KEY && process.env.HTTPS_CERT
    ? https.createServer({
        key: fs.readFileSync(process.env.HTTPS_KEY),
        cert: fs.readFileSync(process.env.HTTPS_CERT)
      }, app)
    : http.createServer(app);
}

if (require.main === module) {
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    const protocol = process.env.HTTPS_KEY && process.env.HTTPS_CERT ? 'https' : 'http';
    console.log(`Jixels ID app running at ${protocol}://localhost:${port}`);
  });
}

module.exports = {
  app,
  createServer,
  extractVerificationToken,
  requireRegisteredScannerDevice,
  scanAction,
  signQrPayload,
  readQrPayload,
  shouldRotateVerificationToken
};
