const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// ============ الإعدادات ============
const BASE_URL = 'https://m.asd.ink';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
  'Referer': BASE_URL + '/'
};

// ============ Manifest ============
const manifest = {
  id: 'org.arabseed.asd',
  version: '1.0.0',
  name: 'ArabSeed (asd.ink)',
  description: 'إضافة عرب سيد - أفلام ومسلسلات عربية',
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
const CACHE_TTL = 60 * 60 * 1000; // ساعة

const getCache = (key) => {
  const item = cache.get(key);
  if (item && Date.now() - item.time < CACHE_TTL) return item.data;
  cache.delete(key);
  return null;
};

const setCache = (key, data) => {
  cache.set(key, { data, time: Date.now() });
  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
};

// ============ مساعدات ============
const encodeId = (url) => 'as_' + Buffer.from(url).toString('base64url');
const decodeId = (id) => Buffer.from(id.replace('as_', ''), 'base64url').toString();

// ============ جلب القائمة ============
async function fetchCatalog(type, search, skip = 0) {
  try {
    const page = Math.floor(skip / 30) + 1;
    let url;

    if (search) {
      url = `${BASE_URL}/?s=${encodeURIComponent(search)}`;
    } else if (type === 'movie') {
      url = page === 1 ? `${BASE_URL}/movies/` : `${BASE_URL}/movies/page/${page}/`;
    } else {
      url = page === 1 ? `${BASE_URL}/series/` : `${BASE_URL}/series/page/${page}/`;
    }

    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    const results = [];

    // selectors متعددة لضمان الالتقاط
    $('.MovieBlock, .Block--Item, article, .Small--Box').each((i, el) => {
      const $el = $(el);
      const linkEl = $el.find('a').first();
      const link = linkEl.attr('href');
      
      const title = $el.find('h3, h4, .BlockTitle, .Title').first().text().trim()
        || linkEl.attr('title')
        || $el.find('img').attr('alt');
      
      const img = $el.find('img').first();
      const poster = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src');

      if (link && title && link.includes(BASE_URL.replace('https://', ''))) {
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
    console.error('Catalog error:', err.message);
    return [];
  }
}

// ============ جلب البيانات التفصيلية ============
async function fetchMeta(id, type) {
  try {
    const url = decodeId(id);
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);

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

    // للمسلسلات: استخراج الحلقات
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
    console.error('Meta error:', err.message);
    return null;
  }
}

// ============ استخراج روابط البث ============
async function fetchStreams(pageUrl) {
  const streams = [];
  
  try {
    // 1. جلب صفحة المحتوى
    const { data: pageHtml } = await axios.get(pageUrl, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(pageHtml);

    // 2. البحث عن صفحة المشاهدة "watch"
    let watchUrl = pageUrl;
    const watchLink = $('a.watchBtn, a[href*="/watch/"], .WatchBTN a, a:contains("مشاهدة")').first().attr('href');
    if (watchLink) watchUrl = watchLink;

    const { data: watchHtml } = await axios.get(watchUrl, { 
      headers: { ...HEADERS, Referer: pageUrl }, 
      timeout: 15000 
    });
    const $w = cheerio.load(watchHtml);

    // 3. جمع كل السيرفرات
    const servers = [];
    
    // السيرفرات بشكل أزرار/قوائم
    $w('[data-link], [data-server], .server-item, .servers li, .ServersList li, ul.WatchVideoList li').each((i, el) => {
      const $el = $w(el);
      let link = $el.attr('data-link') || $el.attr('data-server') || $el.find('a').attr('href');
      const name = $el.text().trim() || `سيرفر ${i + 1}`;
      
      // فك Base64 إذا موجود
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

    // iframe الأساسي مثل /play.php?url=BASE64
    $w('iframe').each((i, el) => {
      let src = $w(el).attr('src') || $w(el).attr('data-src');
      if (!src) return;
      
      // إذا كان relative
      if (src.startsWith('/')) src = BASE_URL + src;
      
      // إذا كان play.php?url=base64
      const urlMatch = src.match(/[?&]url=([^&]+)/);
      if (urlMatch) {
        try {
          const decoded = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString();
          if (decoded.startsWith('http')) {
            servers.push({ name: `Iframe ${i + 1}`, link: decoded });
            return;
          }
        } catch (e) {}
      }
      
      servers.push({ name: `Iframe ${i + 1}`, link: src });
    });

    console.log(`وُجد ${servers.length} سيرفر`);

    // 4. استخراج الروابط من كل سيرفر بالتوازي
    const extractions = await Promise.allSettled(
      servers.slice(0, 8).map(s => extractFromServer(s, watchUrl))
    );

    extractions.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        result.value.forEach(link => {
          streams.push({
            name: 'ArabSeed',
            title: `${servers[i].name}\n${link.quality || 'Auto'}`,
            url: link.url,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: {
                request: { 'Referer': servers[i].link, 'User-Agent': HEADERS['User-Agent'] }
              }
            }
          });
        });
      }
    });

    return streams;
  } catch (err) {
    console.error('Streams error:', err.message);
    return streams;
  }
}

// ============ استخراج رابط مباشر من سيرفر ============
async function extractFromServer(server, referer) {
  const links = [];
  try {
    const { data } = await axios.get(server.link, {
      headers: { ...HEADERS, Referer: referer },
      timeout: 10000,
      maxRedirects: 5
    });

    let html = typeof data === 'string' ? data : JSON.stringify(data);

    // فك Packed JS (eval(function(p,a,c,k,e,d)...))
    if (html.includes('eval(function(p,a,c,k,e,')) {
      const unpacked = unpackJS(html);
      if (unpacked) html += '\n' + unpacked;
    }

    // m3u8
    const m3u8Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.m3u8[^\s"'<>\\)]*/gi);
    if (m3u8Matches) {
      [...new Set(m3u8Matches)].forEach(url => 
        links.push({ url: url.replace(/\\\//g, '/'), quality: 'HLS m3u8' })
      );
    }

    // mp4
    const mp4Matches = html.match(/https?:\/\/[^\s"'<>\\)]+\.mp4[^\s"'<>\\)]*/gi);
    if (mp4Matches) {
      [...new Set(mp4Matches)].forEach(url => 
        links.push({ url: url.replace(/\\\//g, '/'), quality: 'MP4' })
      );
    }

    // file: "..." في المشغلات
    const fileMatches = html.match(/(?:file|src|source)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)/gi);
    if (fileMatches) {
      fileMatches.forEach(m => {
        const url = m.match(/["']([^"']+)["']/)?.[1];
        if (url && !links.find(l => l.url === url)) {
          links.push({ url, quality: 'Source' });
        }
      });
    }

  } catch (e) {
    console.log(`فشل ${server.name}:`, e.message);
  }
  return links;
}

// ============ فك تشفير JS Packer ============
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

// ============ المسارات (Routes) ============
app.get('/', (req, res) => {
  res.send(`
    <h1>ArabSeed Stremio Addon</h1>
    <p>رابط التثبيت: <a href="/manifest.json">/manifest.json</a></p>
  `);
});

app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type } = req.params;
  let extra = req.params.extra || '';
  extra = extra.replace('.json', '');
  
  const params = {};
  if (extra) {
    extra.split('&').forEach(p => {
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

  res.json({ metas });
});

app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const cacheKey = `meta_${id}`;
  let meta = getCache(cacheKey);
  
  if (!meta) {
    meta = await fetchMeta(id, type);
    if (meta) setCache(cacheKey, meta);
  }

  res.json({ meta: meta || {} });
});

app.get('/stream/:type/:id.json', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `stream_${id}`;
  let streams = getCache(cacheKey);
  
  if (!streams) {
    try {
      const url = decodeId(id);
      streams = await fetchStreams(url);
      if (streams.length > 0) setCache(cacheKey, streams);
    } catch (e) {
      console.error(e);
      streams = [];
    }
  }

  res.json({ streams });
});

// تشغيل محلي
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}/manifest.json`));
}

module.exports = app;
