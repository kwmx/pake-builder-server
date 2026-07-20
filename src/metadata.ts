const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 512 * 1024;

export interface SiteMetadata {
  url: string;
  name: string;
  title?: string;
  description?: string;
  icon?: string;
  siteName?: string;
  themeColor?: string;
}

/**
 * Blocks the obvious SSRF targets. This is not airtight against DNS rebinding,
 * but it stops the app being used to probe the host's own network from a form
 * field, which is the realistic risk here.
 */
const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|\[?::1\]?|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function assertFetchable(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be inspected.');
  }
  if (PRIVATE_HOST.test(parsed.hostname)) {
    throw new Error('Private and loopback addresses cannot be inspected.');
  }
  return parsed;
}

/** First capture group of the first pattern that matches, trimmed. */
function firstMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const found = html.match(pattern);
    if (found?.[1]) {
      const text = decodeEntities(found[1].trim());
      if (text) return text;
    }
  }
  return undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, code: string) => {
      const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      };
      const key = code.toLowerCase();
      if (named[key]) return named[key];
      if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
      return whole;
    })
    .replace(/\s+/g, ' ');
}

/** Meta tag matcher that tolerates attribute order (content before or after name). */
function metaPatterns(key: string): RegExp[] {
  const k = key.replace(/[:]/g, '[:]');
  return [
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, 'i'),
  ];
}

/**
 * Picks the best icon link. Matching whole rel tokens matters: a substring
 * match treats GitHub's <link rel="fluid-icon"> and Safari's "mask-icon" as
 * favicons, and both are the wrong shape for an app icon.
 */
function bestIconHref(html: string): string | undefined {
  const links: { tokens: string[]; href: string; area: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!rel || !href) continue;
    const size = tag.match(/sizes=["'](\d+)x(\d+)["']/i);
    links.push({
      tokens: rel.toLowerCase().split(/\s+/),
      href,
      area: size ? Number(size[1]) * Number(size[2]) : 0,
    });
  }

  const largestOf = (has: (tokens: string[]) => boolean) =>
    links.filter((l) => has(l.tokens)).sort((a, b) => b.area - a.area)[0]?.href;

  return (
    largestOf((t) => t.includes('apple-touch-icon') || t.includes('apple-touch-icon-precomposed')) ??
    largestOf((t) => t.includes('icon'))
  );
}

/** App names must survive Pake's own validation, so strip what it would reject. */
export function cleanAppName(raw: string, fallbackHost: string): string {
  const cleaned = raw
    .split(/[|\u2013\u2014\u00b7:]/)[0]
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
  if (cleaned && /^[A-Za-z0-9]/.test(cleaned)) return cleaned;

  const host = fallbackHost.replace(/^www\./, '').split('.')[0].replace(/[^A-Za-z0-9]/g, '');
  return host ? host.charAt(0).toUpperCase() + host.slice(1) : 'App';
}

/**
 * Reads the target page and pulls out what the installer should carry: a name,
 * a description and an icon. Everything is best-effort — a site that blocks us
 * still produces a usable name derived from its hostname.
 */
export async function readSiteMetadata(rawUrl: string): Promise<SiteMetadata> {
  const target = assertFetchable(rawUrl);

  let html = '';
  let finalUrl = target;
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Some sites serve a stub to unknown agents; a browser UA gets the real head.
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (response.ok) {
      finalUrl = new URL(response.url || target.href);
      html = (await response.text()).slice(0, MAX_HTML_BYTES);
    }
  } catch {
    // Unreachable or too slow — fall through to hostname-derived defaults.
  }

  const rawTitle =
    firstMatch(html, metaPatterns('og:title')) ??
    firstMatch(html, metaPatterns('twitter:title')) ??
    firstMatch(html, metaPatterns('application-name')) ??
    firstMatch(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);

  const description =
    firstMatch(html, metaPatterns('og:description')) ??
    firstMatch(html, metaPatterns('twitter:description')) ??
    firstMatch(html, metaPatterns('description'));

  const siteName = firstMatch(html, metaPatterns('og:site_name'));
  const themeColor = firstMatch(html, metaPatterns('theme-color'));

  // Ordered by how likely each is to be a crisp, square, high-resolution mark.
  const iconCandidate =
    bestIconHref(html) ??
    firstMatch(html, metaPatterns('og:image')) ??
    firstMatch(html, metaPatterns('twitter:image')) ??
    '/favicon.ico';

  let icon: string | undefined;
  try {
    icon = new URL(iconCandidate, finalUrl).href;
  } catch {
    icon = undefined;
  }

  return {
    url: finalUrl.href,
    name: cleanAppName(rawTitle ?? siteName ?? '', finalUrl.hostname),
    title: rawTitle,
    description: description?.slice(0, 300),
    icon,
    siteName,
    themeColor,
  };
}
