/**
 * Anime Character & Image Scraper Module for Node.js
 * -------------------------------------------------------------
 * Standalone, zero-dependency module for Anime Character information,
 * official portrait images, wallpapers, fanart galleries, and downloads.
 * Works on Node.js 18+ (uses native fetch)
 * 
 * Features:
 *  - searchCharacter(name, options): Character info, Japanese name, Bio, Official High-Res Images & Anime titles (AniList GraphQL)
 *  - getCharacterGallery(characterName, options): High-Res Wallpapers, Fanarts & Gallery Images (Safebooru / Konachan)
 *  - getRandomAnimeImages(tag, options): Random anime character wallpapers and illustrations
 *  - downloadImage(imageUrl, outputPath): Directly download any anime image to local disk
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Clean Markdown/HTML tags from biography text
 */
function cleanDescription(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/~![\s\S]*?!~/g, '') // Remove spoiler tags
    .replace(/__([^_]+)__/g, '$1') // Remove bold markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Clean tags for image boards (spaces to underscores, lowercase)
 */
function sanitizeTag(tag) {
  if (!tag) return '';
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, '')
    .replace(/\s+/g, '_');
}

/**
 * 1. Search Anime Character by Name
 * Returns official high-res character images, names, bio, gender, and anime series list.
 * 
 * @param {string} characterName (e.g. 'Gojo Satoru', 'Naruto Uzumaki', 'Mikasa Ackerman', 'Luffy')
 * @param {object} [options]
 * @param {number} [options.page=1] Page number
 * @param {number} [options.per_page=5] Number of results to return
 * @returns {Promise<Array<{
 *   id: number,
 *   name: { full: string, native: string, alternatives: string[] },
 *   image: { large: string, medium: string },
 *   anime: { english: string, romaji: string, native: string },
 *   description: string,
 *   gender: string|null,
 *   birthday: string|null,
 *   media: Array<{ title: string, coverImage: string, format: string }>
 * }>>}
 */
async function searchCharacter(characterName, options = {}) {
  if (!characterName || typeof characterName !== 'string') {
    throw new Error('characterName must be a non-empty string');
  }

  const page = options.page || 1;
  const perPage = options.per_page || 5;

  const query = `
    query ($search: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          total
          currentPage
          hasNextPage
        }
        characters(search: $search) {
          id
          name {
            full
            native
            alternative
          }
          image {
            large
            medium
          }
          description
          gender
          dateOfBirth {
            year
            month
            day
          }
          media(page: 1, perPage: 3, sort: POPULARITY_DESC) {
            nodes {
              id
              title {
                romaji
                english
                native
              }
              coverImage {
                large
              }
              format
              type
            }
          }
        }
      }
    }
  `;

  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': DEFAULT_USER_AGENT
    },
    body: JSON.stringify({
      query,
      variables: {
        search: characterName,
        page,
        perPage
      }
    })
  });

  if (!res.ok) {
    throw new Error(`AniList API error: HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const characters = json.data?.Page?.characters || [];

  return characters.map(char => {
    const mainMedia = char.media?.nodes?.[0];
    const birthdayStr = char.dateOfBirth?.month && char.dateOfBirth?.day 
      ? `${char.dateOfBirth.month}/${char.dateOfBirth.day}${char.dateOfBirth.year ? '/' + char.dateOfBirth.year : ''}`
      : null;

    return {
      id: char.id,
      name: {
        full: char.name?.full || '',
        native: char.name?.native || '',
        alternatives: char.name?.alternative || []
      },
      image: {
        large: char.image?.large || null,
        medium: char.image?.medium || null
      },
      anime: mainMedia ? {
        english: mainMedia.title?.english || mainMedia.title?.romaji || '',
        romaji: mainMedia.title?.romaji || '',
        native: mainMedia.title?.native || ''
      } : null,
      description: cleanDescription(char.description),
      gender: char.gender || null,
      birthday: birthdayStr,
      media: (char.media?.nodes || []).map(m => ({
        id: m.id,
        title: m.title?.english || m.title?.romaji || '',
        coverImage: m.coverImage?.large || null,
        format: m.format || 'ANIME'
      }))
    };
  });
}

/**
 * 2. Get Character Gallery / Wallpapers / Fanart Images
 * Fetches high-resolution images & fanarts for the given character name from image boards.
 * 
 * @param {string} characterName (e.g. 'gojo_satoru', 'naruto', 'luffy', 'rem', 'zero_two')
 * @param {object} [options]
 * @param {number} [options.limit=10] Max images to return
 * @param {number} [options.page=1] Page number
 * @returns {Promise<Array<{
 *   id: string|number,
 *   image_url: string,
 *   sample_url: string,
 *   preview_url: string,
 *   width: number,
 *   height: number,
 *   tags: string,
 *   source: string
 * }>>}
 */
async function getCharacterGallery(characterName, options = {}) {
  if (!characterName || typeof characterName !== 'string') {
    throw new Error('characterName must be a non-empty string');
  }

  const limit = options.limit || 10;
  const page = options.page || 1;
  const tag = sanitizeTag(characterName);
  const results = [];

  // Source 1: Safebooru (High Quality SFW Anime Character Images)
  try {
    const safeUrl = `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(tag)}&pid=${page - 1}&limit=${limit}`;
    const safeRes = await fetch(safeUrl, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT }
    });

    if (safeRes.ok) {
      const items = await safeRes.json();
      if (Array.isArray(items)) {
        for (const item of items) {
          results.push({
            id: item.id,
            image_url: `https://safebooru.org/images/${item.directory}/${item.image}`,
            sample_url: `https://safebooru.org/samples/${item.directory}/sample_${item.image}`,
            preview_url: `https://safebooru.org/thumbnails/${item.directory}/thumbnail_${item.image}`,
            width: parseInt(item.width, 10) || 0,
            height: parseInt(item.height, 10) || 0,
            tags: item.tags || '',
            source: 'Safebooru'
          });
        }
      }
    }
  } catch (e) {
    // Safebooru fallback
  }

  // Source 2: Konachan (Anime Wallpapers / Illustrations)
  if (results.length < limit) {
    try {
      const remaining = limit - results.length;
      const konaUrl = `https://konachan.net/post.json?tags=rating:s+${encodeURIComponent(tag)}&page=${page}&limit=${remaining}`;
      const konaRes = await fetch(konaUrl, {
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      });

      if (konaRes.ok) {
        const items = await konaRes.json();
        if (Array.isArray(items)) {
          for (const item of items) {
            results.push({
              id: item.id,
              image_url: item.file_url || item.jpeg_url,
              sample_url: item.sample_url || item.file_url,
              preview_url: item.preview_url,
              width: item.width || 0,
              height: item.height || 0,
              tags: item.tags || '',
              source: 'Konachan'
            });
          }
        }
      }
    } catch (e) {
      // Konachan fallback
    }
  }

  return results;
}

/**
 * 3. Get Random Anime Wallpapers / Illustrations by Tag
 * @param {string} [tag='wallpaper'] Tag (e.g. 'girl', 'boy', 'landscape', 'cyberpunk', 'cat_ears')
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @returns {Promise<Array>}
 */
async function getRandomAnimeImages(tag = 'wallpaper', options = {}) {
  const limit = options.limit || 10;
  const sanitized = sanitizeTag(tag);
  return getCharacterGallery(sanitized, { limit, page: Math.floor(Math.random() * 5) + 1 });
}

/**
 * 4. Download any Anime Image to local disk
 * @param {string} imageUrl URL of image to download
 * @param {string} outputFilePath Destination path (e.g. './downloads/gojo.jpg')
 * @param {Function} [onProgress] Progress callback (receivedBytes, totalBytes)
 * @returns {Promise<{savedTo: string, sizeBytes: number}>}
 */
async function downloadImage(imageUrl, outputFilePath, onProgress) {
  if (!imageUrl || !outputFilePath) {
    throw new Error('imageUrl and outputFilePath are required');
  }

  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT }
  });

  if (!res.ok) {
    throw new Error(`Failed to download image: HTTP ${res.status} ${res.statusText}`);
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
  searchCharacter,
  getCharacterGallery,
  getRandomAnimeImages,
  downloadImage
};
