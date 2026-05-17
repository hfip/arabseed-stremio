// addon.js
const cheerio = require('cheerio');
const { manifest } = require('./manifest');

const GOOGLE_PROXY_URL = "https://script.google.com/macros/s/AKfycbwzwsaeYrNMVo39ot5D2ah72SWsN1NaKa-_0yagRowbZNnByWwBiu94mO6mAUjwVGhSrQ/exec";
const BASE_URL = 'https://m.asd.ink';

// ذاكرة الكاش الداخلية لتسريع الاستجابة على Vercel
const cache = new Map();
const CACHE_TTL = 20 * 60 * 1000;

const getCache = (key) => {
  const item = cache.get(key);
  if (item && Date.now() - item.time < CACHE_TTL) return item.data;
  cache.delete(key);
  return null;
};

const setCache = (key, data) => {
  cache.set(key, { data, time: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
};

// طلب البيانات عبر البروكسي الآمن من جوجل
async function fetchViaProxy(action, targetUrl = '', searchQuery = '') {
  try {
    let proxyUrl = `${GOOGLE_PROXY_URL}?action=${action}`;
    if (action === 'search') proxyUrl += `&q=${encodeURIComponent(searchQuery)}`;
    else if (action === 'get_links') proxyUrl += `&url=${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500); // 8.5 ثوانٍ تايم اوت تكتيكي

    const response = await fetch(proxyUrl, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return new TextDecoder('utf-8').decode(buffer);
  } catch (err) {
    return null;
  }
}

// 1. معالج معروض الأقسام والبحث
async function catalogHandler({ type, id, extra }) {
  const skip = parseInt(extra.skip) || 0;
  const search = extra.search || '';
  const page = Math.floor(skip / 30) + 1;
  
  const cacheKey = `cat_${type}_${search}_${skip}`;
  const cachedData = getCache(cacheKey);
  if (cachedData) return { metas: cachedData };

  let htmlData = search 
    ? await fetchViaProxy('search', '', search)
    : await fetchViaProxy('get_links', type === 'movie' ? `${BASE_URL}/movies/page/${page}/` : `${BASE_URL}/series/page/${page}/`);

  if (!htmlData) return { metas: [] };
  const $ = cheerio.load(htmlData);
  const metas = [];

  $('.MovieBlock, .Block--Item, article, .Small--Box, .movie__block').each((i, el) => {
    const linkEl = $(el).find('a').first();
    const link = linkEl.attr('href');
    const title = $(el).find('h3, h4, .BlockTitle, .Title, p').first().text().trim() || linkEl.attr('title');
    const poster = $(el).find('img').first().attr('data-src') || $(el).find('img').first().attr('src');

    if (link && title) {
      metas.push({
        id: 'as_' + Buffer.from(link).toString('base64url'),
        type,
        name: title,
        poster: poster || '',
        posterShape: 'poster'
      });
    }
  });

  setCache(cacheKey, metas);
  return { metas };
}

// 2. معالج جلب البيانات التفصيلية والحلقات للمسلسلات
async function metaHandler({ type, id }) {
  const cacheKey = `meta_${id}`;
  const cachedData = getCache(cacheKey);
  if (cachedData) return { meta: cachedData };

  try {
    const pageUrl = Buffer.from(id.replace('as_', ''), 'base64url').toString();
    const htmlData = await fetchViaProxy('get_links', pageUrl);
    if (!htmlData) return { meta: {} };

    const $ = cheerio.load(htmlData);
    const name = $('h1').first().text().trim() || $('title').text().trim();
    const poster = $('.Poster img, .single-thumb img, .movie-poster img').first().attr('src');
    const description = $('.descrip, .StoryLine, .story').first().text().trim();

    const meta = { id, type, name, poster, background: poster, description, genres: [] };
    $('.Genre a, .genres a').each((i, el) => meta.genres.push($(el).text().trim()));

    if (type === 'series') {
      const videos = [];
      $('.EpisodesList a, .episodes-list a, .EpsList a').each((i, el) => {
        const epUrl = $(el).attr('href');
        const epTitle = $(el).text().trim() || `الحلقة ${i + 1}`;
        if (epUrl) {
          videos.push({
            id: 'as_' + Buffer.from(epUrl).toString('base64url'),
            title: epTitle,
            season: 1,
            episode: parseInt(epTitle.match(/\d+/)?.[0]) || (i + 1),
            released: new Date().toISOString()
          });
        }
      });
      if (videos.length > 0) meta.videos = videos.reverse();
    }

    setCache(cacheKey, meta);
    return { meta };
  } catch (err) {
    return { meta: {} };
  }
}

// 3. معالج فك السيرفرات والبث الصافي لستريميو
async function streamHandler({ type, id }) {
  const cacheKey = `stream_${id}`;
  const cachedData = getCache(cacheKey);
  if (cachedData) return { streams: cachedData };

  const streams = [];
  try {
    const pageUrl = Buffer.from(id.replace('as_', ''), 'base64url').toString();
    const pageHtml = await fetchViaProxy('get_links', pageUrl);
    if (!pageHtml) return { streams: [] };
    
    let $ = cheerio.load(pageHtml);
    let watchUrl = pageUrl;
    if (!watchUrl.endsWith('/watch/')) {
      const watchLink = $('a.watchBtn, a[href*="/watch/"], a:contains("مشاهدة")').first().attr('href');
      watchUrl = watchLink ? watchLink : watchUrl.replace(/\/$/, '') + '/watch/';
    }

    const watchHtml = await fetchViaProxy('get_links', watchUrl);
    if (!watchHtml) return { streams: [] };
    
    const $w = cheerio.load(watchHtml);
    const servers = [];
    
    // فك التشفير التكتيكي لروابط الـ Base64 المخفية بـ play.php?url=
    const b64Regex = /play\.php\?url=([a-zA-Z0-9+/=]+)/g;
    let match;
    while ((match = b64Regex.exec(watchHtml)) !== null) {
      try {
        let b64Str = match[1];
        const padding = 4 - (b64Str.length % 4);
        if (padding !== 4) b64Str += '='.repeat(padding);
        const decoded = Buffer.from(b64Str, 'base64').toString('utf-8');
        if (decoded.startsWith('http') && !servers.some(s => s.link === decoded)) {
          servers.push({ name: 'عرب سيد مباشر ⚡', link: decoded });
        }
      } catch (e) {}
    }

    $w('[data-link], [data-server], .servers li, ul.WatchVideoList li a').each((i, el) => {
      let link = $(el).attr('data-link') || $(el).attr('data-server') || $(el).attr('href');
      if (link && link.startsWith('http') && !servers.some(s => s.link === link)) {
        servers.push({ name: $(el).text().trim() || `سيرفر ${i + 1}`, link });
      }
    });

    // سحب الفيديوهات الصافية من أول 3 سيرفرات مفكوكة بالتوازي لضمان السرعة
    const optimizedServers = servers.slice(0, 3);
    const extractions = await Promise.allSettled(optimizedServers.map(s => extractFromServer(s.link)));

    extractions.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        result.value.forEach(link => {
          streams.push({
            name: 'ArabSeed Pro',
            title: `🎬 ${optimizedServers[i].name}\n🔗 الجودة: ${link.quality}`,
            url: link.url,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: {
                request: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                  "Referer": optimizedServers[i].link,
                  "Origin": new URL(optimizedServers[i].link).origin
                }
              }
            }
          });
        });
      }
    });

    if (streams.length === 0) {
      streams.push({ name: 'ArabSeed Backup', title: '🌐 فتح سيرفر البث الاحتياطي الخارجي', url: watchUrl });
    }

    setCache(cacheKey, streams);
    return { streams };
  } catch (err) {
    return { streams: [] };
  }
}

async function extractFromServer(serverLink) {
  const links = [];
  try {
    const htmlData = await fetchViaProxy('get_links', serverLink);
    if (!htmlData) return [];

    const m3u8Matches = htmlData.match(/https?:\/\/[^\s"'<>\\)]+\.m3u8[^\s"'<>\\)]*/gi);
    if (m3u8Matches) {
      [...new Set(m3u8Matches)].forEach(url => {
        let quality = 'تلقائية HLS';
        if (url.includes('1080')) quality = '1080p (FHD)';
        else if (url.includes('720')) quality = '720p (HD)';
        links.push({ url: url.replace(/\\\//g, '/'), quality });
      });
    }

    const mp4Matches = htmlData.match(/https?:\/\/[^\s"'<>\\)]+\.mp4[^\s"'<>\\)]*/gi);
    if (mp4Matches) {
      [...new Set(mp4Matches)].forEach(url => {
        let quality = 'سورس مباشر MP4';
        if (url.includes('1080')) quality = '1080p [سريع]';
        else if (url.includes('720')) quality = '720p [سريع]';
        links.push({ url: url.replace(/\\\//g, '/'), quality });
      });
    }
  } catch (e) {}
  return links;
}

module.exports = { manifest, catalogHandler, metaHandler, streamHandler };
