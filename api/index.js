// api/index.js
const querystring = require('querystring');
const { manifest, catalogHandler, metaHandler, streamHandler } = require('../addon');

export default async function handler(req, res) {
  const url = req.url;

  // Set CORS headers for web compatibility
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (url === '/' || url === '/manifest.json') {
      return res.status(200).json(manifest);
    }

    const catalogMatch = url.match(/^\/catalog\/([^/]+)\/([^/]+)(?:\/(.+))?\.json$/);
    if (catalogMatch) {
      const [, type, id, extraStr] = catalogMatch;
      const extra = extraStr ? querystring.parse(extraStr) : {};
      const result = await catalogHandler({ type, id, extra });
      return res.status(200).json(result);
    }

    const streamMatch = url.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      const result = await streamHandler({ type, id: decodeURIComponent(id) });
      return res.status(200).json(result);
    }

    const metaMatch = url.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      const result = await metaHandler({ type, id: decodeURIComponent(id) });
      return res.status(200).json(result);
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
