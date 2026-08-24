/**
 * PastPapers.wiki Scraper for Node.js
 * -------------------------------------------------------------
 * Standalone, zero-dependency scraper module for https://pastpapers.wiki/
 * Works on Node.js 18+ (uses native fetch)
 * 
 * Features:
 *  - Search past papers, model papers, marking schemes
 *  - Scrape direct PDF download links, Google Drive links & preview links
 *  - Scrape post metadata (Exam, Grade, Subject, Medium, Year, Preview Images)
 *  - Get latest past papers & category listings
 *  - Helper to directly download PDF files to local disk
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://pastpapers.wiki';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Perform an HTTP fetch with default headers & timeout
 */
async function fetchHtml(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeout || 15000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
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
 * Decode HTML entities like &#8211;, &amp;, etc.
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
    .replace(/&#x3D;/g, '=')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Search pastpapers.wiki by query keyword
 * @param {string} query Search keyword (e.g., '2023 physics', 'scholarship', 'grade 11 science')
 * @param {object} [options]
 * @param {number} [options.page=1] Page number
 * @param {number} [options.per_page=10] Results per page (max 100)
 * @returns {Promise<Array<{id: number, title: string, url: string, date: string, image: string|null, excerpt: string}>>}
 */
async function search(query, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('Search query must be a non-empty string');
  }

  const page = options.page || 1;
  const perPage = options.per_page || 10;
  const apiUrl = `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}&_embed`;

  try {
    const res = await fetchHtml(apiUrl, options);
    
    if (res.status === 400 || res.status === 404) {
      return []; // No more pages or results
    }

    if (!res.ok) {
      throw new Error(`Failed to search: HTTP ${res.status} ${res.statusText}`);
    }

    const posts = await res.json();
    if (!Array.isArray(posts)) return [];

    return posts.map(post => {
      const featuredImg = post._embedded?.['wp:featuredmedia']?.[0]?.source_url 
                       || post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.full?.source_url 
                       || null;

      const rawExcerpt = post.excerpt?.rendered ? post.excerpt.rendered.replace(/<[^>]+>/g, '').trim() : '';

      return {
        id: post.id,
        title: decodeHtmlEntities(post.title?.rendered || ''),
        url: post.link,
        slug: post.slug,
        date: post.date,
        image: featuredImg,
        excerpt: decodeHtmlEntities(rawExcerpt)
      };
    });
  } catch (error) {
    // Fallback: If REST API is blocked or restricted, parse search HTML
    return fallbackHtmlSearch(query, page, options);
  }
}

/**
 * Fallback search parser using standard WordPress search HTML
 */
async function fallbackHtmlSearch(query, page = 1, options = {}) {
  const searchUrl = `${BASE_URL}/page/${page}/?s=${encodeURIComponent(query)}`;
  const res = await fetchHtml(searchUrl, options);
  if (!res.ok) return [];

  const html = await res.text();
  const results = [];
  const articleRegex = /<article[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRegex.exec(html)) !== null) {
    const articleHtml = match[2];

    const titleMatch = articleHtml.match(/<h2[^>]*class=["'][^"']*jeg_post_title[^"']*["'][^>]*>\s*<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
                    || articleHtml.match(/<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    
    const postUrl = titleMatch ? titleMatch[1] : null;
    const postTitle = titleMatch ? decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, '')) : '';

    const imgMatch = articleHtml.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
    const postImg = imgMatch ? imgMatch[1] : null;

    const dateMatch = articleHtml.match(/<div class=["']jeg_meta_date["']>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const postDate = dateMatch ? dateMatch[1].replace(/<[^>]+>/g, '').trim() : null;

    if (postUrl && postTitle) {
      results.push({
        id: null,
        title: postTitle,
        url: postUrl,
        slug: postUrl.replace(BASE_URL, '').replace(/^\/|\/$/g, ''),
        date: postDate,
        image: postImg,
        excerpt: ''
      });
    }
  }

  return results;
}

/**
 * Get latest uploaded papers
 * @param {object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.per_page=10]
 * @returns {Promise<Array>}
 */
async function getLatest(options = {}) {
  const page = options.page || 1;
  const perPage = options.per_page || 10;
  const apiUrl = `${BASE_URL}/wp-json/wp/v2/posts?page=${page}&per_page=${perPage}&_embed`;

  const res = await fetchHtml(apiUrl, options);
  if (!res.ok) {
    throw new Error(`Failed to fetch latest posts: HTTP ${res.status}`);
  }

  const posts = await res.json();
  if (!Array.isArray(posts)) return [];

  return posts.map(post => {
    const featuredImg = post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null;
    return {
      id: post.id,
      title: decodeHtmlEntities(post.title?.rendered || ''),
      url: post.link,
      slug: post.slug,
      date: post.date,
      image: featuredImg,
      excerpt: decodeHtmlEntities((post.excerpt?.rendered || '').replace(/<[^>]+>/g, '').trim())
    };
  });
}

/**
 * Scrape all details, metadata, preview images and DOWNLOAD LINKS from a pastpapers.wiki post URL
 * @param {string} postUrl Full URL or post slug (e.g. 'https://pastpapers.wiki/2026-al-agricultural-science-past-paper-sinhala-medium/')
 * @param {object} [options]
 * @returns {Promise<{
 *   title: string,
 *   url: string,
 *   date: string|null,
 *   image: string|null,
 *   description: string,
 *   metadata: Record<string, string>,
 *   preview_images: Array<{src: string, caption: string}>,
 *   downloads: Array<{title: string, url: string, preview_url: string|null, type: string}>
 * }>}
 */
async function getPostDetails(postUrl, options = {}) {
  let targetUrl = postUrl;
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = `${BASE_URL}/${targetUrl.replace(/^\//, '')}`;
  }

  const res = await fetchHtml(targetUrl, options);
  if (!res.ok) {
    throw new Error(`Failed to fetch post (${targetUrl}): HTTP ${res.status} ${res.statusText}`);
  }

  const html = await res.text();

  // 1. Title
  const titleMatch = html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)
                  || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
                  || html.match(/<title>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  const title = decodeHtmlEntities(rawTitle.replace(/\s*-\s*Past Papers WiKi.*$/i, '').replace(/\s*\|\s*Past Papers WiKi.*$/i, '').trim());

  // 2. Featured Image
  const ogImgMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
                  || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
  const featuredImage = ogImgMatch ? ogImgMatch[1] : null;

  // 3. Published Date
  const dateMatch = html.match(/<meta\s+property=["']article:published_time["']\s+content=["']([^"']+)["']/i)
                 || html.match(/<time[^>]*class=["'][^"']*entry-date[^"']*["'][^>]*datetime=["']([^"']+)["']/i);
  const date = dateMatch ? dateMatch[1] : null;

  // 4. Description / Excerpt
  const descMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)
                 || html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  const description = descMatch ? decodeHtmlEntities(descMatch[1].trim()) : '';

  // 5. Extract Content Area (isolate from navbars/sidebars/footers)
  let contentHtml = html;
  const startMarker = html.indexOf('<div class="content-inner');
  if (startMarker !== -1) {
    const endMarker = html.indexOf('<div class="jeg_share_bottom', startMarker) !== -1 
      ? html.indexOf('<div class="jeg_share_bottom', startMarker)
      : html.indexOf('</article>', startMarker);
      
    contentHtml = endMarker !== -1 ? html.substring(startMarker, endMarker) : html.substring(startMarker, startMarker + 35000);
  }

  // 6. Extract Metadata (Exam, Grade, Subject, Medium, Year, etc.)
  const metadata = {};
  const metaRegex = /<li>\s*<strong[^>]*>([^<:]+)[:\s–-]*<\/strong>[\s–-]*([^<]+)<\/li>/gi;
  let mm;
  while ((mm = metaRegex.exec(contentHtml)) !== null) {
    const key = decodeHtmlEntities(mm[1]).replace(/[:–-]/g, '').trim();
    const val = decodeHtmlEntities(mm[2]).replace(/^–\s*/, '').trim();
    if (key && val) {
      metadata[key] = val;
    }
  }

  // 7. Extract Preview Images
  const previewImages = [];
  const imgRegex = /<figure[^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*>[\s\S]*?(?:<figcaption[^>]*>([\s\S]*?)<\/figcaption>)?[\s\S]*?<\/figure>/gi;
  let im;
  while ((im = imgRegex.exec(contentHtml)) !== null) {
    const src = im[1];
    const caption = im[2] ? decodeHtmlEntities(im[2].replace(/<[^>]+>/g, '').trim()) : '';
    if (!src.includes('Join-Whatsapp') && !src.includes('forum-scaled') && !src.includes('banner')) {
      previewImages.push({ src, caption });
    }
  }

  // 8. Extract Download Links
  const downloads = [];
  const seenUrls = new Set();

  // Method A: Structured wpfd download blocks
  const wpfdRegex = /<div class="wpfd-single-file">([\s\S]*?)<\/div>\s*<\/div>/gi;
  let wm;
  while ((wm = wpfdRegex.exec(contentHtml)) !== null) {
    const blockHtml = wm[1];
    const dlBtnMatch = blockHtml.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*wpfd-button-download[^"']*["'][^>]*>/i)
                    || blockHtml.match(/<a\s+[^>]*class=["'][^"']*wpfd-button-download[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i)
                    || blockHtml.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']*)["'][^>]*>/i);

    if (dlBtnMatch) {
      const rawDlUrl = dlBtnMatch[1].replace(/&#x3D;/g, '=').replace(/&amp;/g, '&');
      const titleAttr = blockHtml.match(/title=["']([^"']+)["']/i)?.[1] || title;
      
      const prevBtnMatch = blockHtml.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*wpfd-button-preview[^"']*["'][^>]*>/i);
      const previewUrl = prevBtnMatch ? prevBtnMatch[1].replace(/&#x3D;/g, '=').replace(/&amp;/g, '&') : null;

      if (!seenUrls.has(rawDlUrl)) {
        seenUrls.add(rawDlUrl);
        downloads.push({
          title: decodeHtmlEntities(titleAttr),
          url: rawDlUrl,
          preview_url: previewUrl,
          type: 'pdf_direct'
        });
      }
    }
  }

  // Method B: General download links across content
  const aRegex = /<a\s+([^>]+)>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = aRegex.exec(contentHtml)) !== null) {
    const attrs = am[1];
    const text = decodeHtmlEntities(am[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    const href = hrefMatch ? hrefMatch[1].replace(/&#x3D;/g, '=').replace(/&amp;/g, '&') : '';

    if (!href || href === '#' || href.startsWith('javascript:') || seenUrls.has(href)) continue;

    // Filter out external ads, socials and shopping links
    if (/facebook\.com|twitter\.com|whatsapp\.com|pinterest\.com|t\.me|forum\.pastpapers\.wiki|lol\.lk|doenets\.lk|linkedin\.com/i.test(href)) {
      continue;
    }

    const isDownload = href.includes('/download/') ||
                       href.includes('drive.google.com') ||
                       href.includes('mediafire.com') ||
                       href.includes('mega.nz') ||
                       href.endsWith('.pdf') ||
                       href.includes('.pdf?') ||
                       attrs.includes('wpfd_downloadlink') ||
                       attrs.includes('wpfd-button-download');

    if (isDownload) {
      seenUrls.add(href);
      const titleAttr = attrs.match(/title=["']([^"']+)["']/i)?.[1];
      
      let type = 'direct';
      if (href.includes('drive.google.com')) type = 'google_drive';
      else if (href.includes('mediafire.com')) type = 'mediafire';
      else if (href.includes('mega.nz')) type = 'mega';
      else if (href.includes('/download/')) type = 'pdf_direct';
      else if (href.endsWith('.pdf')) type = 'pdf_file';

      downloads.push({
        title: decodeHtmlEntities(titleAttr || text || 'Download Paper'),
        url: href,
        preview_url: null,
        type: type
      });
    }
  }

  return {
    title,
    url: targetUrl,
    date,
    image: featuredImage,
    description,
    metadata,
    preview_images: previewImages,
    downloads_count: downloads.length,
    downloads
  };
}

/**
 * Search and instantly scrape download links for top matches
 * @param {string} query Search query
 * @param {number} [limit=3] How many matching posts to scrape downloads for
 * @returns {Promise<Array>}
 */
async function searchAndGetDownloads(query, limit = 3) {
  const searchResults = await search(query, { per_page: limit });
  const resultsWithDownloads = [];

  for (const item of searchResults) {
    try {
      const details = await getPostDetails(item.url);
      resultsWithDownloads.push(details);
    } catch (err) {
      resultsWithDownloads.push({
        ...item,
        downloads: [],
        error: err.message
      });
    }
  }

  return resultsWithDownloads;
}

/**
 * Download a PDF file from a direct download URL and save to disk
 * @param {string} downloadUrl Direct download URL
 * @param {string} outputFilePath Destination path (e.g. './downloads/paper.pdf')
 * @param {Function} [onProgress] Progress callback (receivedBytes, totalBytes)
 * @returns {Promise<{savedTo: string, sizeBytes: number}>}
 */
async function downloadFile(downloadUrl, outputFilePath, onProgress) {
  const res = await fetchHtml(downloadUrl);
  if (!res.ok) {
    throw new Error(`Failed to download file: HTTP ${res.status} ${res.statusText}`);
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const dir = path.dirname(outputFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fileStream = fs.createWriteStream(outputFilePath);
  let receivedBytes = 0;

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
      receivedBytes += value.length;
      if (typeof onProgress === 'function') {
        onProgress(receivedBytes, contentLength);
      }
    }
    fileStream.end();
  } else {
    // Fallback arrayBuffer
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    fs.writeFileSync(outputFilePath, buf);
    receivedBytes = buf.length;
    if (typeof onProgress === 'function') {
      onProgress(receivedBytes, receivedBytes);
    }
  }

  return new Promise((resolve, reject) => {
    fileStream.on('finish', () => resolve({ savedTo: outputFilePath, sizeBytes: receivedBytes }));
    fileStream.on('error', reject);
    if (fileStream.closed) {
      resolve({ savedTo: outputFilePath, sizeBytes: receivedBytes });
    }
  });
}

// CommonJS and ES Module exports
module.exports = {
  search,
  getLatest,
  getPostDetails,
  searchAndGetDownloads,
  downloadFile,
  BASE_URL
};
