// manifest.js
const manifest = {
  id: 'org.arabseed.asd.proxy',
  version: '1.2.0',
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

module.exports = { manifest };
