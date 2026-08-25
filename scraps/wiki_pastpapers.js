/**
 * PastPapers.wiki All-in-One Scraper for Node.js
 * -------------------------------------------------------------
 * Standalone, zero-dependency scraper module for https://pastpapers.wiki/
 * Supports ALL Papers:
 *  - Grade 5 Scholarship (ශිෂ්‍යත්ව)
 *  - G.C.E. O/L (සාමාන්‍ය පෙළ - Grade 10 & 11)
 *  - G.C.E. A/L (උසස් පෙළ - Grade 12 & 13)
 *  - Provincial & School Term Test Papers (Grade 1 to 13 - All Provinces)
 *  - Marking Schemes & Model Papers
 *  - School Textbooks (Grade 1 to 11)
 *  - Mediums: Sinhala, Tamil, English
 * 
 * Works on Node.js 18+ (uses native fetch)
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://pastpapers.wiki';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
 * Clean and format raw WP Post/Page item
 */
function formatWpItem(item, type = 'post') {
  const featuredImg = item._embedded?.['wp:featuredmedia']?.[0]?.source_url 
                   || item._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.full?.source_url 
                   || null;

  const rawExcerpt = item.excerpt?.rendered ? item.excerpt.rendered.replace(/<[^>]+>/g, '').trim() : '';

  return {
    id: item.id,
    type: type,
    title: decodeHtmlEntities(item.title?.rendered || ''),
    url: item.link,
    slug: item.slug,
    date: item.date,
    image: featuredImg,
    excerpt: decodeHtmlEntities(rawExcerpt)
  };
}

/**
 * Universal Search across ALL Past Papers, O/L, A/L, Scholarship, and Term Tests
 * Searches both WP Posts and WP Pages in parallel with optional filtering.
 * 
 * @param {string} query Search keyword (e.g. 'grade 5 scholarship', 'o/l science', 'grade 11 mathematics', 'western province term test')
 * @param {object} [options]
 * @param {number} [options.page=1] Page number
 * @param {number} [options.per_page=10] Results per page
 * @param {string} [options.grade] Filter by grade (e.g. '5', '10', '11', '12', '13', 'scholarship', 'ol', 'al')
 * @param {string} [options.medium] Filter by medium ('sinhala' | 'english' | 'tamil')
 * @param {string} [options.category] Specific category ID or slug
 * @returns {Promise<Array<{id: number, type: string, title: string, url: string, date: string, image: string|null, excerpt: string}>>}
 */
async function search(query, options = {}) {
  let searchQuery = query || '';
  
  // Combine filters into query if specified
  if (options.grade) searchQuery += ` grade ${options.grade}`;
  if (options.medium) searchQuery += ` ${options.medium} medium`;
  if (options.subject) searchQuery += ` ${options.subject}`;

  searchQuery = searchQuery.trim();
  if (!searchQuery) {
    throw new Error('Search query must be provided');
  }

  const page = options.page || 1;
  const perPage = options.per_page || 10;

  const postsUrl = `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(searchQuery)}&page=${page}&per_page=${perPage}&_embed`;
  const pagesUrl = `${BASE_URL}/wp-json/wp/v2/pages?search=${encodeURIComponent(searchQuery)}&page=${page}&per_page=${Math.min(perPage, 10)}&_embed`;

  try {
    const [postsRes, pagesRes] = await Promise.all([
      fetchHtml(postsUrl, options).catch(() => null),
      fetchHtml(pagesUrl, options).catch(() => null)
    ]);

    const results = [];
    const seenUrls = new Set();

    // 1. Process Posts
    if (postsRes && postsRes.ok) {
      const postsData = await postsRes.json();
      if (Array.isArray(postsData)) {
        for (const p of postsData) {
          if (!seenUrls.has(p.link)) {
            seenUrls.add(p.link);
            results.push(formatWpItem(p, 'post'));
          }
        }
      }
    }

    // 2. Process Pages (Hubs, Subject Index Pages)
    if (pagesRes && pagesRes.ok) {
      const pagesData = await pagesRes.json();
      if (Array.isArray(pagesData)) {
        for (const p of pagesData) {
          if (!seenUrls.has(p.link)) {
            seenUrls.add(p.link);
            results.push(formatWpItem(p, 'page'));
          }
        }
      }
    }

    return results;
  } catch (error) {
    return [];
  }
}

/**
 * 1. Get Grade 5 Scholarship Papers (ශිෂ්‍යත්ව විභාග ප්‍රශ්න පත්‍ර)
 * @param {object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.per_page=10]
 * @param {string} [options.type='all'] 'all' | 'past_papers' | 'model_papers' | 'term_test'
 * @param {string} [options.medium] 'sinhala' | 'tamil'
 */
async function getScholarshipPapers(options = {}) {
  let q = 'scholarship';
  if (options.type === 'model_papers') q = 'scholarship model paper';
  else if (options.type === 'term_test') q = 'grade 5 term test paper';
  else if (options.type === 'past_papers') q = 'grade 5 scholarship exam past paper';

  if (options.medium) q += ` ${options.medium} medium`;
  return search(q, options);
}

/**
 * 2. Get G.C.E. O/L Past Papers & Marking Schemes (සාමාන්‍ය පෙළ)
 * @param {object} [options]
 * @param {string} [options.subject] Subject name (e.g. 'science', 'mathematics', 'history', 'english', 'commerce', 'sinhala')
 * @param {string} [options.year] Exam year (e.g. '2023', '2024', '2022')
 * @param {string} [options.medium] 'sinhala' | 'english' | 'tamil'
 * @param {boolean} [options.markingScheme=false] Set true to get marking schemes
 */
async function getOLPapers(options = {}) {
  let q = 'O/L';
  if (options.markingScheme) q += ' marking scheme';
  else q += ' past paper';

  if (options.subject) q += ` ${options.subject}`;
  if (options.year) q += ` ${options.year}`;
  if (options.medium) q += ` ${options.medium} medium`;

  return search(q, options);
}

/**
 * 3. Get G.C.E. A/L Past Papers & Marking Schemes (උසස් පෙළ)
 * @param {object} [options]
 * @param {string} [options.subject] Subject (e.g. 'biology', 'combined mathematics', 'physics', 'chemistry', 'accounting', 'ict', 'economics')
 * @param {string} [options.year] Exam year (e.g. '2026', '2025', '2024', '2023')
 * @param {string} [options.medium] 'sinhala' | 'english' | 'tamil'
 * @param {boolean} [options.markingScheme=false] Set true for marking schemes
 */
async function getALPapers(options = {}) {
  let q = 'A/L';
  if (options.markingScheme) q += ' marking scheme';
  else q += ' past paper';

  if (options.subject) q += ` ${options.subject}`;
  if (options.year) q += ` ${options.year}`;
  if (options.medium) q += ` ${options.medium} medium`;

  return search(q, options);
}

/**
 * 4. Get Provincial / School Term Test Papers (වාර විභාග ප්‍රශ්න පත්‍ර - Grade 1 to 13)
 * @param {number|string} grade Grade number (e.g. 6, 7, 8, 9, 10, 11, 12, 13)
 * @param {object} [options]
 * @param {string} [options.province] 'western' | 'southern' | 'central' | 'north western' | 'sabaragamuwa' | 'north central'
 * @param {string} [options.subject] Subject name
 * @param {string} [options.term] Term number ('1st term', '2nd term', '3rd term')
 * @param {string} [options.medium] 'sinhala' | 'english' | 'tamil'
 */
async function getTermTestPapers(grade, options = {}) {
  const gStr = String(grade).padStart(2, '0');
  let q = `grade ${gStr} term test paper`;

  if (options.province) q = `${options.province} province ${q}`;
  if (options.term) q += ` ${options.term}`;
  if (options.subject) q += ` ${options.subject}`;
  if (options.medium) q += ` ${options.medium} medium`;

  return search(q, options);
}

/**
 * 5. Get School Textbooks (පාසල් පෙළපොත් - Grade 1 to 11)
 * @param {number|string} [grade] Grade number (e.g. 6, 7, 8, 9, 10, 11)
 * @param {object} [options]
 * @param {string} [options.subject] Subject name
 * @param {string} [options.medium] 'sinhala' | 'english' | 'tamil'
 */
async function getTextbooks(grade, options = {}) {
  let q = 'textbook free download';
  if (grade) {
    const gStr = String(grade).padStart(2, '0');
    q = `grade ${gStr} ${q}`;
  }
  if (options.subject) q += ` ${options.subject}`;
  if (options.medium) q += ` ${options.medium} medium`;

  return search(q, options);
}

/**
 * Scrape all details, metadata, preview images and DOWNLOAD LINKS from any pastpapers.wiki URL
 * Works on single paper posts AND hub/index pages.
 * 
 * @param {string} postUrl Full URL or post slug
 * @param {object} [options]
 * @returns {Promise<{
 *   title: string,
 *   url: string,
 *   date: string|null,
 *   image: string|null,
 *   description: string,
 *   metadata: Record<string, string>,
 *   preview_images: Array<{src: string, caption: string}>,
 *   downloads: Array<{title: string, url: string, preview_url: string|null, type: string}>,
 *   sub_links: Array<{title: string, url: string}>
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
      
    contentHtml = endMarker !== -1 ? html.substring(startMarker, endMarker) : html.substring(startMarker, startMarker + 40000);
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

  // 8. Extract Download Links & Hub sub-links
  const downloads = [];
  const subLinks = [];
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
    } else if (href.startsWith(BASE_URL) && !href.includes('/category/') && !href.includes('/tag/') && text.length > 3) {
      // Hub sub-links (e.g. subject links on a grade hub page)
      seenUrls.add(href);
      subLinks.push({
        title: text,
        url: href
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
    downloads,
    sub_links_count: subLinks.length,
    sub_links: subLinks
  };
}

/**
 * Search and instantly scrape download links for top matches
 * @param {string} query Search query
 * @param {number} [limit=3]
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

module.exports = {
  search,
  getScholarshipPapers,
  getOLPapers,
  getALPapers,
  getTermTestPapers,
  getTextbooks,
  getPostDetails,
  searchAndGetDownloads,
  downloadFile,
  BASE_URL
};
