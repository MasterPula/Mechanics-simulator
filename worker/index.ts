interface Env {
  ASSETS: Fetcher;
}

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests";

export default {
  async fetch(request, env): Promise<Response> {
    const upstream = await env.ASSETS.fetch(request);
    const headers = new Headers(upstream.headers);

    for (const [key, value] of Object.entries(BASE_HEADERS)) {
      headers.set(key, value);
    }

    if (headers.get("content-type")?.includes("text/html")) {
      headers.set("Content-Security-Policy", HTML_CSP);
      headers.set("Cache-Control", "no-store");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
