const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }

  const devSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[WARN] Using random per-process JWT secret (dev mode) — tokens will expire on server restart. Set JWT_SECRET env var for production.');
  return devSecret;
})();
const TOKEN_EXPIRY = '24h';
const TEMP_TOKEN_EXPIRY = '5m'; // Temporary token for 2FA login step

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function generateToken(user) {
  return jwt.sign({ userId: user.id, email: user.email, role: user.role || 'user' }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// Generate a short-lived temp token for 2FA login flow (password verified, TOTP pending)
function generateTempToken(user) {
  return jwt.sign({ userId: user.id, type: '2fa_pending' }, JWT_SECRET, { expiresIn: TEMP_TOKEN_EXPIRY });
}

// Verify the temp token issued during 2FA login
function verifyTempToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== '2fa_pending') return null;
    return decoded;
  } catch (err) {
    return null;
  }
}

// ========================
// TOTP replay protection — prevent reuse of the same code within its validity window
// ========================
const usedTOTPCodes = new Map();

// Periodic cleanup of expired TOTP codes (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of usedTOTPCodes) {
    if (now >= expiresAt) {
      usedTOTPCodes.delete(key);
    }
  }
}, 120000);

// ========================
// TOTP (RFC 6238) — No external dependencies, uses Node.js crypto
// ========================

// Base32 encoding/decoding (RFC 4648)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let result = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

function base32Decode(encoded) {
  const cleaned = encoded.replace(/[=\s]/g, '').toUpperCase();
  const output = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// Generate a random TOTP secret (base32-encoded, 20 bytes = 32 chars)
function generateTOTPSecret() {
  const buffer = crypto.randomBytes(20);
  return base32Encode(buffer);
}

// Generate TOTP code for a given time
function generateTOTP(secret, time) {
  const epoch = Math.floor((time || Date.now()) / 1000 / 30);
  const keyBuffer = base32Decode(secret);
  const timeBuffer = Buffer.alloc(8);
  // Write the 64-bit big-endian counter
  const high = Math.floor(epoch / 0x100000000);
  const low = epoch & 0xffffffff;
  timeBuffer.writeUInt32BE(high, 0);
  timeBuffer.writeUInt32BE(low >>> 0, 4);
  const hmac = crypto.createHmac('sha1', keyBuffer);
  hmac.update(timeBuffer);
  const hash = hmac.digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code = ((hash[offset] & 0x7f) << 24 | hash[offset + 1] << 16 | hash[offset + 2] << 8 | hash[offset + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

// Verify TOTP code (checks current window and +/- 1 window for clock drift)
// Includes replay protection: each code can only be used once within its validity window.
function verifyTOTP(secret, code, userId, skipReplayCheck) {
  if (!secret || !code) return false;
  const normalizedCode = String(code).padStart(6, '0');
  const now = Date.now();

  // Check current, previous, and next 30-second windows
  for (let drift = -1; drift <= 1; drift++) {
    const expected = generateTOTP(secret, now + drift * 30000);
    if (expected === normalizedCode) {
      // Replay protection: check if this code was already used by this user
      if (!skipReplayCheck) {
        const replayKey = `${userId || 'unknown'}:${normalizedCode}`;
        if (usedTOTPCodes.has(replayKey)) {
          return false; // Code already used — reject replay
        }
        // Mark code as used with a 90-second TTL (covers the full 3-window validity)
        usedTOTPCodes.set(replayKey, Date.now() + 90000);
        setTimeout(() => { usedTOTPCodes.delete(replayKey); }, 90000);
      }
      return true;
    }
  }
  return false;
}

function authMiddleware(req, res, next) {
  const db = require('./db');

  // Skip auth for public webhook endpoints (called by external messaging platforms)
  if (req.path === '/webhook/messaging') {
    req.user = null;
    return next();
  }

  // Skip auth in test mode (disabled in production)
  if (process.env.SKIP_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
    const fallback = db.getUserByEmail('saldo@automaton.bg') || { id: 1, email: 'saldo@automaton.bg', name: 'Admin', role: 'admin' };
    req.user = { id: fallback.id, email: fallback.email, name: fallback.name || fallback.email, role: fallback.role || 'admin' };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Reject temporary 2FA tokens — they should only be used at /api/auth/2fa/login
    if (decoded.type === '2fa_pending') {
      return res.status(401).json({ success: false, error: 'Unauthorized — 2FA verification required' });
    }

    // Load fresh user from DB to get current role and active status
    const user = db.getUserById(decoded.userId);
    if (!user || user.is_active === 0) {
      return res.status(401).json({ success: false, error: 'Account disabled' });
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role || 'user' };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// ========================
// OIDC (OpenID Connect) — SSO support for enterprise single sign-on
// ========================

const OIDC_CONFIG = {
  enabled: process.env.OIDC_ENABLED === 'true',
  issuer: process.env.OIDC_ISSUER || '',
  client_id: process.env.OIDC_CLIENT_ID || '',
  client_secret: process.env.OIDC_CLIENT_SECRET || '',
  redirect_uri: process.env.OIDC_REDIRECT_URI || '',
  scope: 'openid email profile'
};

/**
 * Check that a URL uses HTTPS. In production, reject HTTP URLs.
 * In development, log a warning but allow HTTP for local testing.
 * @param {string} url - The URL to check
 * @param {string} label - Label for log messages (e.g. 'token endpoint')
 * @throws {Error} if URL is HTTP and NODE_ENV === 'production'
 */
function enforceHttps(url, label) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`OIDC ${label} must use HTTPS in production (got ${url})`);
    }
    console.warn(`[WARN] OIDC ${label} is using HTTP (${url}) — only allowed in development`);
  }
}

/**
 * Make an HTTPS/HTTP POST request with form-urlencoded body.
 * Returns a promise resolving to the parsed JSON response.
 */
function oidcTokenRequest(tokenUrl, params) {
  enforceHttps(tokenUrl, 'token endpoint');
  return new Promise((resolve, reject) => {
    const parsed = new URL(tokenUrl);
    const body = new URLSearchParams(params).toString();
    const transport = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    };

    const req = transport.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('OIDC token response parse error'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OIDC token request timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Make an HTTPS/HTTP GET request (generic, returns parsed JSON).
 */
function oidcGetRequest(url) {
  enforceHttps(url, 'GET request');
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 10000
    };

    const req = transport.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('OIDC GET response parse error'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OIDC GET request timeout')); });
    req.end();
  });
}

/**
 * Make an HTTPS/HTTP GET request with Authorization header.
 * Returns a promise resolving to parsed JSON.
 */
function oidcUserInfoRequest(userInfoUrl, accessToken) {
  enforceHttps(userInfoUrl, 'userinfo endpoint');
  return new Promise((resolve, reject) => {
    const parsed = new URL(userInfoUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      timeout: 10000
    };

    const req = transport.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('OIDC userinfo response parse error'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OIDC userinfo request timeout')); });
    req.end();
  });
}

/**
 * Decode a base64url-encoded string to a Buffer.
 */
function base64urlDecode(str) {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Decode JWT payload without signature verification.
 * Kept for backward compatibility — prefer verifyIdToken() instead.
 */
function decodeJwtPayloadServer(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Decode JWT header (first segment).
 */
function decodeJwtHeader(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  } catch (e) {
    return null;
  }
}

// ========================
// JWKS-based id_token signature verification
// ========================

// In-memory JWKS cache: { keys: [...], fetchedAt: timestamp, jwksUri: string }
let jwksCache = { keys: null, fetchedAt: 0, jwksUri: null };
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch the OIDC discovery document and return the jwks_uri.
 */
async function fetchJwksUri(issuer) {
  const discoveryUrl = issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const config = await oidcGetRequest(discoveryUrl);
  if (!config || !config.jwks_uri) {
    throw new Error('OIDC discovery document missing jwks_uri');
  }
  return config.jwks_uri;
}

/**
 * Fetch JWKS keys from the provider's jwks_uri.
 * Caches results in memory; refreshes after JWKS_CACHE_TTL (1 hour).
 */
async function getJwks(issuer) {
  const now = Date.now();
  if (jwksCache.keys && (now - jwksCache.fetchedAt) < JWKS_CACHE_TTL) {
    return jwksCache.keys;
  }

  const jwksUri = await fetchJwksUri(issuer);
  enforceHttps(jwksUri, 'JWKS endpoint');
  const jwksData = await oidcGetRequest(jwksUri);

  if (!jwksData || !Array.isArray(jwksData.keys)) {
    throw new Error('JWKS response missing keys array');
  }

  jwksCache = { keys: jwksData.keys, fetchedAt: now, jwksUri: jwksUri };
  return jwksData.keys;
}

/**
 * Convert a JWK (RSA) to a PEM-encoded public key using Node.js crypto.
 * Supports RSA keys only (kty: "RSA").
 */
function jwkToPem(jwk) {
  if (jwk.kty !== 'RSA') {
    throw new Error('Unsupported JWK key type: ' + jwk.kty + ' (only RSA is supported)');
  }
  // Use Node.js crypto.createPublicKey with JWK input (available since Node 12)
  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'spki', format: 'pem' });
}

/**
 * Map JWT alg header to Node.js crypto algorithm name.
 */
function jwtAlgToNodeAlg(alg) {
  const map = {
    'RS256': 'RSA-SHA256',
    'RS384': 'RSA-SHA384',
    'RS512': 'RSA-SHA512'
  };
  return map[alg] || null;
}

/**
 * Verify the id_token signature using JWKS, then validate claims.
 *
 * @param {string} idToken - The raw JWT id_token string
 * @param {string} issuer - Expected issuer (OIDC_CONFIG.issuer)
 * @param {string} clientId - Expected audience (OIDC_CONFIG.client_id)
 * @returns {Promise<object>} Decoded and verified claims payload
 * @throws {Error} on verification or validation failure
 */
async function verifyIdTokenSignature(idToken, issuer, clientId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format: expected 3 parts');
  }

  const header = decodeJwtHeader(idToken);
  if (!header || !header.alg) {
    throw new Error('Invalid JWT header');
  }

  const nodeAlg = jwtAlgToNodeAlg(header.alg);
  if (!nodeAlg) {
    throw new Error('Unsupported JWT algorithm: ' + header.alg);
  }

  // Fetch matching key from JWKS
  const keys = await getJwks(issuer);
  let matchingKey = null;

  if (header.kid) {
    matchingKey = keys.find(k => k.kid === header.kid && k.use !== 'enc');
  }
  if (!matchingKey) {
    // Fallback: find first signing key with matching alg
    matchingKey = keys.find(k => k.kty === 'RSA' && k.use !== 'enc' && (!k.alg || k.alg === header.alg));
  }
  if (!matchingKey) {
    throw new Error('No matching key found in JWKS for kid=' + (header.kid || 'none'));
  }

  // Convert JWK to PEM and verify signature
  const pem = jwkToPem(matchingKey);
  const signatureInput = parts[0] + '.' + parts[1];
  const signature = base64urlDecode(parts[2]);

  const isValid = crypto.createVerify(nodeAlg)
    .update(signatureInput)
    .verify(pem, signature);

  if (!isValid) {
    throw new Error('JWT signature verification failed');
  }

  // Decode and validate claims
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));

  // Validate issuer
  const expectedIss = issuer.replace(/\/$/, '');
  const actualIss = (payload.iss || '').replace(/\/$/, '');
  if (actualIss !== expectedIss) {
    throw new Error('JWT issuer mismatch: expected ' + expectedIss + ', got ' + actualIss);
  }

  // Validate audience
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) {
    throw new Error('JWT audience mismatch: expected ' + clientId + ', got ' + payload.aud);
  }

  // Validate expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT has expired');
  }

  return payload;
}

/**
 * Verify an OIDC id_token with full JWKS signature verification and claims validation.
 * Falls back to the userinfo endpoint if JWKS verification fails.
 *
 * @param {string} idToken - The raw JWT id_token
 * @param {string} accessToken - The access_token (for userinfo fallback)
 * @returns {Promise<{email: string|null, name: string|null, source: string}>}
 */
async function verifyIdToken(idToken, accessToken) {
  // Attempt JWKS-based verification
  try {
    const claims = await verifyIdTokenSignature(
      idToken,
      OIDC_CONFIG.issuer,
      OIDC_CONFIG.client_id
    );
    return {
      email: claims.email || null,
      name: claims.name || claims.preferred_username || claims.email || null,
      source: 'id_token_verified'
    };
  } catch (err) {
    console.warn('[OIDC] id_token JWKS verification failed:', err.message);
  }

  // Fallback: fetch claims from userinfo endpoint using the access_token.
  // This is a direct server-to-server call and is safer than trusting an unverified id_token.
  if (accessToken) {
    try {
      const userInfoUrl = OIDC_CONFIG.issuer.replace(/\/$/, '') + '/userinfo';
      const userInfo = await oidcUserInfoRequest(userInfoUrl, accessToken);
      console.log('[OIDC] Fell back to userinfo endpoint for user claims');
      return {
        email: userInfo.email || null,
        name: userInfo.name || userInfo.preferred_username || null,
        source: 'userinfo_fallback'
      };
    } catch (err2) {
      console.error('[OIDC] Userinfo fallback also failed:', err2.message);
    }
  }

  return { email: null, name: null, source: 'failed' };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  generateTempToken,
  verifyTempToken,
  generateTOTPSecret,
  generateTOTP,
  verifyTOTP,
  authMiddleware,
  // OIDC
  OIDC_CONFIG,
  oidcTokenRequest,
  oidcUserInfoRequest,
  decodeJwtPayloadServer,
  verifyIdToken,
};
