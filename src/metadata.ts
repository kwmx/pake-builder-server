const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 512 * 1024;
// CDNs in front of most icons reject unknown agents, so images still use a
// browser agent.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * No single agent works everywhere. A bare Chrome User-Agent without the client
 * hints a real Chrome always sends is treated as forged by some hosts — Meta
 * answers web.whatsapp.com with a 400 and no tags — while other hosts reject
 * anything that is not a browser. So try a few and keep whichever actually
 * returns metadata.
 */
const FETCH_PROFILES: { label: string; headers: Record<string, string> }[] = [
  {
    label: 'browser',
    headers: {
      'User-Agent': BROWSER_UA,
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  },
  {
    label: 'plain',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; pake-cloud-builder/1.0; +https://github.com/tw93/Pake)',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  { label: 'bare', headers: { Accept: 'text/html,application/xhtml+xml' } },
];

/** Did a response actually carry anything worth reading? */
const CARRIES_METADATA = /<title[^>]*>\s*\S|og:title|og:description|name=["']description["']/i;

/**
 * Bot-protection interstitials have a title and would otherwise sail through the
 * check above, naming the packaged app "Just a moment" or "Attention Required".
 */
const CHALLENGE_PAGE =
  /just a moment|attention required|checking your browser|verify(?:ing)? you are (?:human|not a robot)|enable javascript and cookies|cf-browser-verification|challenge-platform|__cf_chl|access denied/i;

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
  source?: 'manifest' | 'page' | 'apex' | 'hostname';
  /** HTTP status of the page request, for telling a block apart from a bad parse. */
  fetchStatus?: number;
  /** Set only when little or nothing could be read, explaining why. */
  fetchNote?: string;
  /** Which request profile the page answered, for diagnosing odd hosts. */
  fetchProfile?: string;
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
  // An IP literal has no brand in it; "127.0.0.1" would otherwise yield "1".
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return '';
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
 * Identifies an image by its magic bytes. The build converts every icon through
 * ImageMagick before Pake sees it, so the question is not "is this one of Pake's
 * three formats" but "is this a real image at all" — rejecting a WebP favicon
 * that converts perfectly well would send an app out wearing Pake's logo.
 */
function sniffImage(bytes: Uint8Array): { kind: string; usable: boolean } {
  const starts = (...expected: number[]) => expected.every((b, i) => bytes[i] === b);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));

  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: 'PNG', usable: true };
  if (starts(0x00, 0x00, 0x01, 0x00)) return { kind: 'ICO', usable: true };
  if (ascii(0, 4) === 'icns') return { kind: 'ICNS', usable: true };
  if (starts(0xff, 0xd8, 0xff)) return { kind: 'JPEG', usable: true };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { kind: 'GIF', usable: true };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'WebP', usable: true };
  if (starts(0x42, 0x4d)) return { kind: 'BMP', usable: true };
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) {
    return { kind: 'TIFF', usable: true };
  }
  if (ascii(4, 8) === 'ftyp') return { kind: 'AVIF or HEIF', usable: true };

  const text = ascii(0, Math.min(bytes.length, 256)).trim().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) {
    return { kind: 'SVG', usable: true };
  }
  if (text.startsWith('<')) return { kind: 'HTML', usable: false };
  return { kind: 'unknown', usable: false };
}

/**
 * Checks the icon is really an image. A 404 page or a JSON error body would
 * otherwise sail through and only reveal itself as Pake's own logo on the
 * finished app, twenty minutes later.
 */
async function inspectIcon(
  iconUrl: string,
  referer: string,
): Promise<{ usable: boolean; note?: string }> {
  try {
    const response = await fetch(iconUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*', Referer: referer },
    });
    if (!response.ok) return { usable: false, note: `The icon URL returned ${response.status}.` };

    const head = new Uint8Array((await response.arrayBuffer()).slice(0, 256));
    const image = sniffImage(head);

    if (image.kind === 'SVG') {
      return { usable: true, note: 'The icon is an SVG and will be rasterised during the build.' };
    }
    if (image.usable) return { usable: true };
    if (image.kind === 'HTML') {
      return { usable: false, note: 'That icon URL returns a web page, not an image.' };
    }
    return { usable: false, note: 'That icon URL is not a recognisable image.' };
  } catch {
    return { usable: false, note: 'The icon could not be downloaded.' };
  }
}

interface PageLoad {
  html: string;
  finalUrl: URL;
  status?: number;
  error?: string;
  /** Which request profile produced this, for the log line. */
  profile?: string;
  /** True when the body is a bot-check interstitial rather than the real page. */
  challenged?: boolean;
}

/**
 * Fetches a page and keeps the body whatever the status says. Sites that gate
 * unknown clients still serve their og: tags on the interstitial — WhatsApp Web
 * answers a "use a supported browser" page that carries the real title,
 * description and image — so discarding a non-2xx body throws away the answer.
 */
async function fetchOnce(target: URL, headers: Record<string, string>): Promise<PageLoad> {
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
    });
    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    return { html, finalUrl: new URL(response.url || target.href), status: response.status };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      html: '',
      finalUrl: target,
      error: /abort|timeout/i.test(reason) ? 'the request timed out' : reason,
    };
  }
}

/**
 * Fetches a page, trying each request profile until one comes back with tags.
 * The body is kept whatever the status says: sites that gate unknown clients
 * still serve their og: tags on the interstitial, so discarding a non-2xx body
 * throws away the answer.
 */
async function loadPage(target: URL): Promise<PageLoad> {
  let best: PageLoad | undefined;

  for (const profile of FETCH_PROFILES) {
    const attempt = { ...(await fetchOnce(target, profile.headers)), profile: profile.label };
    attempt.challenged = Boolean(attempt.html) && CHALLENGE_PAGE.test(attempt.html);

    if (attempt.html && !attempt.challenged && CARRIES_METADATA.test(attempt.html)) return attempt;
    // Keep the most informative failure, preferring a real page over a challenge.
    const better =
      !best ||
      (best.challenged && !attempt.challenged) ||
      (best.challenged === attempt.challenged && attempt.html.length > best.html.length);
    if (better) best = attempt;
  }
  return best ?? { html: '', finalUrl: target, error: 'no response' };
}

interface Harvest {
  name?: string;
  description?: string;
  iconCandidate?: string;
  siteName?: string;
  themeColor?: string;
  fromManifest: boolean;
}

/** Pulls the interesting fields out of one page, manifest included. */
async function harvest(html: string, base: URL): Promise<Harvest> {
  const metas = tagsOf(html, 'meta');
  const links = tagsOf(html, 'link');
  const metaValue = (key: string) =>
    metas.find((tag) => (tag.name ?? tag.property ?? '').toLowerCase() === key)?.content || undefined;

  let manifest: WebAppManifest | undefined;
  const manifestHref = links.find((link) => relTokens(link).includes('manifest'))?.href;
  if (manifestHref) {
    try {
      const response = await fetch(new URL(manifestHref, base), {
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

  const name = manifest?.name || manifest?.short_name || (pageTitle ? decodeEntities(pageTitle) : undefined);

  return {
    name,
    description:
      manifest?.description ??
      metaValue('og:description') ??
      metaValue('twitter:description') ??
      metaValue('description'),
    iconCandidate:
      manifestIcon ?? iconLinks[0]?.href ?? metaValue('og:image') ?? metaValue('twitter:image'),
    siteName: metaValue('og:site_name'),
    themeColor: metaValue('theme-color'),
    fromManifest: Boolean(manifest?.name || manifest?.short_name),
  };
}

/** whatsapp.com for web.whatsapp.com — the marketing site usually has richer tags. */
export function apexOf(url: URL): URL | undefined {
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return undefined; // IP literal
  const labels = url.hostname.split('.');
  if (labels.length < 3) return undefined;
  const apex = new URL(url.href);
  apex.hostname = labels.slice(-2).join('.');
  apex.pathname = '/';
  apex.search = '';
  return apex;
}

export async function readSiteMetadata(rawUrl: string): Promise<SiteMetadata> {
  const target = assertFetchable(rawUrl);

  const page = await loadPage(target);
  // A challenge page's title is the challenge, not the app, so never read it.
  let found = page.challenged
    ? { fromManifest: false }
    : await harvest(page.html, page.finalUrl);
  let source: SiteMetadata['source'] = found.fromManifest ? 'manifest' : found.name ? 'page' : 'hostname';

  // Subdomain app shells often carry nothing useful; the apex marketing site
  // almost always does. Only worth a second request when the first came back thin.
  if (!found.name || !found.description) {
    const apex = apexOf(page.finalUrl);
    if (apex) {
      const apexPage = await loadPage(apex);
      // Same rule as the primary page: a bot check has a title, but it is not
      // the app's title.
      const apexFound = apexPage.challenged
        ? { fromManifest: false }
        : await harvest(apexPage.html, apexPage.finalUrl);
      if (apexFound.name || apexFound.description) {
        const usedApex = (!found.name && apexFound.name) || (!found.description && apexFound.description);
        found = {
          name: found.name ?? apexFound.name,
          description: found.description ?? apexFound.description,
          iconCandidate: found.iconCandidate ?? apexFound.iconCandidate,
          siteName: found.siteName ?? apexFound.siteName,
          themeColor: found.themeColor ?? apexFound.themeColor,
          fromManifest: found.fromManifest,
        };
        if (usedApex && source === 'hostname') source = 'apex';
      }
    }
  }

  let icon: string | undefined;
  try {
    icon = new URL(found.iconCandidate ?? '/favicon.ico', page.finalUrl).href;
  } catch {
    icon = undefined;
  }
  const iconCheck = icon
    ? await inspectIcon(icon, page.finalUrl.href)
    : { usable: false, note: 'No icon found.' };

  let fetchNote: string | undefined;
  if (page.challenged && !found.name && !found.description) {
    fetchNote = 'The site answered with a bot check, so its details could not be read.';
  } else if (!found.name && !found.description) {
    if (page.error) fetchNote = `Could not reach the page: ${page.error}.`;
    else if (page.status && page.status >= 400) {
      fetchNote = `The page answered ${page.status} to every request style tried.`;
    } else fetchNote = 'The page carried no title or description.';
  }

  return {
    url: page.finalUrl.href,
    name: cleanAppName(found.name ?? found.siteName ?? '', page.finalUrl.hostname),
    title: found.name,
    description: found.description?.slice(0, 300),
    icon,
    iconUsable: iconCheck.usable,
    iconNote: iconCheck.note,
    siteName: found.siteName,
    themeColor: found.themeColor,
    source,
    fetchStatus: page.status,
    fetchProfile: page.profile,
    fetchNote,
  };
}
