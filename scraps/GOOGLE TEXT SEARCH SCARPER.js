/**
 * Google Text Search & Scraper Module for Node.js
 * -------------------------------------------------------------
 * Standalone, zero-dependency scraper module for Google Search
 * Works on Node.js 18+ (uses native fetch)
 * 
 * Features:
 *  - Google Web / Text Search (Title, URL, Snippet, Display Domain)
 *  - Google Autocomplete / Search Suggestions
 *  - Google News Search (RSS Feed / Latest articles)
 *  - Supports Google Custom Search JSON API (if API key + CX provided)
 *  - Zero external dependencies
 */

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Perform an HTTP fetch with timeout and standard browser headers
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeout || 15000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': options.lang ? `${options.lang},en;q=0.9` : 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(options.headers || {})
      },
      ...options
    });

    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#8211;/g, '-')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Extract clean domain name from URL
 */
function extractDomain(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Google Text / Web Search
 * @param {string} query Search query keyword
 * @param {object} [options]
 * @param {number} [options.page=1] Page number (1-based)
 * @param {number} [options.num=10] Results count
 * @param {string} [options.hl='en'] Language code
 * @param {string} [options.gl='us'] Country code
 * @param {string} [options.apiKey] Google Custom Search API Key (optional)
 * @param {string} [options.cx] Google Custom Search Engine ID (optional)
 * @returns {Promise<Array<{title: string, link: string, snippet: string, domain: string}>>}
 */
async function search(query, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('Search query must be a non-empty string');
  }

  const apiKey = options.apiKey || process.env.GOOGLE_API_KEY;
  const cx = options.cx || process.env.GOOGLE_CX;

  // 1. If Official Custom Search API credentials are provided, use Google REST API
  if (apiKey && cx) {
    return searchViaCustomSearchApi(query, apiKey, cx, options);
  }

  // 2. Otherwise use Google Web Scraping
  return searchViaWebScraping(query, options);
}

/**
 * Search via Google Official Custom Search JSON API
 */
async function searchViaCustomSearchApi(query, apiKey, cx, options = {}) {
  const page = options.page || 1;
  const num = Math.min(options.num || 10, 10);
  const startIndex = (page - 1) * num + 1;
  const hl = options.hl || 'en';
  const gl = options.gl || 'us';

  const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&start=${startIndex}&num=${num}&hl=${hl}&gl=${gl}`;

  const res = await fetchWithTimeout(apiUrl, options);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Google API Error (HTTP ${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const items = data.items || [];

  return items.map(item => ({
    title: decodeHtmlEntities(item.title || ''),
    link: item.link || '',
    snippet: decodeHtmlEntities(item.snippet || ''),
    domain: item.displayLink || extractDomain(item.link || '')
  }));
}

/**
 * Search via Google HTML scraping
 */
async function searchViaWebScraping(query, options = {}) {
  const page = options.page || 1;
  const num = options.num || 10;
  const start = (page - 1) * num;
  const hl = options.hl || 'en';
  const gl = options.gl || 'us';

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${num}&start=${start}&hl=${hl}&gl=${gl}&pws=0`;

  const res = await fetchWithTimeout(searchUrl, {
    ...options,
    headers: {
      'Cookie': 'SOCS=CAESHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LKmBg; CONSENT=YES+',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    throw new Error(`Google Search HTTP error ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();
  const results = [];
  const seenLinks = new Set();

  // Pattern 1: Modern Google result items
  const blockRegex = /<div\s+class=["'][^"']*(?:MjjYud|g|tF2Cxc)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const blockHtml = blockMatch[1];
    const linkMatch = blockHtml.match(/<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/i);
    const titleMatch = blockHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const snippetMatch = blockHtml.match(/<div\s+[^>]*class=["'][^"']*(?:VwiC3b|yXK7lf|MUxGbd|s3v9rd)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

    if (linkMatch && titleMatch) {
      const link = linkMatch[1];
      const title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim());
      const snippet = snippetMatch ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

      if (link && !link.includes('google.com') && !seenLinks.has(link)) {
        seenLinks.add(link);
        results.push({
          title,
          link,
          snippet,
          domain: extractDomain(link)
        });
      }
    }
  }

  // Pattern 2: Fallback direct link + h3 search
  if (results.length === 0) {
    const directRegex = /<a\s+[^>]*href=["'](https?:\/\/(?!www\.google\.|maps\.google\.|support\.google\.|accounts\.google\.)[^"']+)["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let dm;
    while ((dm = directRegex.exec(html)) !== null) {
      const link = dm[1];
      const title = decodeHtmlEntities(dm[2].replace(/<[^>]+>/g, '').trim());

      if (link && !seenLinks.has(link)) {
        seenLinks.add(link);
        results.push({
          title,
          link,
          snippet: '',
          domain: extractDomain(link)
        });
      }
    }
  }

  // Pattern 3: Fallback /url?q= extraction
  if (results.length === 0) {
    const urlRegex = /<a[^>]+href=["']\/url\?q=([^"&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let um;
    while ((um = urlRegex.exec(html)) !== null) {
      const rawUrl = decodeURIComponent(um[1]);
      const inner = um[2];

      if (rawUrl.startsWith('http') && !rawUrl.includes('google.com') && !seenLinks.has(rawUrl)) {
        const titleMatch = inner.match(/<div[^>]*class=["'][^"']*vvjwJb[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
                        || inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
        const title = decodeHtmlEntities((titleMatch ? titleMatch[1] : inner).replace(/<[^>]+>/g, '').trim());

        if (title && !title.includes('Google')) {
          seenLinks.add(rawUrl);
          results.push({
            title,
            link: rawUrl,
            snippet: '',
            domain: extractDomain(rawUrl)
          });
        }
      }
    }
  }

  return results;
}

/**
 * Get Google Autocomplete / Search Suggestions
 * @param {string} query Search prefix keyword
 * @param {object} [options]
 * @param {string} [options.hl='en'] Language code
 * @returns {Promise<string[]>} Array of suggested query strings
 */
async function suggest(query, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('Query must be a non-empty string');
  }

  const hl = options.hl || 'en';
  const url = `https://suggestqueries.google.com/complete/search?client=chrome&hl=${hl}&q=${encodeURIComponent(query)}`;

  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    throw new Error(`Google Suggestions HTTP error: ${res.status}`);
  }

  const data = await res.json();
  return Array.isArray(data[1]) ? data[1] : [];
}

/**
 * Search Google News (RSS Feed) for real-time news articles
 * @param {string} query Search topic / query
 * @param {object} [options]
 * @param {string} [options.hl='en'] Language code (e.g. 'en', 'si')
 * @param {string} [options.gl='US'] Country code (e.g. 'US', 'LK')
 * @returns {Promise<Array<{title: string, link: string, pubDate: string, source: string}>>}
 */
async function searchNews(query, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('Query must be a non-empty string');
  }

  const hl = options.hl || 'en';
  const gl = options.gl || 'US';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl}`;

  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    throw new Error(`Google News HTTP error: ${res.status}`);
  }

  const xml = await res.text();
  const items = [];

  const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?(?:<source[^>]*url=["']([^"']*)["'][^>]*>([\s\S]*?)<\/source>)?[\s\S]*?<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const rawTitle = match[1] || '';
    const link = match[2] || '';
    const pubDate = match[3] || '';
    const source = match[5] ? decodeHtmlEntities(match[5].replace(/<[^>]+>/g, '').trim()) : '';

    items.push({
      title: decodeHtmlEntities(rawTitle),
      link,
      pubDate,
      source
    });
  }

  return items;
}

module.exports = {
  search,
  suggest,
  searchNews
};
