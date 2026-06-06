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
const organizationsPath = path.join(root, 'organizations-db.json');
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
const resetFromEmail = String(process.env.RESET_FROM_EMAIL || 'MAPPHEX ID Cards <onboarding@resend.dev>').trim();
const showResetCodeWhenEmailDisabled = /^true$/i.test(String(process.env.SHOW_RESET_CODE_WHEN_EMAIL_DISABLED || '').trim());
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

function localLoadOrganizations() {
  if (!fs.existsSync(organizationsPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(organizationsPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function localSaveOrganizations(organizations) {
  fs.writeFileSync(organizationsPath, JSON.stringify(organizations, null, 2));
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
    organizationId: row.organization_id || '',
    organizationName: row.organization_name || '',
    cardType: row.card_type || 'user',
    roleType: row.role_type || '',
    fields: row.fields || {},
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
    organization_id: card.organizationId || null,
    organization_name: card.organizationName || null,
    card_type: card.cardType || 'user',
    role_type: card.roleType || null,
    fields: card.fields || {},
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

function fromSupabaseOrganization(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    businessNumber: row.business_number,
    email: row.email,
    phone: row.phone,
    logo: row.logo || '',
    brandColor: row.brand_color || '#357fbd',
    templateId: row.template_id || 'sample',
    ownerName: row.owner_name || '',
    salt: row.salt,
    passwordHash: row.password_hash,
    status: row.status,
    subscriptionStatus: row.subscription_status,
    backSettings: row.back_settings || {},
    masterCard: row.master_card || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || ''
  };
}

function toSupabaseOrganization(org) {
  return {
    id: org.id,
    name: org.name,
    type: org.type,
    business_number: org.businessNumber,
    email: org.email,
    phone: org.phone,
    logo: org.logo || '',
    brand_color: normalizeBrandColor(org.brandColor || '#357fbd'),
    template_id: org.templateId || 'sample',
    owner_name: org.ownerName || '',
    salt: org.salt,
    password_hash: org.passwordHash,
    status: org.status || 'Pending',
    subscription_status: org.subscriptionStatus || 'Pending',
    back_settings: org.backSettings || {},
    master_card: org.masterCard || null,
    created_at: org.createdAt,
    updated_at: org.updatedAt || null
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

async function loadOrganizations() {
  if (!useSupabase) return localLoadOrganizations();
  const rows = await supabaseRequest('GET', 'organizations', '?select=*&order=created_at.asc');
  return rows.map(fromSupabaseOrganization);
}

async function saveOrganizations(organizations) {
  if (!useSupabase) {
    localSaveOrganizations(organizations);
    return;
  }
  await supabaseRequest('DELETE', 'organizations', '?id=not.is.null');
  if (organizations.length) await supabaseRequest('POST', 'organizations', '', organizations.map(toSupabaseOrganization));
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
    'MAPPHEX admin password reset code',
    `Your MAPPHEX admin password reset code is ${code}. It expires in 10 minutes.`
  );
}

function workerClaimUrl(req, token) {
  const url = new URL('/', appBaseUrl(req));
  url.searchParams.set('claim', token);
  return url.href;
}

function sendWorkerApprovalEmail(req, card) {
  if (!card.email) return Promise.resolve(false);
  const link = workerClaimUrl(req, card.verificationToken);
  const issuer = String(card.organizationName || 'MAPPHEX').trim() || 'MAPPHEX';
  return sendEmail(
    card.email,
    `Your ${issuer} ID card is ready`,
    `Hello ${card.name},\n\nYour ${issuer} ID card has been approved and is ready.\n\nOpen this link to view, print, or download your ID card:\n${link}\n\n${issuer}`
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

const cardTemplates = [
  { id: 'sample', name: 'MAPPHEX sample', description: 'Current blue and gold sample card kept as Template 1.' },
  { id: 'classic', name: 'Classic staff', description: 'Clean corporate staff card.' },
  { id: 'school', name: 'School front', description: 'Student and teacher focused fields.' },
  { id: 'university', name: 'University front', description: 'Faculty, department, and level layout.' },
  { id: 'secure', name: 'Security badge', description: 'Role, branch, and verification focused.' }
];

const organizationTypeRules = {
  company: {
    label: 'Company',
    roles: {
      worker: {
        label: 'Worker',
        idField: 'staffId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'staffId', 'position', 'department', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'staffId']
      }
    }
  },
  school: {
    label: 'School',
    roles: {
      student: {
        label: 'Student',
        idField: 'admissionNumber',
        required: ['fullName', 'admissionNumber', 'className', 'academicYear', 'guardianPhone', 'dateOfBirth', 'photo'],
        duplicateFields: ['admissionNumber'],
        compoundDuplicate: ['guardianPhone', 'dateOfBirth']
      },
      teacher: {
        label: 'Teacher/Staff',
        idField: 'staffId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'staffId', 'position', 'subjectOrDepartment', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'staffId']
      }
    }
  },
  university: {
    label: 'University',
    roles: {
      student: {
        label: 'Student',
        idField: 'studentNumber',
        required: ['fullName', 'studentNumber', 'faculty', 'department', 'level', 'program', 'email', 'phone', 'photo'],
        duplicateFields: ['studentNumber', 'email', 'phone'],
        optional: ['nationalId']
      },
      lecturer: {
        label: 'Lecturer/Staff',
        idField: 'staffId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'staffId', 'title', 'faculty', 'department', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'staffId']
      }
    }
  },
  hospital: {
    label: 'Hospital',
    roles: {
      staff: {
        label: 'Staff',
        idField: 'staffId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'staffId', 'position', 'department', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'staffId']
      }
    }
  },
  ngo: {
    label: 'NGO/Church',
    roles: {
      member: {
        label: 'Member/Worker',
        idField: 'memberId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'memberId', 'position', 'unit', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'memberId']
      }
    }
  },
  security: {
    label: 'Security Agency',
    roles: {
      officer: {
        label: 'Officer',
        idField: 'staffId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'staffId', 'position', 'branch', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'staffId']
      }
    }
  },
  government: {
    label: 'Government Office',
    roles: {
      staff: {
        label: 'Staff',
        idField: 'staffId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'staffId', 'position', 'department', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'staffId']
      }
    }
  },
  custom: {
    label: 'Custom Organization',
    roles: {
      member: {
        label: 'Member',
        idField: 'memberId',
        required: ['fullName', 'email', 'phone', 'nationalId', 'memberId', 'position', 'photo'],
        duplicateFields: ['email', 'phone', 'nationalId', 'memberId']
      }
    }
  }
};

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBrandColor(value) {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
  }
  return '#357fbd';
}

function defaultBackSettings(org) {
  const name = String(org?.name || 'Organization').trim() || 'Organization';
  const phone = String(org?.phone || '').trim();
  const type = String(org?.type || '').trim();
  const returnDesk = type === 'school' ? 'School Administration Office' :
    type === 'university' ? 'Registrar or Student Affairs Office' :
    'HR Department';
  return {
    returnTitle: 'If found please return to:',
    returnName: name,
    addressLine1: '',
    addressLine2: '',
    phone,
    returnDesk,
    responsibilityTitle: 'Cardholder Responsibilities:',
    rule1: `This ID card is the property of ${name}.`,
    rule2: 'Use of this card is strictly for the person to whom it is issued.',
    rule3: type === 'school' || type === 'university'
      ? 'Must be displayed while on school/university premises.'
      : 'Must be displayed at all times while on company premises.',
    lostInstruction: `Report lost/stolen cards immediately to ${returnDesk}.`
  };
}

function cleanBackSettings(input, org) {
  const defaults = defaultBackSettings(org);
  const cleaned = {};
  for (const key of Object.keys(defaults)) {
    const value = String(input?.[key] ?? defaults[key]).trim();
    cleaned[key] = value.slice(0, key.startsWith('rule') || key === 'lostInstruction' ? 140 : 80);
  }
  return cleaned;
}

function publicOrganization(org) {
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    type: org.type,
    typeLabel: organizationTypeRules[org.type]?.label || org.type,
    businessNumber: org.businessNumber,
    email: org.email,
    phone: org.phone,
    logo: org.logo || '',
    brandColor: normalizeBrandColor(org.brandColor || '#357fbd'),
    templateId: org.templateId || 'sample',
    backSettings: cleanBackSettings(org.backSettings || {}, org),
    subscriptionStatus: org.subscriptionStatus || 'Pending',
    status: org.status || 'Pending',
    masterCard: org.masterCard ? {
      number: org.masterCard.number,
      status: org.masterCard.status,
      issuedAt: org.masterCard.issuedAt
    } : null,
    createdAt: org.createdAt
  };
}

function organizationIsActive(org) {
  return Boolean(org && (org.status || 'Pending') === 'Active' && ['Active', 'Trial'].includes(org.subscriptionStatus || 'Pending'));
}

function requireActiveOrganization(res, org) {
  if (organizationIsActive(org)) return true;
  sendJson(res, 402, {
    error: 'Subscription inactive. Renew subscription to access this organization admin panel.',
    locked: true,
    organization: publicOrganization(org)
  });
  return false;
}

async function currentOrganization(req) {
  const session = currentAdmin(req);
  if (!session || session.role !== 'organization-admin' || !session.organizationId) return null;
  return (await loadOrganizations()).find((org) => org.id === session.organizationId) || null;
}

function getTypeRule(type, role) {
  const typeRule = organizationTypeRules[type] || organizationTypeRules.custom;
  const roleRule = typeRule.roles[role] || Object.values(typeRule.roles)[0];
  return { typeRule, roleRule };
}

function validateProfileFields(org, role, fields) {
  const { roleRule } = getTypeRule(org.type, role);
  const missing = roleRule.required.filter((key) => !String(fields[key] || '').trim());
  if (missing.length) return `Missing required field(s): ${missing.join(', ')}.`;
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(fields.email).trim())) return 'Enter a valid email address.';
  return '';
}

function createOrganizationId(organizations, name) {
  const base = String(name || 'ORG').replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'ORG';
  const existing = new Set(organizations.map((org) => org.id));
  let sequence = organizations.length + 1;
  let id = '';
  do {
    id = `${base}-${String(sequence).padStart(4, '0')}`;
    sequence += 1;
  } while (existing.has(id));
  return id;
}

function createScopedCardId(cards, org, role, fields) {
  const { roleRule } = getTypeRule(org.type, role);
  const provided = String(fields[roleRule.idField] || '').trim();
  if (provided) return provided;
  const prefix = `${String(org.name || 'ORG').replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'ORG'}/${String(role || 'USR').slice(0, 3).toUpperCase()}`;
  const orgCards = cards.filter((card) => card.organizationId === org.id);
  const existing = new Set(orgCards.map((card) => card.id));
  let sequence = orgCards.length + 1;
  let id = '';
  do {
    id = `${prefix}/${String(sequence).padStart(3, '0')}`;
    sequence += 1;
  } while (existing.has(id));
  return id;
}

function duplicateRegistrationError(cards, org, role, fields, ignoreCardId = '') {
  const { roleRule } = getTypeRule(org.type, role);
  const orgCards = cards.filter((card) => card.organizationId === org.id && card.id !== ignoreCardId);
  for (const field of roleRule.duplicateFields || []) {
    const value = normalizeKey(fields[field]);
    if (!value) continue;
    if (orgCards.some((card) => normalizeKey(card.fields?.[field]) === value)) {
      return `${field} is already registered in this organization.`;
    }
  }
  if (roleRule.compoundDuplicate?.length) {
    const values = roleRule.compoundDuplicate.map((field) => normalizeKey(fields[field]));
    if (values.every(Boolean) && orgCards.some((card) => roleRule.compoundDuplicate.every((field, index) => normalizeKey(card.fields?.[field]) === values[index]))) {
      return `${roleRule.compoundDuplicate.join(' + ')} already matches another registration in this organization.`;
    }
  }
  return '';
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

async function publicCard(card) {
  if (!card) return null;
  const org = card.organizationId ? (await loadOrganizations()).find((item) => item.id === card.organizationId) : null;
  if (org && !organizationIsActive(org)) {
    return {
      id: card.id,
      name: 'Subscription Inactive',
      organization: publicOrganization(org),
      status: org.subscriptionStatus || 'Inactive',
      valid: false,
      validity: 'Not Valid',
      invalidReason: 'This organization subscription is inactive. Please contact the organization administrator.',
      verifiedAt: new Date().toISOString()
    };
  }
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
    organization: org ? publicOrganization(org) : null,
    cardType: card.cardType || 'user',
    roleType: card.roleType || '',
    fields: card.fields || {},
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

  if (url.pathname === '/api/templates' && req.method === 'GET') {
    sendJson(res, 200, { templates: cardTemplates, organizationTypes: organizationTypeRules });
    return true;
  }

  if (url.pathname === '/api/organizations/register' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const organizations = await loadOrganizations();
      const email = String(payload.email || '').trim().toLowerCase();
      const businessNumber = String(payload.businessNumber || '').trim();
      const password = String(payload.password || '');
      const type = organizationTypeRules[payload.type] ? payload.type : 'custom';
      const templateId = cardTemplates.some((template) => template.id === payload.templateId) ? payload.templateId : 'sample';
      if (!String(payload.name || '').trim() || !businessNumber || !email || !String(payload.phone || '').trim() || !password) {
        sendJson(res, 400, { error: 'Organization name, business number, email, phone, and password are required.' });
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 400, { error: 'Enter a valid organization email address.' });
        return true;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: 'Organization admin password must be at least 8 characters.' });
        return true;
      }
      if (organizations.some((org) => normalizeKey(org.email) === email)) {
        sendJson(res, 409, { error: 'This organization email is already registered.' });
        return true;
      }
      if (organizations.some((org) => normalizeKey(org.businessNumber) === normalizeKey(businessNumber))) {
        sendJson(res, 409, { error: 'This business/registration number is already registered.' });
        return true;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const id = createOrganizationId(organizations, payload.name);
      const org = {
        id,
        name: String(payload.name || '').trim(),
        type,
        businessNumber,
        email,
        phone: String(payload.phone || '').trim(),
        logo: String(payload.logo || ''),
        brandColor: normalizeBrandColor(payload.brandColor),
        templateId,
        ownerName: String(payload.ownerName || '').trim(),
        salt,
        passwordHash: hashPassword(password, salt),
        status: 'Pending',
        subscriptionStatus: 'Pending',
        backSettings: cleanBackSettings(payload.backSettings || {}, {
          name: String(payload.name || '').trim(),
          type,
          phone: String(payload.phone || '').trim()
        }),
        masterCard: {
          number: `${id}/MASTER`,
          token: createVerificationToken(),
          status: 'Active',
          issuedAt: new Date().toISOString(),
          replacedAt: ''
        },
        createdAt: new Date().toISOString(),
        updatedAt: ''
      };
      organizations.push(org);
      await saveOrganizations(organizations);
      await appendAudit('organization-registered', { id: org.id }, 'public');
      sendJson(res, 201, { organization: publicOrganization(org), message: 'Organization registered. Super admin must activate subscription before the admin panel and QR codes work.' });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid organization registration.' });
    }
    return true;
  }

  if (url.pathname === '/api/org-login' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const email = String(payload.email || '').trim().toLowerCase();
      const org = (await loadOrganizations()).find((item) => normalizeKey(item.email) === email);
      if (!org || hashPassword(payload.password || '', org.salt) !== org.passwordHash) {
        sendJson(res, 401, { error: 'Invalid organization email or password.' });
        return true;
      }
      const token = crypto.randomBytes(24).toString('hex');
      const session = {
        username: org.email,
        role: 'organization-admin',
        organizationId: org.id,
        expiresAt: Date.now() + 8 * 60 * 60 * 1000
      };
      sessions.set(token, session);
      sendJson(res, 200, { token, role: session.role, organization: publicOrganization(org), locked: !organizationIsActive(org), rules: organizationTypeRules[org.type] || organizationTypeRules.custom, templates: cardTemplates, expiresAt: session.expiresAt });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to login organization.' });
    }
    return true;
  }

  if (url.pathname === '/api/org/me' && req.method === 'GET') {
    const org = await currentOrganization(req);
    if (!org) {
      sendJson(res, 401, { error: 'Please log in again as organization admin.' });
      return true;
    }
    sendJson(res, 200, { organization: publicOrganization(org), locked: !organizationIsActive(org), rules: organizationTypeRules[org.type] || organizationTypeRules.custom, templates: cardTemplates });
    return true;
  }

  if (url.pathname === '/api/org/back-settings' && req.method === 'PATCH') {
    const sessionOrg = await currentOrganization(req);
    if (!sessionOrg) {
      sendJson(res, 401, { error: 'Please log in again as organization admin.' });
      return true;
    }
    if (!requireActiveOrganization(res, sessionOrg)) return true;
    try {
      const payload = JSON.parse(await readBody(req));
      const organizations = await loadOrganizations();
      const org = organizations.find((item) => item.id === sessionOrg.id);
      if (!org) {
        sendJson(res, 404, { error: 'Organization not found.' });
        return true;
      }
      org.backSettings = cleanBackSettings(payload.backSettings || payload || {}, org);
      org.updatedAt = new Date().toISOString();
      await saveOrganizations(organizations);
      await appendAudit('organization-back-settings-updated', { id: org.id }, org.email);
      sendJson(res, 200, { organization: publicOrganization(org) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to update back card settings.' });
    }
    return true;
  }

  if (url.pathname === '/api/org/branding' && req.method === 'PATCH') {
    const sessionOrg = await currentOrganization(req);
    if (!sessionOrg) {
      sendJson(res, 401, { error: 'Please log in again as organization admin.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const logo = String(payload.logo || '').trim();
      const brandColor = normalizeBrandColor(payload.brandColor || sessionOrg.brandColor);
      const templateId = cardTemplates.some((template) => template.id === payload.templateId) ? payload.templateId : (sessionOrg.templateId || 'sample');
      if (logo && !/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(logo) && !/^https?:\/\//i.test(logo)) {
        sendJson(res, 400, { error: 'Logo must be an uploaded image data URL or a valid image URL.' });
        return true;
      }
      if (logo.length > 2_500_000) {
        sendJson(res, 413, { error: 'Logo is too large. Upload a smaller image.' });
        return true;
      }
      const organizations = await loadOrganizations();
      const org = organizations.find((item) => item.id === sessionOrg.id);
      if (!org) {
        sendJson(res, 404, { error: 'Organization not found.' });
        return true;
      }
      org.logo = logo;
      org.brandColor = brandColor;
      org.templateId = templateId;
      org.updatedAt = new Date().toISOString();
      await saveOrganizations(organizations);
      await appendAudit('organization-branding-updated', { id: org.id }, org.email);
      sendJson(res, 200, { organization: publicOrganization(org), templates: cardTemplates });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to update branding.' });
    }
    return true;
  }

  if (url.pathname === '/api/organizations/sample-client' && req.method === 'POST') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const name = String(payload.name || 'Sample Client Organization').trim();
      const email = String(payload.email || '').trim().toLowerCase();
      const phone = String(payload.phone || '').trim();
      const password = String(payload.password || '');
      const businessNumber = String(payload.businessNumber || 'SAMPLE-CLIENT').trim();
      if (!name || !email || !phone || !password) {
        sendJson(res, 400, { error: 'Sample client name, email, phone, and password are required.' });
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 400, { error: 'Enter a valid sample client email address.' });
        return true;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: 'Sample client password must be at least 8 characters.' });
        return true;
      }
      const organizations = await loadOrganizations();
      let org = organizations.find((item) =>
        normalizeKey(item.email) === email ||
        normalizeKey(item.businessNumber) === normalizeKey(businessNumber)
      );
      const now = new Date().toISOString();
      if (org) {
        org.name = name;
        org.type = 'company';
        org.email = email;
        org.phone = phone;
        org.businessNumber = businessNumber;
        org.logo = String(payload.logo || org.logo || '');
        org.brandColor = normalizeBrandColor(payload.brandColor || org.brandColor || '#357fbd');
        org.templateId = cardTemplates.some((template) => template.id === payload.templateId) ? payload.templateId : (org.templateId || 'sample');
        org.status = 'Active';
        org.subscriptionStatus = 'Active';
        org.ownerName = String(payload.ownerName || org.ownerName || 'Sample Admin').trim();
        org.backSettings = cleanBackSettings(org.backSettings || {}, org);
        if (!org.masterCard?.token) {
          org.masterCard = {
            number: `${org.id}/MASTER`,
            token: createVerificationToken(),
            status: 'Active',
            issuedAt: now,
            replacedAt: ''
          };
        }
        if (payload.password) {
          org.salt = crypto.randomBytes(16).toString('hex');
          org.passwordHash = hashPassword(password, org.salt);
        }
        org.updatedAt = now;
        await saveOrganizations(organizations);
        await appendAudit('sample-client-updated', { id: org.id }, admin.username);
        sendJson(res, 200, { organization: publicOrganization(org), message: 'Sample client is active.' });
        return true;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const id = createOrganizationId(organizations, name);
      org = {
        id,
        name,
        type: 'company',
        businessNumber,
        email,
        phone,
        logo: String(payload.logo || ''),
        brandColor: normalizeBrandColor(payload.brandColor || '#357fbd'),
        templateId: cardTemplates.some((template) => template.id === payload.templateId) ? payload.templateId : 'sample',
        ownerName: String(payload.ownerName || 'Sample Admin').trim(),
        salt,
        passwordHash: hashPassword(password, salt),
        status: 'Active',
        subscriptionStatus: 'Active',
        backSettings: cleanBackSettings(payload.backSettings || {}, {
          name,
          type: 'company',
          phone
        }),
        masterCard: {
          number: `${id}/MASTER`,
          token: createVerificationToken(),
          status: 'Active',
          issuedAt: now,
          replacedAt: ''
        },
        createdAt: now,
        updatedAt: ''
      };
      organizations.push(org);
      await saveOrganizations(organizations);
      await appendAudit('sample-client-created', { id: org.id }, admin.username);
      sendJson(res, 201, { organization: publicOrganization(org), message: 'Sample client is active.' });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to create sample client.' });
    }
    return true;
  }

  if (url.pathname === '/api/organizations' && req.method === 'GET') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    sendJson(res, 200, { organizations: (await loadOrganizations()).map(publicOrganization) });
    return true;
  }

  if (url.pathname === '/api/organizations' && req.method === 'DELETE') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      if (String(payload.confirm || '') !== 'DELETE ORGANIZATIONS') {
        sendJson(res, 400, { error: 'Type DELETE ORGANIZATIONS to confirm.' });
        return true;
      }
      const organizations = await loadOrganizations();
      const cards = await loadCards();
      const remainingCards = cards.filter((card) => !card.organizationId);
      await saveOrganizations([]);
      await saveCards(remainingCards);
      await appendAudit('deleted-all-organization-accounts', { id: 'organizations' }, admin.username);
      sendJson(res, 200, {
        ok: true,
        deletedOrganizations: organizations.length,
        deletedOrganizationCards: cards.length - remainingCards.length
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to delete organization accounts.' });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/organizations/') && url.pathname.endsWith('/subscription') && req.method === 'PATCH') {
    const admin = currentAdmin(req);
    if (!admin || admin.role !== 'super-admin') {
      sendJson(res, 403, { error: 'Super admin required.' });
      return true;
    }
    try {
      const id = decodeURIComponent(url.pathname.replace('/api/organizations/', '').replace('/subscription', ''));
      const payload = JSON.parse(await readBody(req));
      const organizations = await loadOrganizations();
      const org = organizations.find((item) => item.id === id);
      if (!org) {
        sendJson(res, 404, { error: 'Organization not found.' });
        return true;
      }
      const subscriptionStatus = String(payload.subscriptionStatus || org.subscriptionStatus || 'Pending').trim();
      const status = String(payload.status || org.status || 'Pending').trim();
      if (!['Active', 'Trial', 'Expired', 'Pending', 'Cancelled', 'Suspended'].includes(subscriptionStatus)) {
        sendJson(res, 400, { error: 'Invalid subscription status.' });
        return true;
      }
      if (!['Active', 'Pending', 'Suspended'].includes(status)) {
        sendJson(res, 400, { error: 'Invalid organization status.' });
        return true;
      }
      org.subscriptionStatus = subscriptionStatus;
      org.status = status;
      org.updatedAt = new Date().toISOString();
      await saveOrganizations(organizations);
      await appendAudit(`organization-subscription:${subscriptionStatus}`, { id: org.id }, admin.username);
      sendJson(res, 200, { organization: publicOrganization(org) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to update subscription.' });
    }
    return true;
  }

  if (url.pathname === '/api/org/master-card' && req.method === 'GET') {
    const org = await currentOrganization(req);
    if (!org) {
      sendJson(res, 401, { error: 'Please log in again as organization admin.' });
      return true;
    }
    if (!requireActiveOrganization(res, org)) return true;
    const registrationUrl = new URL('/portal.html', appBaseUrl(req));
    registrationUrl.searchParams.set('master', org.masterCard.token);
    sendJson(res, 200, {
      masterCard: {
        cardType: 'MASTER CARD',
        organization: publicOrganization(org),
        number: org.masterCard.number,
        token: org.masterCard.token,
        qrUrl: registrationUrl.href
      }
    });
    return true;
  }

  if (url.pathname === '/api/org/register-info' && req.method === 'GET') {
    const token = String(url.searchParams.get('token') || '');
    const org = (await loadOrganizations()).find((item) => item.masterCard?.token === token && item.masterCard?.status === 'Active');
    if (!org) {
      sendJson(res, 404, { error: 'Master card not found or inactive.' });
      return true;
    }
    if (!organizationIsActive(org)) {
      sendJson(res, 402, { error: 'This organization subscription is inactive. Registration is closed.', locked: true, organization: publicOrganization(org) });
      return true;
    }
    sendJson(res, 200, { organization: publicOrganization(org), rules: organizationTypeRules[org.type] || organizationTypeRules.custom, templates: cardTemplates });
    return true;
  }

  if (url.pathname === '/api/org/apply' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const organizations = await loadOrganizations();
      const org = organizations.find((item) => item.masterCard?.token === String(payload.masterToken || '') && item.masterCard?.status === 'Active');
      if (!org) {
        sendJson(res, 404, { error: 'Master card not found or inactive.' });
        return true;
      }
      if (!organizationIsActive(org)) {
        sendJson(res, 402, { error: 'This organization subscription is inactive. Registration is closed.', locked: true });
        return true;
      }
      const roleType = String(payload.roleType || '').trim();
      const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
      const validationError = validateProfileFields(org, roleType, fields);
      if (validationError) {
        sendJson(res, 400, { error: validationError });
        return true;
      }
      const cards = await loadCards();
      const duplicateError = duplicateRegistrationError(cards, org, roleType, fields);
      if (duplicateError) {
        sendJson(res, 409, { error: duplicateError });
        return true;
      }
      const card = {
        id: createScopedCardId(cards, org, roleType, fields),
        organizationId: org.id,
        organizationName: org.name,
        cardType: 'user',
        roleType,
        fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value || '').trim()])),
        name: String(fields.fullName || '').trim(),
        location: String(fields.location || fields.className || fields.faculty || '').trim(),
        branch: String(fields.branch || fields.department || fields.subjectOrDepartment || fields.unit || '').trim(),
        nationalId: String(fields.nationalId || '').trim(),
        phone: String(fields.phone || fields.guardianPhone || '').trim(),
        email: String(fields.email || '').trim().toLowerCase(),
        position: String(fields.position || fields.title || roleType || '').trim(),
        photo: String(fields.photo || ''),
        verificationToken: createVerificationToken(),
        inactiveReason: '',
        status: 'Pending',
        createdAt: new Date().toISOString()
      };
      cards.push(card);
      await saveCards(cards);
      await appendAudit('organization-user-applied', card, 'master-qr');
      sendJson(res, 201, { card, message: 'Registration received. Organization admin must approve before the ID card is valid.' });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid registration.' });
    }
    return true;
  }

  if (url.pathname === '/api/org/cards' && req.method === 'GET') {
    const org = await currentOrganization(req);
    if (!org) {
      sendJson(res, 401, { error: 'Please log in again as organization admin.' });
      return true;
    }
    if (!requireActiveOrganization(res, org)) return true;
    const cards = (await loadCards()).filter((card) => card.organizationId === org.id);
    sendJson(res, 200, { cards });
    return true;
  }

  if (url.pathname.startsWith('/api/org/cards/') && url.pathname.endsWith('/status') && req.method === 'PATCH') {
    const org = await currentOrganization(req);
    if (!org) {
      sendJson(res, 401, { error: 'Please log in again as organization admin.' });
      return true;
    }
    if (!requireActiveOrganization(res, org)) return true;
    try {
      const id = decodeURIComponent(url.pathname.replace('/api/org/cards/', '').replace('/status', ''));
      const payload = JSON.parse(await readBody(req));
      const status = String(payload.status || '').trim();
      if (!['Pending', 'Approved', 'Rejected', 'Suspended', 'Lost', 'Inactive'].includes(status)) {
        sendJson(res, 400, { error: 'Invalid status.' });
        return true;
      }
      const cards = await loadCards();
      const card = cards.find((item) => item.id === id && item.organizationId === org.id);
      if (!card) {
        sendJson(res, 404, { error: 'Card not found in this organization.' });
        return true;
      }
      card.status = status;
      card.inactiveReason = status === 'Inactive' ? String(payload.reason || payload.inactiveReason || 'This card is inactive.').trim() : '';
      if (status === 'Approved') {
        card.approvedAt = new Date().toISOString();
        card.approvedBy = org.email;
      }
      card.updatedAt = new Date().toISOString();
      await saveCards(cards);
      await appendAudit(`organization-card-status:${status}`, card, org.email);
      sendJson(res, 200, { card });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Unable to update card status.' });
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
      if (!resendApiKey && showResetCodeWhenEmailDisabled) {
        sendJson(res, 200, { ok: true, message: `Email is not configured. Use reset code ${code}. It expires in 10 minutes.` });
        return true;
      }
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
    sendJson(res, 200, { cards: await loadCards() });
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
    const masterOrg = (await loadOrganizations()).find((item) => item.masterCard?.token === token);
    if (masterOrg) {
      const active = organizationIsActive(masterOrg) && masterOrg.masterCard?.status === 'Active';
      sendJson(res, 200, {
        card: {
          id: masterOrg.masterCard.number,
          name: masterOrg.name,
          organization: publicOrganization(masterOrg),
          cardType: 'master',
          position: 'MASTER CARD',
          branch: masterOrg.type,
          status: active ? 'Active' : (masterOrg.subscriptionStatus || 'Inactive'),
          valid: active,
          validity: active ? 'Valid Master Card' : 'Not Valid',
          invalidReason: active ? '' : 'This master card or organization subscription is inactive.',
          registrationOpen: active,
          verifiedAt: new Date().toISOString()
        }
      });
      return true;
    }
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
    sendJson(res, 200, { card: await publicCard(card) });
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
      sendJson(res, 201, { card });
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
      sendJson(res, 200, { card: cards[index] });
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
      card.status = status;
      card.inactiveReason = status === 'Inactive' ? String(payload.inactiveReason || payload.reason || card.inactiveReason || 'This worker is no longer active.').trim() : '';
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
      sendJson(res, 200, { card, emailSent, emailError });
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

  const requested = url.pathname === '/' ? '/index.html' :
    (url.pathname === '/admin' ? '/admin.html' :
    (url.pathname === '/super-admin' ? '/super-admin.html' : url.pathname));
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
  console.log(`MAPPHEX ID app running at ${protocol}://localhost:${port}`);
});
