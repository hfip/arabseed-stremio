// api/index.js
const cheerio = require('cheerio');

// ============ إعداد البروكسي الآمن من جوجل ============
const GOOGLE_PROXY_URL = "https://script.google.com/macros/s/AKfycbwzwsaeYrNMVo39ot5D2ah72SWsN1NaKa-_0yagRowbZNnByWwBiu94mO6mAUjwVGhSrQ/exec";
const BASE_URL = 'https://m.asd.ink';

// ============ Manifest ============
const manifest = {
  id: 'org.arabseed.asd',
  version: '1.0.2',
  name: 'ArabSeed Proxy Fixed',
  description: 'إصلاح حماية روابط البث والترميز عبر بروكسي جوجل',
  logo: 'https://m.asd.ink/wp-content/uploads/2023/01/cropped-Untitled-1-1-192x192.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'as_movies',
      name: 'عرب سيد - أفلام',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'as_series',
      name: 'عرب سيد - مسلسلات',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  idPrefixes: ['as_']
};

// ============ Cache ============
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

const getCache = (key) => {
  const item = cache.get(key);
  if (item && Date.now() - item.time < CACHE_TTL) return item.data;
  cache.delete(key);
  return null;
};

const setCache = (key, data) => {
  cache.set(key, { data, time: Date.now() });
  if (cache.size > 300) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
};

const encodeId = (url) => 'as_' + Buffer.from(url).toString('base64url');
const decodeId = (id) => Buffer.from(id.replace('as_', ''), 'base64url').toString();

// ============ جلب البيانات مع تأمين ترميز النصوص ============
async function fetchViaProxy(action, targetUrl = '', searchQuery = '') {
  try {
    let proxyUrl = `${GOOGLE_PROXY_URL}?action=${action}`;
    if (action === 'search') {
      proxyUrl += `&q=${encodeURIComponent(searchQuery)}`;
    } else if (action === 'get_links') {
      proxyUrl += `&url=${encodeURIComponent(targetUrl)}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(proxyUrl, { 
      method: 'GET',
      signal: controller.signal 
    });
    
    clearTimeout(timeoutId);
    if (!response.ok) return null;

    // إجبار الاستجابة على القراءة بترميز UTF-8 لحل مشكلة علامات الاستفهام والرموز الغريبة
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(buffer);
  } catch (err) {
    console.error(`Proxy Error (${action}):`, err.message);
    return null;
  }
}

// ============ Catalog ============
async function fetchCatalog(type, search, skip = 0) {
  try {
    const page = Math.floor(skip / 30) + 1;
    let htmlData = "";

    if (search) {
      htmlData = await fetchViaProxy('search', '', search);
    } else {
      let targetUrl = type === 'movie' 
        ? (page === 1 ? `${BASE_URL}/movies/` : `${BASE_URL}/movies/page/${page}/`)
        : (page === 1 ? `${BASE_URL}/series/` : `${BASE_URL}/series/page/${page}/`);
      
      htmlData = await fetchViaProxy('get_links', targetUrl);
    }

    if (!htmlData) return [];

    const $ = cheerio.load(htmlData);
    const results = [];

    $('.MovieBlock, .Block--Item, article, .Small--Box').each((i, el) => {
      const $el = $(el);
      const linkEl = $el.find('a').first();
      const link = linkEl.attr('href');
      
      const title = $el.find('h3, h4, .BlockTitle, .Title').first().text().trim()
        || linkEl.attr('title')
        || $el.find('img').attr('alt');
      
      const img = $el.find('img').first();
      const poster = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src');

      if (link && title) {
        results.push({
          id: encodeId(link),
          type,
          name: title,
          poster: poster || '',
          posterShape: 'poster'
        });
      }
    });

    return results;
  } catch (err) {
    return [];
  }
}

// ============ Meta ============
async function fetchMeta(id, type) {
  try {
    const url = decodeId(id);
    const htmlData = await fetchViaProxy('get_links', url);
    if (!htmlData) return null;

    const $ = cheerio.load(htmlData);

    const name = $('h1').first().text().trim() || $('.Title--Block h1').text().trim();
    const poster = $('.Poster img, .single-thumb img, .post-thumbnail img').first().attr('src');
    const description = $('.descrip, .StoryLine, .post-content p').first().text().trim();

    const meta = {
      id,
      type,
      name,
      poster,
      background: poster,
      description,
      genres: []
    };

    $('.Genre a, .genres a').each((i, el) => {
      meta.genres.push($(el).text().trim());
    });

    if (type === 'series') {
      const videos = [];
      $('.EpisodesList a, .episodes-list a, .ContainerEpisodesList a').each((i, el) => {
        const epUrl = $(el).attr('href');
        const epTitle = $(el).text().trim() || `الحلقة ${i + 1}`;
        const epNum = parseInt(epTitle.match(/\d+/)?.[0]) || (i + 1);
        
        if (epUrl) {
          videos.push({
            id: encodeId(epUrl),
            title: epTitle,
            season: 1,
            episode: epNum,
            released: new Date().toISOString()
          });
        }
      });
      
      if (videos.length > 0) meta.videos = videos.reverse();
    }

    return meta;
  } catch (err) {
    return null;
  }
}

// ============ Streams & Hotlink Protection Bypass ============
async function fetchStreams(pageUrl) {
  const streams = [];
  try {
    const pageHtml = await fetchViaProxy('get_links', pageUrl);
    if (!pageHtml) return [];
    
    let $ = cheerio.load(pageHtml);

    let watchUrl = pageUrl;
    const watchLink = $('a.watchBtn, a[href*="/watch/"], .WatchBTN a, a:contains("مشاهدة")').first().attr('href');
    if (watchLink) watchUrl = watchLink;

    const watchHtml = await fetchViaProxy('get_links', watchUrl);
    if (!watchHtml) return [];
    
    const $w = cheerio.load(watchHtml);
    const servers = [];
    
    $w('[data-link], [data-server], .server-item, .servers li, .ServersList li, ul.WatchVideoList li').each((i, el) => {
      const $el = $w(el);
      let link = $el.attr('data-link') || $el.attr('data-server') || $el.find('a').attr('href');
      let name = $el.text().trim() || `Server ${i + 1}`;
      
      if (link && /^[A-Za-z0-9+/=]+$/.test(link) && link.length > 20) {
        try {
          const decoded = Buffer.from(link, 'base64').toString();
          if (decoded.startsWith('http')) link = decoded;
        } catch (e) {}
      }
      
      if (link && link.startsWith('http')) {
        servers.push({ name, link });
      }
    });

    $w('iframe').each((i, el) => {
      let src = $w(el).attr('src') || $w(el).attr('data-src');
      if (!src) return;
      if (src.startsWith('/')) src = BASE_URL + src;
      servers.push({ name: `Player ${i + 1}`, link: src });
    });

    const optimizedServers = servers.slice(0, 3);
    const extractions = await Promise.allSettled(
      optimizedServers.map(s => extractFromServer(s.link))
    );

    extractions.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        result.value.forEach(link => {
          streams.push({
            name: 'ArabSeed Pro',
            title: `▶️ ${optimizedServers[i].name} (${link.quality})`,
            url: link.url,
            // التعديل الجوهري: إرسال هيدرز الحماية لتطبيق ستريميو ليفك حظر السيرفر أثناء التشغيل المباشر
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: {
                request: {
                  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
                  "Referer": optimizedServers[i].link,
                  "Origin": new URL(optimizedServers[i].link).origin
                }
              }
            }
          });
        });
      }
    });

    // إذا لم نجد روابط مباشرة، نضع رابطاً للمشاهدة على الويب الخارجي كحل احتياطي نظيف
    if (streams.length === 0) {
      streams.push({
        name: 'ArabSeed External',
        title: '🌐 فتح صفحة المشاهدة الخارجية',
        externalUrl: watchUrl
      });
    }

    return streams;
  } catch (err) {
    return streams;
  }
}

async function extractFromServer(serverLink) {
  const links = [];
  try {
    const htmlData = await fetchViaProxy('get_links', serverLink);
    if (!htmlData) return [];

    let html = htmlData;

    const m3u8Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.m3u8[^\s"'<>\\)]*/gi);
    if (m3u8Matches) {
      [...new Set(m3u8Matches)].forEach(url => 
        links.push({ url: url.replace(/\\\//g, '/'), quality: 'HLS m3u8' })
      );
    }

    const mp4Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.mp4[^\s"'<>\\)]*/gi);
    if (mp4Matches) {
      [...new Set(mp4Matches)].forEach(url => 
        links.push({ url: url.replace(/\\\//g, '/'), quality: 'MP4' })
      );
    }
  } catch (e) {}
  return links;
}

// ============ Handler ============
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlPath = req.url;

  if (urlPath === '/' || urlPath === '') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
      <h1>ArabSeed Stremio Addon</h1>
      <p>الإضافة تعمل بنجاح وبأعلى كفاءة لفك الحظر والترميز.</p>
    `);
  }

  if (urlPath === '/manifest.json') {
    return res.status(200).json(manifest);
  }

  if (urlPath.includes('/catalog/')) {
    try {
      const cleanPath = urlPath.replace('.json', '');
      const parts = cleanPath.split('/');
      const type = parts[2];
      const extraStr = parts[4] || '';

      const params = {};
      if (extraStr) {
        extraStr.split('&').forEach(p => {
          const [k, v] = p.split('=');
          if (k) params[k] = decodeURIComponent(v || '');
        });
      }

      const cacheKey = `cat_${type}_${params.search || ''}_${params.skip || 0}`;
      let metas = getCache(cacheKey);
      
      if (!metas) {
        metas = await fetchCatalog(type, params.search, parseInt(params.skip) || 0);
        setCache(cacheKey, metas);
      }

      return res.status(200).json({ metas });
    } catch (e) {
      return res.status(500).json({ metas: [] });
    }
  }

  if (urlPath.includes('/meta/')) {
    try {
      const cleanPath = urlPath.replace('.json', '');
      const parts = cleanPath.split('/');
      const type = parts[2];
      const id = parts[3];

      const cacheKey = `meta_${id}`;
      let meta = getCache(cacheKey);
      
      if (!meta) {
        meta = await fetchMeta(id, type);
        if (meta) setCache(cacheKey, meta);
      }

      return res.status(200).json({ meta: meta || {} });
    } catch (e) {
      return res.status(500).json({ meta: {} });
    }
  }

  if (urlPath.includes('/stream/')) {
    try {
      const cleanPath = urlPath.replace('.json', '');
      const parts = cleanPath.split('/');
      const id = parts[3];

      const cacheKey = `stream_${id}`;
      let streams = getCache(cacheKey);
      
      if (!streams) {
        const url = decodeId(id);
        streams = await fetchStreams(url);
        if (streams && streams.length > 0) setCache(cacheKey, streams);
      }

      return res.status(200).json({ streams: streams || [] });
    } catch (e) {
      return res.status(500).json({ streams: [] });
    }
  }

  return res.status(404).json({ error: "Not Supported" });
}
