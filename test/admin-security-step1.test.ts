import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { middleware } from '../apps/admin/middleware';
import { POST as logoutPost } from '../apps/admin/app/api/admin/logout/route';
import { signToken } from '../apps/admin/lib/auth';

// ---------------------------------------------------------------------------
// test/admin-security-step1.test.ts
// Unit & Integration Test Suite for Phase F Step 1: Admin Security Foundation
// ---------------------------------------------------------------------------

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: unknown) {
  if (condition) {
    passedCount++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    failedCount++;
    console.error(`  ❌ [FAIL] ${testName}`, detail || '');
  }
}

// Ensure JWT_SECRET is set for test runner
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-key-for-admin-security-suite-12345';
}

async function runTests() {
  console.log('\n================================================================');
  console.log('PHASE F STEP 1: ADMIN SECURITY FOUNDATION TEST SUITE');
  console.log('================================================================\n');

  const validToken = signToken({ id: 1, username: 'admin' });

  // -------------------------------------------------------------------------
  // TEST 1: Unauthenticated dashboard request is redirected to /login
  // -------------------------------------------------------------------------
  console.log('Test 1: Unauthenticated dashboard request');
  {
    const req = new NextRequest('http://localhost:3000/');
    const res = await middleware(req);

    assert(res.status === 307, 'Dashboard request without token returns 307 redirect');
    const location = res.headers.get('location');
    assert(location?.includes('/login'), `Redirects to /login (actual: ${location})`);

    // Deep page route retains redirect parameter
    const deepReq = new NextRequest('http://localhost:3000/settings');
    const deepRes = await middleware(deepReq);
    assert(deepRes.status === 307, 'Deep page request returns 307 redirect');
    assert(deepRes.headers.get('location')?.includes('/login?from=%2Fsettings'), 'Preserves target URL in redirect');
  }

  // -------------------------------------------------------------------------
  // TEST 2: Unauthenticated API request returns 401 Unauthorized
  // -------------------------------------------------------------------------
  console.log('\nTest 2: Unauthenticated API request');
  {
    const req = new NextRequest('http://localhost:3000/api/confessions');
    const res = await middleware(req);

    assert(res.status === 401, 'API request without token returns 401 Unauthorized');
    const body = await res.json();
    assert(body.error === 'Unauthorized', 'Error body indicates Unauthorized');
    assert(body.message?.includes('Admin authentication required'), 'Message indicates admin authentication required');

    // Test other sensitive API endpoints
    const patchReq = new NextRequest('http://localhost:3000/api/confessions/123', { method: 'PATCH' });
    const patchRes = await middleware(patchReq);
    assert(patchRes.status === 401, 'Unauthenticated PATCH returns 401');

    const generateReq = new NextRequest('http://localhost:3000/api/generate-images', { method: 'POST' });
    const generateRes = await middleware(generateReq);
    assert(generateRes.status === 401, 'Unauthenticated generate-images returns 401');
  }

  // -------------------------------------------------------------------------
  // TEST 3: Authenticated admin request is permitted
  // -------------------------------------------------------------------------
  console.log('\nTest 3: Authenticated admin request');
  {
    // Dashboard page access with valid token
    const dashboardReq = new NextRequest('http://localhost:3000/', {
      headers: {
        cookie: `admin_token=${validToken}`,
      },
    });
    const dashboardRes = await middleware(dashboardReq);
    assert(dashboardRes.status === 200, 'Authenticated dashboard request permitted (status 200)');

    // GET API access with valid token
    const apiReq = new NextRequest('http://localhost:3000/api/confessions', {
      headers: {
        cookie: `admin_token=${validToken}`,
      },
    });
    const apiRes = await middleware(apiReq);
    assert(apiRes.status === 200, 'Authenticated GET API request permitted (status 200)');
  }

  // -------------------------------------------------------------------------
  // TEST 4: Invalid and expired JWT tokens are rejected
  // -------------------------------------------------------------------------
  console.log('\nTest 4: Invalid and expired JWT tokens');
  {
    // A. Malformed token
    const malformedReq = new NextRequest('http://localhost:3000/api/confessions', {
      headers: {
        cookie: 'admin_token=garbage.invalid.token',
      },
    });
    const malformedRes = await middleware(malformedReq);
    assert(malformedRes.status === 401, 'Malformed token returns 401 Unauthorized');

    // B. Token signed with different secret
    const fakeToken = jwt.sign({ id: 1, username: 'admin' }, 'wrong-secret-key-attacker');
    const fakeReq = new NextRequest('http://localhost:3000/api/confessions', {
      headers: {
        cookie: `admin_token=${fakeToken}`,
      },
    });
    const fakeRes = await middleware(fakeReq);
    assert(fakeRes.status === 401, 'Token with wrong signature returns 401 Unauthorized');

    // C. Expired token
    const expiredToken = jwt.sign({ id: 1, username: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '-10s' });
    const expiredReq = new NextRequest('http://localhost:3000/api/confessions', {
      headers: {
        cookie: `admin_token=${expiredToken}`,
      },
    });
    const expiredRes = await middleware(expiredReq);
    assert(expiredRes.status === 401, 'Expired token returns 401 Unauthorized');

    // D. Dashboard with expired token redirects to /login
    const expiredDashReq = new NextRequest('http://localhost:3000/', {
      headers: {
        cookie: `admin_token=${expiredToken}`,
      },
    });
    const expiredDashRes = await middleware(expiredDashReq);
    assert(expiredDashRes.status === 307, 'Dashboard with expired token redirects to /login');
  }

  // -------------------------------------------------------------------------
  // TEST 5: Logout cookie handling clears token completely
  // -------------------------------------------------------------------------
  console.log('\nTest 5: Logout cookie handling');
  {
    const logoutRes = await logoutPost();
    assert(logoutRes.status === 200, 'Logout POST returns 200 OK');

    const cookieHeader = logoutRes.headers.get('set-cookie');
    assert(cookieHeader !== null, 'Set-Cookie header is present in logout response');
    assert(cookieHeader!.includes('admin_token='), 'Clears admin_token cookie');
    assert(cookieHeader!.includes('Max-Age=0') || cookieHeader!.includes('max-age=0'), 'Sets Max-Age=0');
    assert(cookieHeader!.includes('Path=/') || cookieHeader!.includes('path=/'), 'Specifies Path=/');
    assert(cookieHeader!.includes('HttpOnly') || cookieHeader!.includes('httponly'), 'Specifies HttpOnly');
    assert(cookieHeader!.toLowerCase().includes('samesite=lax'), 'Specifies SameSite=Lax');

    const cookieObj = logoutRes.cookies.get('admin_token');
    assert(cookieObj?.value === '', 'Cookie value is empty string');
    assert(cookieObj?.maxAge === 0, 'Cookie maxAge is 0');
  }

  // -------------------------------------------------------------------------
  // TEST 6: State-changing request without CSRF protection is blocked
  // -------------------------------------------------------------------------
  console.log('\nTest 6: State-changing request without CSRF protection');
  {
    // A. POST without CSRF header
    const postNoCsrf = new NextRequest('http://localhost:3000/api/generate-images', {
      method: 'POST',
      headers: {
        cookie: `admin_token=${validToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 1 }),
    });
    const postRes = await middleware(postNoCsrf);
    assert(postRes.status === 403, 'POST without CSRF header returns 403 Forbidden');
    const postBody = await postRes.json();
    assert(postBody.error === 'Forbidden', 'Error indicates Forbidden');
    assert(postBody.message?.includes('CSRF validation failed'), 'Message explains CSRF validation failed');

    // B. PATCH without CSRF header
    const patchNoCsrf = new NextRequest('http://localhost:3000/api/confessions/2', {
      method: 'PATCH',
      headers: {
        cookie: `admin_token=${validToken}`,
      },
    });
    const patchRes = await middleware(patchNoCsrf);
    assert(patchRes.status === 403, 'PATCH without CSRF header returns 403 Forbidden');

    // C. DELETE without CSRF header
    const deleteNoCsrf = new NextRequest('http://localhost:3000/api/confessions/2', {
      method: 'DELETE',
      headers: {
        cookie: `admin_token=${validToken}`,
      },
    });
    const deleteRes = await middleware(deleteNoCsrf);
    assert(deleteRes.status === 403, 'DELETE without CSRF header returns 403 Forbidden');

    // D. CSRF Origin mismatch (cross-site attempt)
    const crossOriginReq = new NextRequest('http://localhost:3000/api/confessions/2', {
      method: 'DELETE',
      headers: {
        cookie: `admin_token=${validToken}`,
        origin: 'http://malicious-attacker.com',
        host: 'localhost:3000',
        'x-admin-action': '1',
      },
    });
    const crossOriginRes = await middleware(crossOriginReq);
    assert(crossOriginRes.status === 403, 'Cross-origin request returns 403 Forbidden even with header');
    const crossBody = await crossOriginRes.json();
    assert(crossBody.message?.includes('Origin mismatch'), 'Message specifies Origin mismatch');

    // E. CSRF Referer mismatch when Origin is absent
    const refererMismatchReq = new NextRequest('http://localhost:3000/api/confessions/2', {
      method: 'DELETE',
      headers: {
        cookie: `admin_token=${validToken}`,
        referer: 'http://malicious-attacker.com/evil',
        host: 'localhost:3000',
        'x-admin-action': '1',
      },
    });
    const refererMismatchRes = await middleware(refererMismatchReq);
    assert(refererMismatchRes.status === 403, 'Referer mismatch returns 403 Forbidden even with header');
    const refererBody = await refererMismatchRes.json();
    assert(refererBody.message?.includes('Referer mismatch'), 'Message specifies Referer mismatch');

    // F. Sec-Fetch-Site: same-origin alone CANNOT bypass custom header requirement
    const secFetchAloneReq = new NextRequest('http://localhost:3000/api/confessions/2', {
      method: 'DELETE',
      headers: {
        cookie: `admin_token=${validToken}`,
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-origin',
        // Note: No X-Admin-Action or X-CSRF-Protection header
      },
    });
    const secFetchAloneRes = await middleware(secFetchAloneReq);
    assert(secFetchAloneRes.status === 403, 'Sec-Fetch-Site: same-origin ALONE is rejected (403 Forbidden)');
    const secFetchBody = await secFetchAloneRes.json();
    assert(secFetchBody.message?.includes('Missing required anti-CSRF header'), 'Error explains missing required anti-CSRF header');
  }

  // -------------------------------------------------------------------------
  // TEST 7: Valid CSRF-protected request is allowed
  // -------------------------------------------------------------------------
  console.log('\nTest 7: Valid CSRF-protected request');
  {
    // A. Request with X-Admin-Action: 1 and matching Origin
    const validCsrfReq = new NextRequest('http://localhost:3000/api/generate-images', {
      method: 'POST',
      headers: {
        cookie: `admin_token=${validToken}`,
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'x-admin-action': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 2 }),
    });
    const validRes = await middleware(validCsrfReq);
    assert(validRes.status === 200, 'Valid CSRF-protected POST with X-Admin-Action: 1 is permitted (status 200)');

    // B. Request with X-CSRF-Protection: 1 and matching Referer
    const altCsrfReq = new NextRequest('http://localhost:3000/api/confessions/2', {
      method: 'PATCH',
      headers: {
        cookie: `admin_token=${validToken}`,
        host: 'localhost:3000',
        referer: 'http://localhost:3000/dashboard',
        'x-csrf-protection': '1',
      },
    });
    const altRes = await middleware(altCsrfReq);
    assert(altRes.status === 200, 'Request with X-CSRF-Protection: 1 and matching Referer is permitted (status 200)');
  }

  // -------------------------------------------------------------------------
  // TEST 8: Login remains publicly accessible
  // -------------------------------------------------------------------------
  console.log('\nTest 8: Login remains publicly accessible');
  {
    // A. POST /api/admin/login without any admin cookie
    const loginApiReq = new NextRequest('http://localhost:3000/api/admin/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    });
    const loginApiRes = await middleware(loginApiReq);
    assert(loginApiRes.status === 200, 'POST /api/admin/login is allowed without cookie (public exception)');

    // B. GET /login page loads without any admin cookie
    const loginPageReq = new NextRequest('http://localhost:3000/login');
    const loginPageRes = await middleware(loginPageReq);
    assert(loginPageRes.status === 200, 'GET /login page is allowed without cookie (public exception)');

    // C. Static icons and images load without any cookie
    const iconReq = new NextRequest('http://localhost:3000/icon.png');
    const iconRes = await middleware(iconReq);
    assert(iconRes.status === 200, 'GET /icon.png is allowed without cookie');
  }

  // -------------------------------------------------------------------------
  // TEST 9: Service-role and server secrets are never returned in responses
  // -------------------------------------------------------------------------
  console.log('\nTest 9: Service-role and server secrets are never returned');
  {
    const secretsToInspect = [
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      process.env.JWT_SECRET,
      process.env.ADMIN_PASSWORD_HASH,
      process.env.GEMINI_API_KEY,
      process.env.INSTAGRAM_ACCESS_TOKEN,
      process.env.RESEND_API_KEY,
    ].filter((s): s is string => !!s && s.length > 5);

    // Check error response from unauthenticated request
    const unauthReq = new NextRequest('http://localhost:3000/api/confessions');
    const unauthRes = await middleware(unauthReq);
    const unauthBodyStr = JSON.stringify(await unauthRes.json());
    for (const secret of secretsToInspect) {
      assert(!unauthBodyStr.includes(secret), 'Unauth error response does not leak secret');
    }

    // Check CSRF error response
    const csrfReq = new NextRequest('http://localhost:3000/api/generate-images', {
      method: 'POST',
      headers: { cookie: `admin_token=${validToken}` },
    });
    const csrfRes = await middleware(csrfReq);
    const csrfBodyStr = JSON.stringify(await csrfRes.json());
    for (const secret of secretsToInspect) {
      assert(!csrfBodyStr.includes(secret), 'CSRF error response does not leak secret');
    }

    // Check logout response headers and body
    const logoutRes = await logoutPost();
    const logoutStr = JSON.stringify(await logoutRes.json()) + Array.from(logoutRes.headers.entries()).join(' ');
    for (const secret of secretsToInspect) {
      assert(!logoutStr.includes(secret), 'Logout response does not leak secret');
    }
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`ADMIN SECURITY STEP 1 TESTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
