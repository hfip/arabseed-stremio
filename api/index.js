// api/index.js
const cheerio = require('cheerio');

// ============ إعداد البروكسي الآمن من جوجل ============
const GOOGLE_PROXY_URL = "https://script.google.com/macros/s/AKfycbwzwsaeYrNMVo39ot5D2ah72SWsN1NaKa-_0yagRowbZNnByWwBiu94mO6mAUjwVGhSrQ/exec";
const BASE_URL = 'https://m.asd.ink';

// ============ Manifest ============
const manifest = {
  id: 'org.arabseed.asd',
  version: '1.0.0',
  name: 'ArabSeed (asd.ink) Proxy',
  description: 'إضافة عرب سيد عبر بروكسي جوجل الآمن - أفلام ومسلسلات عربية واجنبية',
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

// ============ Cache (التخزين المؤقت في الذاكرة) ============
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // نصف ساعة لتحديث النتائج ديناميكياً

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

// ============ مساعدات التشفير وفك التشفير للمسارات ============
const encodeId = (url) => 'as_' + Buffer.from(url).toString('base64url');
const decodeId = (id) => Buffer.from(id.replace('as_', ''), 'base64url').toString();

// ============ الدالة المساعدة لطلب البيانات عبر بروكسي جوجل الآمن ============
async function fetchViaProxy(action, targetUrl = '', searchQuery = '') {
  try {
    let proxyUrl = `${GOOGLE_PROXY_URL}?action=${action}`;
    if (action === 'search') {
      proxyUrl += `&q=${encodeURIComponent(searchQuery)}`;
    } else if (action === 'get_links') {
      proxyUrl += `&url=${encodeURIComponent(targetUrl)}`;
    }

    const response = await fetch(proxyUrl, { method: 'GET' });
    if (!response.ok) throw new Error(`Proxy status: ${response.status}`);
    return await response.text();
  } catch (err) {
    console.error(`فشل البروكسي في إجراء العملية ${action}:`, err.message);
    return null;
  }
}

// ============ جلب قائمة الأفلام/المسلسلات عبر البروكسي ============
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
    console.error('خطأ الكتالوج:', err.message);
    return [];
  }
}

// ============ جلب البيانات التفصيلية عبر البروكسي ============
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
    console.error('خطأ جلب الميتا:', err.message);
    return null;
  }
}

// ============ استخراج روابط البث المباشرة من السيرفرات ============
async function fetchStreams(pageUrl) {
  const streams = [];
  try {
    // 1. جلب صفحة المحتوى الأساسية عبر البروكسي
    const pageHtml = await fetchViaProxy('get_links', pageUrl);
    if (!pageHtml) return [];
    
    let $ = cheerio.load(pageHtml);

    // 2. فحص والتحويل لصفحة المشاهدة "watch"
    let watchUrl = pageUrl;
    const watchLink = $('a.watchBtn, a[href*="/watch/"], .WatchBTN a, a:contains("مشاهدة")').first().attr('href');
    if (watchLink) watchUrl = watchLink;

    // جلب صفحة المشاهدة التي تحتوي السيرفرات والمشغلات عبر البروكسي لتخطي الحظر
    const watchHtml = await fetchViaProxy('get_links', watchUrl);
    if (!watchHtml) return [];
    
    const $w = cheerio.load(watchHtml);
    const servers = [];
    
    // فحص السيرفرات المدمجة كأزرار
    $w('[data-link], [data-server], .server-item, .servers li, .ServersList li, ul.WatchVideoList li').each((i, el) => {
      const $el = $w(el);
      let link = $el.attr('data-link') || $el.attr('data-server') || $el.find('a').attr('href');
      const name = $el.text().trim() || `سيرفر ${i + 1}`;
      
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

    // فحص وسحب الـ iframes والمشغلات المباشرة
    $w('iframe').each((i, el) => {
      let src = $w(el).attr('src') || $w(el).attr('data-src');
      if (!src) return;
      
      if (src.startsWith('/')) src = BASE_URL + src;
      
      const urlMatch = src.match(/[?&]url=([^&]+)/);
      if (urlMatch) {
        try {
          const decoded = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString();
          if (decoded.startsWith('http')) {
            servers.push({ name: `مشغل مدمج ${i + 1}`, link: decoded });
            return;
          }
        } catch (e) {}
      }
      
      servers.push({ name: `مشغل مدمج ${i + 1}`, link: src });
    });

    // 3. استخراج الروابط من السيرفرات المكتشفة بالتوازي لسرعة الأداء
    const extractions = await Promise.allSettled(
      servers.slice(0, 8).map(s => extractFromServer(s.link, watchUrl))
    );

    extractions.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        result.value.forEach(link => {
          streams.push({
            name: 'ArabSeed Pro',
            title: `${servers[i].name}\n🔗 ${link.quality}`,
            url: link.url,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: {
                request: { 
                  'Referer': servers[i].link, 
                  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' 
                }
              }
            }
          });
        });
      }
    });

    return streams;
  } catch (err) {
    console.error('خطأ جلب السيرفرات:', err.message);
    return streams;
  }
}

// ============ جلب صفحة السيرفر واستخراج صيغ الفيديو (m3u8 / mp4) ============
async function extractFromServer(serverLink, referer) {
  const links = [];
  try {
    // نطلب السيرفر مباشرة عبر البروكسي للتأكد من تخطي حظر حمايات ملفات البث
    const htmlData = await fetchViaProxy('get_links', serverLink);
    if (!htmlData) return [];

    let html = htmlData;

    if (html.includes('eval(function(p,a,c,k,e,')) {
      const unpacked = unpackJS(html);
      if (unpacked) html += '\n' + unpacked;
    }

    // تصفية روابط البث المباشر HLS
    const m3u8Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.m3u8[^\s"'<>\\)]*/gi);
    if (m3u8Matches) {
      [...new Set(m3u8Matches)].forEach(url => 
        links.push({ url: url.replace(/\\\//g, '/'), quality: 'HLS m3u8 (ممتاز لأبل تي في والاندرويد)' })
      );
    }

    // تصفية روابط البث MP4
    const mp4Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.mp4[^\s"'<>\\)]*/gi);
    if (mp4Matches) {
      [...new Set(mp4Matches)].forEach(url => 
        links.push({ url: url.replace(/\\\//g, '/'), quality: 'MP4 مباشر' })
      );
    }

    const fileMatches = html.match(/(?:file|src|source)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)/gi);
    if (fileMatches) {
      fileMatches.forEach(m => {
        const url = m.match(/["']([^"']+)["']/)?.[1];
        if (url && !links.find(l => l.url === url)) {
          links.push({ url, quality: 'سورس البث المباشر' });
        }
      });
    }

  } catch (e) {
    console.log(`فشل استخراج السيرفر:`, e.message);
  }
  return links;
}

// ============ فك حزم الـ JavaScript المشفرة للمشغلات ============
function unpackJS(source) {
  try {
    const match = /eval\(function\(p,a,c,k,e,[dr]\).*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/s.exec(source);
    if (!match) return null;
    
    let payload = match[1];
    const radix = parseInt(match[2]);
    const symtab = match[4].split('|');
    
    const unbase = (str) => {
      let result = 0;
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        const v = /[0-9]/.test(c) ? parseInt(c) : c.charCodeAt(0) - 87;
        result = result * radix + v;
      }
      return result;
    };
    
    return payload.replace(/\b\w+\b/g, (word) => {
      const idx = unbase(word);
      return (symtab[idx] && symtab[idx] !== '') ? symtab[idx] : word;
    });
  } catch (e) {
    return null;
  }
}

// ============ المحرك الرئيسي والموجه لـ Vercel Serverless Function ============
export default async function handler(req, res) {
  // تفعيل خيارات الـ CORS لتشغيل الإضافة على كافة مشغلات ستريميو والأنظمة
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlPath = req.url;

  // 1. مسار الصفحة الرئيسية للإضافة على متصفح الويب
  if (urlPath === '/' || urlPath === '') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
      <h1>ArabSeed Stremio Addon (جوجل بروكسي آمن)</h1>
      <p>الإضافة تعمل بنجاح وبدون حظر IP.</p>
      <p>رابط التثبيت داخل ستريميو: <br> <code>https://${req.headers.host}/manifest.json</code></p>
    `);
  }

  // 2. مسار الـ Manifest
  if (urlPath === '/manifest.json') {
    return res.status(200).json(manifest);
  }

  // 3. مسار جلب الأقسام والبحث (Catalog)
  if (urlPath.includes('/catalog/')) {
    try {
      // تفكيك المتغيرات من الروابط على هيكلية ستريميو القياسية
      const cleanPath = urlPath.replace('.json', '');
      const parts = cleanPath.split('/');
      const type = parts[2];
      const id = parts[3];
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
      return res.status(500).json({ metas: [], error: e.toString() });
    }
  }

  // 4. مسار جلب تفاصيل الفيلم/المسلسل (Meta)
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
      return res.status(500).json({ meta: {}, error: e.toString() });
    }
  }

  // 5. مسار جلب الروابط والسيرفرات لتشغيل الفيديو (Stream)
  if (urlPath.includes('/stream/')) {
    try {
      const cleanPath = urlPath.replace('.json', '');
      const parts = cleanPath.split('/');
      const type = parts[2];
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
      return res.status(500).json({ streams: [], error: e.toString() });
    }
  }

  return res.status(404).json({ error: "مسار غير مدعوم" });
}
