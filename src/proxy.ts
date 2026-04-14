// ============================================================
// SONAR v2.0 — Next.js Proxy (previously middleware)
// ============================================================
// Next.js 16: file is named proxy.ts (replaces middleware.ts).
// Handles Supabase session refresh on every request.
// Dashboard is currently PUBLIC — no auth gate.
// To enable auth-gating later: uncomment the redirect block below.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    },
  );

  // Refresh session — required by @supabase/ssr to keep tokens valid.
  // Do NOT remove this call; it mutates supabaseResponse.
  const { data: { user } } = await supabase.auth.getUser();

  // ── Auth gate (currently disabled — dashboard is public) ──────
  // To protect the dashboard, uncomment:
  //
  // const isDashboard = request.nextUrl.pathname.startsWith('/dashboard');
  // if (isDashboard && !user) {
  //   const url = request.nextUrl.clone();
  //   url.pathname = '/login';
  //   return NextResponse.redirect(url);
  // }

  // Suppress unused-variable warning while gate is disabled
  void user;

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico
     * - API routes (they handle their own auth)
     */
    '/((?!_next/static|_next/image|favicon.ico|api/).*)',
  ],
};
