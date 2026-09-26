import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { signToken, verifyToken, verifyAdminCredentials } from '../apps/admin/lib/auth';
import { middleware } from '../apps/admin/middleware';
import { POST as loginRoute } from '../apps/admin/app/api/admin/login/route';
import { POST as logoutRoute } from '../apps/admin/app/api/admin/logout/route';

const TEST_SECRET = 'test-jwt-secret-key-32-chars-long-minimum!';
const TEST_PASSWORD = 'super-secret-admin-pass';

describe('Admin Authentication & Session Security (v3.5)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1. Verifies valid admin credentials using bcrypt', async () => {
    const valid = await verifyAdminCredentials('admin', TEST_PASSWORD);
    assert.equal(valid, true, 'Valid credentials should authenticate successfully');
  });

  it('2. Rejects invalid password', async () => {
    const valid = await verifyAdminCredentials('admin', 'wrong-password');
    assert.equal(valid, false, 'Invalid password should be rejected');
  });

  it('3. Rejects invalid username', async () => {
    const valid = await verifyAdminCredentials('wrong-user', TEST_PASSWORD);
    assert.equal(valid, false, 'Invalid username should be rejected');
  });

  it('4. Handles missing ADMIN_PASSWORD_HASH gracefully with controlled error', async () => {
    delete process.env.ADMIN_PASSWORD_HASH;
    await assert.rejects(
      async () => verifyAdminCredentials('admin', TEST_PASSWORD),
      (err: Error) => {
        assert.match(err.message, /ADMIN_PASSWORD_HASH is not set/);
        return true;
      }
    );
  });

  it('5. Successfully signs and verifies JWT tokens', () => {
    const payload = { id: 1, username: 'admin' };
    const token = signToken(payload);
    assert.ok(token, 'Token must be generated');

    const decoded = verifyToken(token);
    assert.ok(decoded, 'Token must verify successfully');
    assert.equal(decoded.username, 'admin');
    assert.equal(decoded.id, 1);
  });

  it('6. Returns null for expired JWT token', () => {
    const expiredToken = jwt.sign({ id: 1, username: 'admin' }, TEST_SECRET, { expiresIn: '-1s' });
    const decoded = verifyToken(expiredToken);
    assert.equal(decoded, null, 'Expired token must return null');
  });

  it('7. Returns null for malformed JWT token', () => {
    const decoded = verifyToken('invalid.jwt.structure');
    assert.equal(decoded, null, 'Malformed token must return null');
  });

  it('8. Returns null for token signed with a different secret', () => {
    const foreignToken = jwt.sign({ id: 1, username: 'admin' }, 'different-unauthorized-secret-key-12345');
    const decoded = verifyToken(foreignToken);
    assert.equal(decoded, null, 'Token with invalid signature must return null');
  });

  it('9. Middleware redirects unauthenticated dashboard access to /login', async () => {
    const req = new NextRequest('http://localhost:3000/');
    const res = await middleware(req);
    assert.equal(res.status, 307);
    const location = res.headers.get('location');
    assert.ok(location?.includes('/login'));
  });

  it('10. Middleware preserves deep link in redirect when unauthenticated', async () => {
    const req = new NextRequest('http://localhost:3000/settings');
    const res = await middleware(req);
    assert.equal(res.status, 307);
    const location = res.headers.get('location');
    assert.ok(location?.includes('/login?from=%2Fsettings'));
  });

  it('11. Middleware returns 401 JSON for unauthenticated API requests', async () => {
    const req = new NextRequest('http://localhost:3000/api/confessions');
    const res = await middleware(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Unauthorized');
  });

  it('12. Middleware allows authenticated dashboard access', async () => {
    const token = signToken({ id: 1, username: 'admin' });
    const req = new NextRequest('http://localhost:3000/', {
      headers: {
        cookie: `admin_token=${token}`,
      },
    });
    const res = await middleware(req);
    assert.equal(res.status, 200);
  });

  it('13. Middleware redirects authenticated user accessing /login back to /', async () => {
    const token = signToken({ id: 1, username: 'admin' });
    const req = new NextRequest('http://localhost:3000/login', {
      headers: {
        cookie: `admin_token=${token}`,
      },
    });
    const res = await middleware(req);
    assert.equal(res.status, 307);
    const location = res.headers.get('location');
    assert.ok(location?.endsWith('/'));
  });

  it('14. Middleware allows unauthenticated access to /login', async () => {
    const req = new NextRequest('http://localhost:3000/login');
    const res = await middleware(req);
    assert.equal(res.status, 200);
  });

  it('15. Middleware enforces CSRF header for state-changing requests', async () => {
    const token = signToken({ id: 1, username: 'admin' });
    const reqWithoutHeader = new NextRequest('http://localhost:3000/api/confessions/1/approve', {
      method: 'POST',
      headers: {
        cookie: `admin_token=${token}`,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
    });
    const resWithoutHeader = await middleware(reqWithoutHeader);
    assert.equal(resWithoutHeader.status, 403, 'Must reject POST without CSRF header');

    const reqWithHeader = new NextRequest('http://localhost:3000/api/confessions/1/approve', {
      method: 'POST',
      headers: {
        cookie: `admin_token=${token}`,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        'x-admin-action': '1',
      },
    });
    const resWithHeader = await middleware(reqWithHeader);
    assert.equal(resWithHeader.status, 200, 'Must allow POST with X-Admin-Action header');
  });

  it('16. Real route flow: POST /api/admin/login sets HttpOnly, SameSite=lax, path=/ cookie', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await loginRoute(req);
    assert.equal(res.status, 200);
    const cookie = res.cookies.get('admin_token');
    assert.ok(cookie, 'Response must set admin_token cookie');
    assert.ok(cookie.value.length > 20, 'Token value must be non-empty JWT');
    assert.equal(cookie.httpOnly, true, 'Cookie must be HttpOnly');
    assert.equal(cookie.path, '/', 'Cookie path must be /');
    assert.equal(cookie.sameSite, 'lax', 'Cookie SameSite must be lax');
    assert.equal(cookie.maxAge, 604800, 'Cookie maxAge must be 7 days (604800s)');
  });

  it('17. Real route flow: POST /api/admin/login rejects bad password with 401 and sets no cookie', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'bad-password' }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await loginRoute(req);
    assert.equal(res.status, 401);
    const cookie = res.cookies.get('admin_token');
    assert.equal(cookie, undefined, 'No admin_token cookie must be set on failed login');
  });

  it('18. Real route flow: POST /api/admin/logout clears admin_token cookie with maxAge: 0', async () => {
    const res = await logoutRoute();
    assert.equal(res.status, 200);
    const cookie = res.cookies.get('admin_token');
    assert.ok(cookie, 'Logout response must set expired admin_token cookie');
    assert.equal(cookie.value, '', 'Cookie value must be cleared');
    assert.equal(cookie.maxAge, 0, 'Cookie maxAge must be 0');
    assert.equal(cookie.path, '/', 'Cookie path must be /');
  });

  it('19. End-to-end session cycle: login -> dashboard access -> logout -> unauthenticated redirect', async () => {
    // 1. Attempt unauthenticated access to dashboard
    const unauthReq = new NextRequest('http://localhost:3000/settings');
    const unauthRes = await middleware(unauthReq);
    assert.equal(unauthRes.status, 307);
    assert.ok(unauthRes.headers.get('location')?.includes('/login?from=%2Fsettings'));

    // 2. Perform login
    const loginReq = new NextRequest('http://localhost:3000/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
      headers: { 'content-type': 'application/json' },
    });
    const loginRes = await loginRoute(loginReq);
    assert.equal(loginRes.status, 200);
    const token = loginRes.cookies.get('admin_token')?.value;
    assert.ok(token);

    // 3. Access protected dashboard with session cookie
    const authReq = new NextRequest('http://localhost:3000/settings', {
      headers: { cookie: `admin_token=${token}` },
    });
    const authRes = await middleware(authReq);
    assert.equal(authRes.status, 200, 'Authenticated request must pass through');

    // 4. Access /login with session cookie -> redirected to /
    const loginPageReq = new NextRequest('http://localhost:3000/login', {
      headers: { cookie: `admin_token=${token}` },
    });
    const loginPageRes = await middleware(loginPageReq);
    assert.equal(loginPageRes.status, 307);
    assert.ok(loginPageRes.headers.get('location')?.endsWith('/'));

    // 5. Logout
    const logoutRes = await logoutRoute();
    assert.equal(logoutRes.status, 200);

    // 6. Access protected dashboard after logout
    const postLogoutReq = new NextRequest('http://localhost:3000/settings');
    const postLogoutRes = await middleware(postLogoutReq);
    assert.equal(postLogoutRes.status, 307);
    assert.ok(postLogoutRes.headers.get('location')?.includes('/login'));
  });
});
