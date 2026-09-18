import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from './lib/auth';

/**
 * Public routes that do NOT require authentication.
 */
const PUBLIC_PATHS = [
  '/api/admin/login',
  '/login',
  '/favicon.ico',
  '/icon.png',
  '/logo.png',
];

/**
 * State-changing HTTP methods requiring CSRF protection.
 */
const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Allow static assets and Next.js internal files immediately
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/static') ||
    PUBLIC_PATHS.includes(pathname)
  ) {
    return NextResponse.next();
  }

  // 2. Extract and verify the admin session cookie
  const token = req.cookies.get('admin_token')?.value;
  const decoded = token ? verifyToken(token) : null;
  const isAuthenticated = !!decoded;

  // 3. Handle unauthenticated requests
  if (!isAuthenticated) {
    // API routes return 401 Unauthorized JSON
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          message: 'Admin authentication required',
        },
        { status: 401 }
      );
    }

    // Browser dashboard / page routes redirect to the login page
    const loginUrl = new URL('/login', req.url);
    // Add original path as redirect target if visiting a deep route
    if (pathname !== '/') {
      loginUrl.searchParams.set('from', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  // 4. CSRF Protection for state-changing operations
  if (STATE_CHANGING_METHODS.has(req.method)) {
    // A. Mandatory Origin / Referer Validation (prevent cross-origin submissions)
    const origin = req.headers.get('origin');
    const referer = req.headers.get('referer');
    const host = req.headers.get('host');

    if (origin && host) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.host !== host) {
          return NextResponse.json(
            {
              error: 'Forbidden',
              message: 'CSRF validation failed: Origin mismatch',
            },
            { status: 403 }
          );
        }
      } catch {
        return NextResponse.json(
          {
            error: 'Forbidden',
            message: 'CSRF validation failed: Malformed Origin',
          },
          { status: 403 }
        );
      }
    } else if (referer && host) {
      try {
        const refererUrl = new URL(referer);
        if (refererUrl.host !== host) {
          return NextResponse.json(
            {
              error: 'Forbidden',
              message: 'CSRF validation failed: Referer mismatch',
            },
            { status: 403 }
          );
        }
      } catch {
        return NextResponse.json(
          {
            error: 'Forbidden',
            message: 'CSRF validation failed: Malformed Referer',
          },
          { status: 403 }
        );
      }
    }

    // B. Mandatory Explicit Custom Anti-CSRF Header Check
    // An explicit custom header (X-Admin-Action: 1 or X-CSRF-Protection: 1) is strictly required.
    // Standard HTML forms and cross-site requests cannot send custom headers without CORS preflight.
    // Sec-Fetch-Site: same-origin is intentionally NOT permitted to satisfy this check by itself.
    const hasAdminActionHeader = req.headers.get('x-admin-action') === '1';
    const hasCsrfProtectionHeader = req.headers.get('x-csrf-protection') === '1';

    if (!hasAdminActionHeader && !hasCsrfProtectionHeader) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          message: 'CSRF validation failed: Missing required anti-CSRF header (X-Admin-Action or X-CSRF-Protection)',
        },
        { status: 403 }
      );
    }
  }

  // 5. Authenticated & CSRF-verified: proceed
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
