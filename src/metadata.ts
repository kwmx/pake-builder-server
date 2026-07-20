const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 512 * 1024;
// CDNs in front of most pages and icons reject unknown agents with a 403.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface SiteMetadata {
  url: string;
  name: string;
  title?: string;
  description?: string;
  icon?: string;
  /** False when the icon exists but Pake cannot use it (SVG, an error page, ...). */
  iconUsable?: boolean;
  iconNote?: string;
  siteName?: string;
  themeColor?: string;
  /** Which source won, so the UI can say where a value came from. */
  source?: 'manifest' | 'page' | 'hostname';
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

/**
 * Reads attributes out of a single tag. A regex per attribute cannot do this:
 * a value like content="the world's best" ends at the apostrophe if the capture
 * class excludes both quote characters, which silently truncates most
 * descriptions. Quoting style is captured per attribute instead.
 */
function parseAttributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  const attribute = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attribute.exec(tag))) {
    found[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

function tagsOf(html: string, tagName: 'meta' | 'link'): Record<string, string>[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  return (html.match(pattern) ?? []).map(parseAttributes);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (whole, code: string) => {
      const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      };
      const key = code.toLowerCase();
      if (named[key]) return named[key];
      try {
        if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
        if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
      } catch {
        return whole;
      }
      return whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const relTokens = (link: Record<string, string>) => (link.rel ?? '').toLowerCase().split(/\s+/);

/** Largest declared dimension, used to rank icon candidates. */
function sizeOf(value: string | undefined): number {
  if (!value) return 0;
  return Math.max(0, ...value.split(/\s+/).map((pair) => Number(pair.split(/x/i)[0]) || 0));
}

const GENERIC_SUBDOMAIN = new Set([
  'www', 'web', 'app', 'apps', 'm', 'mobile', 'my', 'go', 'get', 'portal', 'dashboard',
  'console', 'admin', 'secure', 'login', 'signin', 'account', 'accounts', 'mail', 'id',
  'auth', 'beta', 'staging', 'new', 'home',
]);
const TLD_ISH = new Set([
  'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'uk', 'sa', 'ae', 'de', 'fr', 'jp', 'cn',
  'au', 'us', 'ca', 'in', 'me', 'ai', 'xyz', 'info', 'biz', 'tv', 'sh', 'gg', 'so', 'to',
  'cc', 'edu', 'gov', 'fun', 'site', 'online', 'store', 'tech', 'cloud', 'page', 'link',
  'live', 'news', 'blog', 'eu', 'nl', 'es', 'it', 'se', 'no', 'fi', 'br', 'ru', 'kr',
]);

/**
 * The brand label of a hostname. Taking the first label would name an app after
 * its subdomain — web.whatsapp.com becomes "Web", app.slack.com becomes "App" —
 * so strip the suffix and any routing subdomain first.
 */
export function brandFromHost(hostname: string): string {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  while (labels.length > 1 && TLD_ISH.has(labels[labels.length - 1])) labels.pop();
  while (labels.length > 1 && GENERIC_SUBDOMAIN.has(labels[0])) labels.shift();

  const label = (labels[labels.length - 1] ?? '').replace(/[^a-z0-9]/g, '');
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
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
  return brandFromHost(fallbackHost) || 'App';
}

interface WebAppManifest {
  name?: string;
  short_name?: string;
  description?: string;
  icons?: { src?: string; sizes?: string; type?: string; purpose?: string }[];
}

/**
 * Pake accepts PNG, ICO and ICNS only. Checking the bytes here means a bad icon
 * shows up in the form rather than as a Pake-branded app twenty minutes later —
 * the failure mode is silent otherwise, because Pake just uses its own logo.
 */
async function inspectIcon(iconUrl: string, referer: string): Promise<{ usable: boolean; note?: string }> {
  try {
    const response = await fetch(iconUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*', Referer: referer },
    });
    if (!response.ok) return { usable: false, note: `The icon URL returned ${response.status}.` };

    const head = new Uint8Array((await response.arrayBuffer()).slice(0, 8));
    const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return { usable: true };
    if (starts(0x00, 0x00, 0x01, 0x00)) return { usable: true };
    if (String.fromCharCode(...head.slice(0, 4)) === 'icns') return { usable: true };

    const kind = String.fromCharCode(...head.slice(0, 5)).trim().startsWith('<')
      ? 'an SVG or an HTML error page'
      : 'an unsupported image format';
    return { usable: false, note: `The site's icon is ${kind}. Pake needs PNG, ICO or ICNS.` };
  } catch {
    return { usable: false, note: 'The icon could not be downloaded.' };
  }
}

/**
 * Reads the target page for what the installer should carry. The web app
 * manifest is preferred over meta tags: anything worth packaging as a desktop
 * app is usually a PWA, and its manifest states the app's real name, purpose
 * and icon set rather than whatever the current page happens to be titled.
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
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,*;q=0.5',
      },
    });
    if (response.ok) {
      finalUrl = new URL(response.url || target.href);
      html = (await response.text()).slice(0, MAX_HTML_BYTES);
    }
  } catch {
    // Unreachable or too slow — fall through to hostname-derived defaults.
  }

  const metas = tagsOf(html, 'meta');
  const links = tagsOf(html, 'link');
  const metaValue = (key: string) =>
    metas.find((tag) => (tag.name ?? tag.property ?? '').toLowerCase() === key)?.content || undefined;

  let manifest: WebAppManifest | undefined;
  const manifestHref = links.find((link) => relTokens(link).includes('manifest'))?.href;
  if (manifestHref) {
    try {
      const manifestUrl = new URL(manifestHref, finalUrl);
      const response = await fetch(manifestUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/manifest+json,application/json' },
      });
      if (response.ok) manifest = (await response.json()) as WebAppManifest;
    } catch {
      // A missing or malformed manifest just means the meta tags decide.
    }
  }

  const pageTitle =
    metaValue('application-name') ??
    metaValue('og:site_name') ??
    metaValue('og:title') ??
    metaValue('twitter:title') ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];

  const rawName = manifest?.name || manifest?.short_name || pageTitle;
  const description =
    manifest?.description ??
    metaValue('og:description') ??
    metaValue('twitter:description') ??
    metaValue('description');

  // Manifest icons first: they are declared for exactly this purpose and are
  // usually square PNGs at app resolution.
  const manifestIcon = (manifest?.icons ?? [])
    .filter((icon) => icon.src && !/maskable/i.test(icon.purpose ?? ''))
    .sort((a, b) => sizeOf(b.sizes) - sizeOf(a.sizes))[0]?.src;

  const iconLinks = links
    .filter((link) => {
      const tokens = relTokens(link);
      return link.href && (tokens.includes('apple-touch-icon') || tokens.includes('icon'));
    })
    .sort((a, b) => {
      const appleFirst =
        Number(relTokens(b).includes('apple-touch-icon')) -
        Number(relTokens(a).includes('apple-touch-icon'));
      return appleFirst || sizeOf(b.sizes) - sizeOf(a.sizes);
    });

  const iconCandidate =
    manifestIcon ??
    iconLinks[0]?.href ??
    metaValue('og:image') ??
    metaValue('twitter:image') ??
    '/favicon.ico';

  let icon: string | undefined;
  try {
    icon = new URL(iconCandidate, finalUrl).href;
  } catch {
    icon = undefined;
  }
  const iconCheck = icon
    ? await inspectIcon(icon, finalUrl.href)
    : { usable: false, note: 'No icon found.' };

  return {
    url: finalUrl.href,
    name: cleanAppName(rawName ?? '', finalUrl.hostname),
    title: pageTitle,
    description: description?.slice(0, 300),
    icon,
    iconUsable: iconCheck.usable,
    iconNote: iconCheck.note,
    siteName: metaValue('og:site_name'),
    themeColor: metaValue('theme-color'),
    source: manifest?.name || manifest?.short_name ? 'manifest' : rawName ? 'page' : 'hostname',
  };
}
