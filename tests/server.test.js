const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const {
  createServer,
  extractVerificationToken,
  readQrPayload,
  requireRegisteredScannerDevice,
  scanAction,
  signQrPayload,
  shouldRotateVerificationToken
} = require('../server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('signed QR payloads resolve to the original verification token', () => {
  const qrToken = signQrPayload({ id: 'JIX/DEV/001', verificationToken: 'plain-secret-token' });
  const parsed = readQrPayload(qrToken);

  assert.equal(parsed.signed, true);
  assert.equal(parsed.cardId, 'JIX/DEV/001');
  assert.equal(parsed.verificationToken, 'plain-secret-token');
});

test('tampered signed QR payloads are rejected', () => {
  const qrToken = signQrPayload({ id: 'JIX/DEV/001', verificationToken: 'plain-secret-token' });
  const tampered = qrToken.replace(/.$/, qrToken.endsWith('a') ? 'b' : 'a');
  const parsed = readQrPayload(tampered);

  assert.equal(parsed.signed, true);
  assert.equal(parsed.invalidSignature, true);
  assert.equal(parsed.verificationToken, '');
});

test('signed QR URLs can be parsed from scanned card links', () => {
  const qrToken = signQrPayload({ id: 'JIX/DEV/001', verificationToken: 'plain-secret-token' });
  const parsed = extractVerificationToken(`https://example.test/?token=${encodeURIComponent(qrToken)}`);

  assert.equal(parsed.signed, true);
  assert.equal(parsed.cardId, 'JIX/DEV/001');
  assert.equal(parsed.verificationToken, 'plain-secret-token');
});

test('scan actions use company sign in and sign out wording', () => {
  assert.equal(scanAction('sign-in'), 'sign-in');
  assert.equal(scanAction('signin'), 'sign-in');
  assert.equal(scanAction('sign-out'), 'sign-out');
  assert.equal(scanAction('signout'), 'sign-out');
  assert.equal(scanAction('enter'), '');
  assert.equal(scanAction('leave'), '');
});

test('inactive, suspended, and lost statuses rotate verification tokens', () => {
  assert.equal(shouldRotateVerificationToken('Inactive'), true);
  assert.equal(shouldRotateVerificationToken('Suspended'), true);
  assert.equal(shouldRotateVerificationToken('Lost'), true);
  assert.equal(shouldRotateVerificationToken('Approved'), false);
});

test('local QR endpoint returns SVG without external service dependency', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/api/qr?data=${encodeURIComponent('hello')}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /image\/svg\+xml/);
    assert.match(body, /<svg/);
  } finally {
    await close(server);
  }
});

test('backup rejects legacy GET requests', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/api/backup`);
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.match(body.error, /Use POST/);
  } finally {
    await close(server);
  }
});

test('scan endpoint requires admin authentication', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'plain-secret-token', action: 'sign-in' })
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.match(body.error, /log in/i);
  } finally {
    await close(server);
  }
});

test('scanner phone validation rejects unregistered devices', async () => {
  await assert.rejects(
    () => requireRegisteredScannerDevice({ deviceId: 'unregistered-phone' }),
    /not registered/i
  );
});
