// api/index.js
const cheerio = require('cheerio');

// ============ إعداد البروكسي والدومينات الدوارة المستخلصة ============
const GOOGLE_PROXY_URL = "https://script.google.com/macros/s/AKfycbwzwsaeYrNMVo39ot5D2ah72SWsN1NaKa-_0yagRowbZNnByWwBiu94mO6mAUjwVGhSrQ/exec";
const BASE_URL = 'https://m.asd.ink'; 

// ============ Manifest ============
const manifest = {
  id: 'org.arabseed.asd.proxy',
  version: '1.1.0',
  name: 'ArabSeed Pro Max',
  description: 'إضافة عرب سيد الاحترافية لفك تشفير المشغلات والجودات المباشرة عبر بروكسي جوجل الآمن',
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

// ============ Cache (التخزين المؤقت لسرعة الاستجابة وحماية السيرفر) ============
const cache = new Map();
const CACHE_TTL = 20 * 60 * 1000; // 20 دقيقة

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

// ============ دالة جلب البيانات مع تأمين ترميز النصوص والتايم أوت تكتيكياً ============
async function fetchViaProxy(action, targetUrl = '', searchQuery = '') {
  try {
    let proxyUrl = `${GOOGLE_PROXY_URL}?action=${action}`;
    if (action === 'search') {
      proxyUrl += `&q=${encodeURIComponent(searchQuery)}`;
    } else if (action === 'get_links') {
      proxyUrl += `&url=${encodeURIComponent(targetUrl)}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7500); // 7.5 ثوانٍ حماية لـ Vercel

    const response = await fetch(proxyUrl, { 
      method: 'GET',
      signal: controller.signal 
    });
    
    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(buffer);
  } catch (err) {
    console.error(`Proxy Error (${action}):`, err.message);
    return null;
  }
}

// ============ Catalog (الأقسام والبحث التلقائي) ============
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

    $('.MovieBlock, .Block--Item, article, .Small--Box, .movie__block').each((i, el) => {
      const $el = $(el);
      const linkEl = $el.find('a').first();
      const link = linkEl.attr('href');
      
      const title = $el.find('h3, h4, .BlockTitle, .Title, p').first().text().trim()
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

// ============ Meta (معلومات الفيلم والحلقات) ============
async function fetchMeta(id, type) {
  try {
    const url = decodeId(id);
    const htmlData = await fetchViaProxy('get_links', url);
    if (!htmlData) return null;

    const $ = cheerio.load(htmlData);

    const name = $('h1').first().text().trim() || $('.Title--Block h1').text().trim() || $('title').text().trim();
    const poster = $('.Poster img, .single-thumb img, .post-thumbnail img, .movie-poster img').first().attr('src');
    const description = $('.descrip, .StoryLine, .post-content p, .story').first().text().trim();

    const meta = {
      id,
      type,
      name,
      poster,
      background: poster,
      description,
      genres: []
    };

    $('.Genre a, .genres a, .genre a').each((i, el) => {
      meta.genres.push($(el).text().trim());
    });

    if (type === 'series') {
      const videos = [];
      $('.EpisodesList a, .episodes-list a, .ContainerEpisodesList a, .EpsList a').each((i, el) => {
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

// ============ Streams (تفكيك الـ Base64 وسحب الروابط الصافية) ============
async function fetchStreams(pageUrl) {
  const streams = [];
  try {
    const pageHtml = await fetchViaProxy('get_links', pageUrl);
    if (!pageHtml) return [];
    
    let $ = cheerio.load(pageHtml);

    // التحويل الإجباري لصفحة الـ /watch/ كما تفعل ملفات الدفعة الثانية
    let watchUrl = pageUrl;
    if (!watchUrl.endsWith('/watch/')) {
      const watchLink = $('a.watchBtn, a[href*="/watch/"], .WatchBTN a, a:contains("مشاهدة")').first().attr('href');
      if (watchLink) watchUrl = watchLink;
      else watchUrl = watchUrl.rstrip('/') + '/watch/';
    }

    const watchHtml = await fetchViaProxy('get_links', watchUrl);
    if (!watchHtml) return [];
    
    const $w = cheerio.load(watchHtml);
    const servers = [];
    
    // 1. التقاط وفك تشفير روابط play.php?url=BASE64 السرية لحل مشكلة عدم التشغيل
    const watchHtmlString = watchHtml;
    const b64Regex = /play\.php\?url=([a-zA-Z0-9+/=]+)/g;
    let match;
    while ((match = b64Regex.exec(watchHtmlString)) !== null) {
      try {
        let b64Str = match[1];
        // معالجة الـ Padding المذكورة في ملف البايثون
        const padding = 4 - (b64Str.length % 4);
        if (padding !== 4) b64Str += '='.repeat(padding);
        
        const decoded = Buffer.from(b64Str, 'base64').toString('utf-8');
        if (decoded.startsWith('http') && !servers.some(s => s.link === decoded)) {
          servers.push({ name: 'عرب سيد مباشر ⚡', link: decoded });
        }
      } catch (e) {}
    }

    // 2. التقاط السيرفرات المدمجة التقليدية والـ iframes
    $w('[data-link], [data-server], .server-item, .servers li, a[data-quality]').each((i, el) => {
      const $el = $w(el);
      let link = $el.attr('data-link') || $el.attr('data-server') || $el.attr('href');
      let qLabel = $el.attr('data-quality') ? `${$el.attr('data-quality')}p` : '';
      let name = $el.text().trim() || `سيرفر ${qLabel || i + 1}`;
      
      if (link && link.startsWith('http') && !servers.some(s => s.link === link)) {
        servers.push({ name, link });
      }
    });

    $w('iframe').each((i, el) => {
      let src = $w(el).attr('src') || $w(el).attr('data-src');
      if (src && src.startsWith('http') && !servers.some(s => s.link === src)) {
        servers.push({ name: `مشغل مدمج ${i + 1}`, link: src });
      }
    });

    // نأخذ أعلى 4 سيرفرات تم فك تشفيرها بالتوازي لضمان السرعة وعدم الانهيار
    const optimizedServers = servers.slice(0, 4);
    const extractions = await Promise.allSettled(
      optimizedServers.map(s => extractFromServer(s.link))
    );

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

    // خطة الطوارئ البديلة (لحماية الواجهة من الفراغ التام)
    if (streams.length === 0) {
      streams.push({
        name: 'ArabSeed Direct',
        title: '🌐 سيرفر تشغيل مباشر احتياطي لكود الصفحة',
        url: watchUrl
      });
    }

    return streams;
  } catch (err) {
    return streams;
  }
}

// ============ استخراج صيغ ملفات الفيديو من السيرفر المفتوح ============
async function extractFromServer(serverLink) {
  const links = [];
  try {
    const htmlData = await fetchViaProxy('get_links', serverLink);
    if (!htmlData) return [];

    const html = htmlData;

    // استخراج جودات الـ HLS m3u8 للمشاهدة السلسة بدون تقطيع
    const m3u8Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.m3u8[^\s"'<>\\)]*/gi);
    if (m3u8Matches) {
      [...new Set(m3u8Matches)].forEach(url => {
        let quality = 'تلقائية HLS';
        if (url.includes('1080')) quality = '1080p (FHD)';
        else if (url.includes('720')) quality = '720p (HD)';
        else if (url.includes('480')) quality = '480p (SD)';
        links.push({ url: url.replace(/\\\//g, '/'), quality });
      });
    }

    // استخراج روابط الـ MP4 المباشرة للتحميل والتشغيل على كافة المشغلات
    const mp4Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.mp4[^\s"'<>\\)]*/gi);
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

// ============ الموجه والمنظم لـ Vercel Serverless Function ============
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
      <h1>ArabSeed Stremio Addon Pro Max</h1>
      <p>الإضافة تعمل بأعلى كفاءة ومميزات فك التشفير الـ Base64 مفعلة الآن.</p>
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
