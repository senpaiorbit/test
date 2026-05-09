// Miruro API v2.0 — Node.js/Vercel conversion of the original Python FastAPI
// All logic ported 1:1 from api.py

const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));

const ANILIST_URL = 'https://graphql.anilist.co';
const MIRURO_PIPE_URL = 'https://www.miruro.tv/api/secure/pipe';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Referer': 'https://www.miruro.tv/',
};

// ─── Pipe Encoding/Decoding ─────────────────────────────────────────────────

function encodePipeRequest(payload) {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString('base64url').replace(/=+$/, '');
}

function decodePipeResponse(encodedStr) {
  // Pad and decode base64url → gzip → JSON
  const padded = encodedStr + '='.repeat((4 - (encodedStr.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  const zlib = require('zlib');
  const decompressed = zlib.gunzipSync(buf);
  return JSON.parse(decompressed.toString('utf-8'));
}

function translateId(encodedId) {
  try {
    const padded = encodedId + '='.repeat((4 - (encodedId.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64url').toString('utf-8');
    if (decoded.includes(':')) return decoded;
    return encodedId;
  } catch {
    return encodedId;
  }
}

function deepTranslate(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(item => { if (typeof item === 'object' && item) deepTranslate(item); });
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'id' && typeof value === 'string') {
        obj[key] = translateId(value);
      } else if (typeof value === 'object' && value) {
        deepTranslate(value);
      }
    }
  }
}

// ─── AniList GraphQL ────────────────────────────────────────────────────────

async function anilistQuery(query, variables = {}) {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw { status: 500, message: 'AniList query failed' };
  const json = await res.json();
  return json.data || {};
}

// ─── Pipe Fetch ─────────────────────────────────────────────────────────────

async function fetchRawEpisodes(anilistId) {
  const payload = {
    path: 'episodes',
    method: 'GET',
    query: { anilistId },
    body: null,
    version: '0.1.0',
  };
  const encoded = encodePipeRequest(payload);
  const res = await fetch(`${MIRURO_PIPE_URL}?e=${encoded}`, { headers: HEADERS });
  if (!res.ok) throw { status: res.status, message: 'Pipe request failed' };
  const text = await res.text();
  const data = decodePipeResponse(text.trim());
  deepTranslate(data);
  return data;
}

async function fetchSources(episodeId, provider, anilistId, category = 'sub') {
  const encId = Buffer.from(episodeId).toString('base64url').replace(/=+$/, '');
  const payload = {
    path: 'sources',
    method: 'GET',
    query: { episodeId: encId, provider, category, anilistId },
    body: null,
    version: '0.1.0',
  };
  const encoded = encodePipeRequest(payload);
  const res = await fetch(`${MIRURO_PIPE_URL}?e=${encoded}`, { headers: HEADERS });
  if (!res.ok) throw { status: res.status, message: 'Pipe request failed' };
  const text = await res.text();
  return decodePipeResponse(text.trim());
}

// ─── Slug Injection ─────────────────────────────────────────────────────────

function injectSourceSlugs(data, anilistId) {
  const providers = data.providers || {};
  for (const [providerName, providerData] of Object.entries(providers)) {
    if (!providerData || typeof providerData !== 'object') continue;
    let episodes = providerData.episodes;
    if (!episodes || typeof episodes !== 'object') continue;
    if (Array.isArray(episodes)) {
      providerData.episodes = { sub: episodes };
      episodes = providerData.episodes;
    }
    for (const [category, epList] of Object.entries(episodes)) {
      if (!Array.isArray(epList)) continue;
      for (const ep of epList) {
        if (!ep || typeof ep !== 'object') continue;
        if ('id' in ep && 'number' in ep) {
          const origId = ep.id;
          const prefix = origId.includes(':') ? origId.split(':')[0] : origId;
          ep.id = `watch/${providerName}/${anilistId}/${category}/${prefix}-${ep.number}`;
        }
      }
    }
  }
  return data;
}

// ─── GraphQL Fragments ───────────────────────────────────────────────────────

const MEDIA_LIST_FIELDS = `
  id
  title { romaji english native }
  coverImage { large extraLarge }
  bannerImage
  format
  season
  seasonYear
  episodes
  duration
  status
  averageScore
  meanScore
  popularity
  favourites
  genres
  source
  countryOfOrigin
  isAdult
  studios(isMain: true) { nodes { name isAnimationStudio } }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  startDate { year month day }
  endDate { year month day }
`;

const MEDIA_FULL_FIELDS = `
  id idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { large extraLarge color }
  bannerImage
  format season seasonYear episodes duration status
  averageScore meanScore popularity favourites trending
  genres
  tags { name rank isMediaSpoiler }
  source countryOfOrigin isAdult hashtag synonyms siteUrl
  trailer { id site thumbnail }
  studios { nodes { id name isAnimationStudio siteUrl } }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  startDate { year month day }
  endDate { year month day }
  characters(sort: [ROLE, RELEVANCE], perPage: 25) {
    edges {
      role
      node { id name { full native } image { large } }
      voiceActors(language: JAPANESE) { id name { full native } image { large } languageV2 }
    }
  }
  staff(sort: RELEVANCE, perPage: 25) {
    edges {
      role
      node { id name { full native } image { large } }
    }
  }
  relations {
    edges {
      relationType(version: 2)
      node {
        id title { romaji english native }
        coverImage { large } format type status episodes meanScore
      }
    }
  }
  recommendations(sort: RATING_DESC, perPage: 10) {
    nodes {
      rating
      mediaRecommendation {
        id title { romaji english native }
        coverImage { large } format episodes status meanScore averageScore
      }
    }
  }
  externalLinks { url site type }
  streamingEpisodes { title thumbnail url site }
  stats {
    scoreDistribution { score amount }
    statusDistribution { status amount }
  }
`;

// ─── Collection Helper ───────────────────────────────────────────────────────

async function fetchCollection(sortType, status, page = 1, perPage = 20) {
  const statusFilter = status ? `, status: ${status}` : '';
  const gql = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage lastPage hasNextPage perPage }
        media(type: ANIME, sort: [${sortType}]${statusFilter}) {
          ${MEDIA_LIST_FIELDS}
        }
      }
    }
  `;
  const data = await anilistQuery(gql, { page, perPage });
  const pageData = data.Page || {};
  const pageInfo = pageData.pageInfo || {};
  return {
    page: pageInfo.currentPage ?? page,
    perPage: pageInfo.perPage ?? perPage,
    total: pageInfo.total ?? 0,
    hasNextPage: pageInfo.hasNextPage ?? false,
    results: pageData.media || [],
  };
}

// ─── Security Middleware ─────────────────────────────────────────────────────

function checkAuth(req) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const validApiKey = process.env.API_KEY;

  const publicPaths = ['/', '/docs'];
  const path = req.url.split('?')[0];
  if (publicPaths.includes(path)) return true;

  // Check API key
  const apiKey = req.headers['x-api-key'];
  if (validApiKey && apiKey === validApiKey) return true;

  // If no restrictions configured, allow all
  if (!allowedOrigins.length) return true;

  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  return allowedOrigins.some(a => origin.startsWith(a) || referer.startsWith(a));
}

// ─── Router ─────────────────────────────────────────────────────────────────

function parseQuery(urlStr) {
  const url = new URL(urlStr, 'http://localhost');
  const params = {};
  url.searchParams.forEach((v, k) => { params[k] = v; });
  return params;
}

function matchPath(pattern, path) {
  // pattern like /watch/:provider/:anilist_id/:category/:slug
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

const SORT_MAP = {
  SCORE_DESC: 'SCORE_DESC',
  POPULARITY_DESC: 'POPULARITY_DESC',
  TRENDING_DESC: 'TRENDING_DESC',
  START_DATE_DESC: 'START_DATE_DESC',
  FAVOURITES_DESC: 'FAVOURITES_DESC',
  UPDATED_AT_DESC: 'UPDATED_AT_DESC',
};

// ─── Main Handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  if (!checkAuth(req)) {
    return res.status(403).json({ detail: 'Access forbidden: Invalid Origin, Referer, or API Key.' });
  }

  const rawPath = req.url.split('?')[0];
  const q = parseQuery(req.url);

  const json = (data, status = 200) => res.status(status).json(data);
  const err = (status, message) => res.status(status).json({ detail: message });

  try {

    // ── GET / ──────────────────────────────────────────────────────────────
    if (rawPath === '/' || rawPath === '') {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(getHomepage());
    }

    // ── GET /search ────────────────────────────────────────────────────────
    if (rawPath === '/search') {
      if (!q.query) return err(422, 'query parameter is required');
      const page = Math.max(1, parseInt(q.page) || 1);
      const perPage = Math.min(50, Math.max(1, parseInt(q.per_page) || 20));
      const gql = `
        query ($search: String, $page: Int, $perPage: Int) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage perPage }
            media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
              ${MEDIA_LIST_FIELDS}
            }
          }
        }
      `;
      const data = await anilistQuery(gql, { search: q.query, page, perPage });
      const pageData = data.Page || {};
      const pageInfo = pageData.pageInfo || {};
      return json({
        page: pageInfo.currentPage ?? page,
        perPage: pageInfo.perPage ?? perPage,
        total: pageInfo.total ?? 0,
        hasNextPage: pageInfo.hasNextPage ?? false,
        results: pageData.media || [],
      });
    }

    // ── GET /suggestions ───────────────────────────────────────────────────
    if (rawPath === '/suggestions') {
      if (!q.query) return err(422, 'query parameter is required');
      const gql = `
        query ($search: String) {
          Page(page: 1, perPage: 8) {
            media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
              id title { romaji english }
              coverImage { large }
              format status
              startDate { year }
              episodes
            }
          }
        }
      `;
      const data = await anilistQuery(gql, { search: q.query });
      const results = (data.Page?.media || []).map(item => ({
        id: item.id,
        title: item.title?.english || item.title?.romaji,
        title_romaji: item.title?.romaji,
        poster: item.coverImage?.large,
        format: item.format,
        status: item.status,
        year: item.startDate?.year,
        episodes: item.episodes,
      }));
      return json({ suggestions: results });
    }

    // ── GET /filter ────────────────────────────────────────────────────────
    if (rawPath === '/filter') {
      const page = Math.max(1, parseInt(q.page) || 1);
      const perPage = Math.min(50, Math.max(1, parseInt(q.per_page) || 20));
      const sort = SORT_MAP[q.sort] || 'POPULARITY_DESC';
      const args = [`type: ANIME`, `sort: [${sort}]`];
      const variables = { page, perPage };
      const varTypes = ['$page: Int', '$perPage: Int'];

      if (q.genre)   { args.push('genre: $genre');           variables.genre = q.genre;               varTypes.push('$genre: String'); }
      if (q.tag)     { args.push('tag: $tag');               variables.tag = q.tag;                   varTypes.push('$tag: String'); }
      if (q.year)    { args.push('seasonYear: $seasonYear'); variables.seasonYear = parseInt(q.year); varTypes.push('$seasonYear: Int'); }
      if (q.season)  { args.push('season: $season');         variables.season = q.season.toUpperCase(); varTypes.push('$season: MediaSeason'); }
      if (q.format)  { args.push('format: $format');         variables.format = q.format.toUpperCase(); varTypes.push('$format: MediaFormat'); }
      if (q.status)  { args.push('status: $status');         variables.status = q.status.toUpperCase(); varTypes.push('$status: MediaStatus'); }

      const gql = `
        query (${varTypes.join(', ')}) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage perPage }
            media(${args.join(', ')}) {
              ${MEDIA_LIST_FIELDS}
            }
          }
        }
      `;
      const data = await anilistQuery(gql, variables);
      const pageData = data.Page || {};
      const pageInfo = pageData.pageInfo || {};
      return json({
        page: pageInfo.currentPage ?? page,
        perPage: pageInfo.perPage ?? perPage,
        total: pageInfo.total ?? 0,
        hasNextPage: pageInfo.hasNextPage ?? false,
        results: pageData.media || [],
      });
    }

    // ── GET /spotlight ────────────────────────────────────────────────────
    if (rawPath === '/spotlight') {
      const gql = `
        query {
          Page(page: 1, perPage: 10) {
            media(sort: [TRENDING_DESC, POPULARITY_DESC], type: ANIME) {
              ${MEDIA_LIST_FIELDS}
            }
          }
        }
      `;
      const data = await anilistQuery(gql);
      return json({ results: data.Page?.media || [] });
    }

    // ── GET /trending ─────────────────────────────────────────────────────
    if (rawPath === '/trending') {
      const page = parseInt(q.page) || 1;
      const perPage = Math.min(50, parseInt(q.per_page) || 20);
      return json(await fetchCollection('TRENDING_DESC', null, page, perPage));
    }

    // ── GET /popular ──────────────────────────────────────────────────────
    if (rawPath === '/popular') {
      const page = parseInt(q.page) || 1;
      const perPage = Math.min(50, parseInt(q.per_page) || 20);
      return json(await fetchCollection('POPULARITY_DESC', null, page, perPage));
    }

    // ── GET /upcoming ─────────────────────────────────────────────────────
    if (rawPath === '/upcoming') {
      const page = parseInt(q.page) || 1;
      const perPage = Math.min(50, parseInt(q.per_page) || 20);
      return json(await fetchCollection('POPULARITY_DESC', 'NOT_YET_RELEASED', page, perPage));
    }

    // ── GET /recent ───────────────────────────────────────────────────────
    if (rawPath === '/recent') {
      const page = parseInt(q.page) || 1;
      const perPage = Math.min(50, parseInt(q.per_page) || 20);
      return json(await fetchCollection('START_DATE_DESC', 'RELEASING', page, perPage));
    }

    // ── GET /schedule ─────────────────────────────────────────────────────
    if (rawPath === '/schedule') {
      const page = parseInt(q.page) || 1;
      const perPage = Math.min(50, parseInt(q.per_page) || 20);
      const gql = `
        query ($page: Int, $perPage: Int) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage perPage }
            airingSchedules(notYetAired: true, sort: TIME) {
              episode airingAt timeUntilAiring
              media { ${MEDIA_LIST_FIELDS} }
            }
          }
        }
      `;
      const data = await anilistQuery(gql, { page, perPage });
      const pageData = data.Page || {};
      const pageInfo = pageData.pageInfo || {};
      const results = (pageData.airingSchedules || []).map(item => ({
        ...item.media,
        next_episode: item.episode,
        airingAt: item.airingAt,
        timeUntilAiring: item.timeUntilAiring,
      }));
      return json({
        page: pageInfo.currentPage ?? page,
        perPage: pageInfo.perPage ?? perPage,
        total: pageInfo.total ?? 0,
        hasNextPage: pageInfo.hasNextPage ?? false,
        results,
      });
    }

    // ── GET /info/:id ─────────────────────────────────────────────────────
    let m = matchPath('/info/:id', rawPath);
    if (m) {
      const id = parseInt(m.id);
      if (isNaN(id)) return err(422, 'Invalid anilist_id');
      const gql = `
        query ($id: Int) {
          Media(id: $id, type: ANIME) { ${MEDIA_FULL_FIELDS} }
        }
      `;
      const data = await anilistQuery(gql, { id });
      if (!data.Media) return err(404, 'Anime not found');
      return json(data.Media);
    }

    // ── GET /anime/:id/characters ─────────────────────────────────────────
    m = matchPath('/anime/:id/characters', rawPath);
    if (m) {
      const id = parseInt(m.id);
      const page = parseInt(q.page) || 1;
      const perPage = Math.min(50, parseInt(q.per_page) || 25);
      const gql = `
        query ($id: Int, $page: Int, $perPage: Int) {
          Media(id: $id, type: ANIME) {
            id title { romaji english }
            characters(sort: [ROLE, RELEVANCE], page: $page, perPage: $perPage) {
              pageInfo { total currentPage lastPage hasNextPage perPage }
              edges {
                role
                node {
                  id name { full native userPreferred }
                  image { large medium }
                  description gender
                  dateOfBirth { year month day }
                  age favourites siteUrl
                }
                voiceActors { id name { full native } image { large } languageV2 }
              }
            }
          }
        }
      `;
      const data = await anilistQuery(gql, { id, page, perPage });
      if (!data.Media) return err(404, 'Anime not found');
      const chars = data.Media.characters || {};
      const pageInfo = chars.pageInfo || {};
      return json({
        page: pageInfo.currentPage ?? page,
        perPage: pageInfo.perPage ?? perPage,
        total: pageInfo.total ?? 0,
        hasNextPage: pageInfo.hasNextPage ?? false,
        characters: chars.edges || [],
      });
    }

    // ── GET /anime/:id/relations ──────────────────────────────────────────
    m = matchPath('/anime/:id/relations', rawPath);
    if (m) {
      const id = parseInt(m.id);
      const gql = `
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id title { romaji english }
            relations {
              edges {
                relationType(version: 2)
                node {
                  id title { romaji english native }
                  coverImage { large } bannerImage
                  format type status episodes chapters
                  meanScore averageScore popularity
                  startDate { year month day }
                }
              }
            }
          }
        }
      `;
      const data = await anilistQuery(gql, { id });
      if (!data.Media) return err(404, 'Anime not found');
      return json({
        id: data.Media.id,
        title: data.Media.title,
        relations: data.Media.relations?.edges || [],
      });
    }

    // ── GET /anime/:id/recommendations ────────────────────────────────────
    m = matchPath('/anime/:id/recommendations', rawPath);
    if (m) {
      const id = parseInt(m.id);
      const page = parseInt(q.page) || 1;
      const perPage = Math.min(25, parseInt(q.per_page) || 10);
      const gql = `
        query ($id: Int, $page: Int, $perPage: Int) {
          Media(id: $id, type: ANIME) {
            id title { romaji english }
            recommendations(sort: RATING_DESC, page: $page, perPage: $perPage) {
              pageInfo { total currentPage lastPage hasNextPage perPage }
              nodes {
                rating
                mediaRecommendation {
                  id title { romaji english native }
                  coverImage { large extraLarge } bannerImage
                  format episodes status meanScore averageScore popularity genres
                  startDate { year }
                }
              }
            }
          }
        }
      `;
      const data = await anilistQuery(gql, { id, page, perPage });
      if (!data.Media) return err(404, 'Anime not found');
      const recs = data.Media.recommendations || {};
      const pageInfo = recs.pageInfo || {};
      return json({
        page: pageInfo.currentPage ?? page,
        perPage: pageInfo.perPage ?? perPage,
        total: pageInfo.total ?? 0,
        hasNextPage: pageInfo.hasNextPage ?? false,
        recommendations: recs.nodes || [],
      });
    }

    // ── GET /episodes/:id ─────────────────────────────────────────────────
    m = matchPath('/episodes/:id', rawPath);
    if (m) {
      const anilistId = parseInt(m.id);
      const data = await fetchRawEpisodes(anilistId);
      return json(injectSourceSlugs(data, anilistId));
    }

    // ── GET /sources ──────────────────────────────────────────────────────
    if (rawPath === '/sources') {
      const { episodeId, provider, anilistId, category = 'sub' } = q;
      if (!episodeId || !provider || !anilistId) {
        return err(422, 'episodeId, provider, and anilistId are required');
      }
      return json(await fetchSources(episodeId, provider, parseInt(anilistId), category));
    }

    // ── GET /watch/:provider/:anilistId/:category/:slug ───────────────────
    // Note: slug itself may contain dashes, so we match with a prefix pattern
    const watchMatch = rawPath.match(/^\/watch\/([^/]+)\/(\d+)\/([^/]+)\/(.+)$/);
    if (watchMatch) {
      const [, provider, anilistIdStr, category, slug] = watchMatch;
      const anilistId = parseInt(anilistIdStr);
      const data = await fetchRawEpisodes(anilistId);
      const provData = data.providers?.[provider] || {};
      let epList = provData.episodes?.[category] || [];
      if (!Array.isArray(epList)) epList = [];

      let targetId = null;
      for (const ep of epList) {
        const origId = ep.id || '';
        const prefix = origId.includes(':') ? origId.split(':')[0] : origId;
        const generated = `${prefix}-${ep.number}`;
        if (generated === slug) { targetId = origId; break; }
      }
      if (!targetId) {
        return err(404, `Episode slug '${slug}' not found for provider ${provider}`);
      }
      return json(await fetchSources(targetId, provider, anilistId, category));
    }

    return err(404, 'Route not found');

  } catch (e) {
    if (e && e.status) return err(e.status, e.message);
    console.error(e);
    return err(500, 'Internal server error');
  }
}

// ─── Homepage HTML ────────────────────────────────────────────────────────────

function getHomepage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miruro API v2.0</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700&display=swap" rel="stylesheet">
  <style>
    * { margin:0;padding:0;box-sizing:border-box;font-family:'Outfit',sans-serif;transition:all .3s ease }
    body { background:radial-gradient(circle at top,#0f172a,#020617);color:#e2e8f0;min-height:100vh;padding:50px 20px }
    .container { max-width:960px;margin:0 auto;background:rgba(30,41,59,.5);backdrop-filter:blur(10px);padding:40px;border-radius:24px;border:1px solid rgba(255,255,255,.05);box-shadow:0 20px 40px rgba(0,0,0,.5) }
    .header { text-align:center;margin-bottom:50px }
    .logo { width:120px;border-radius:20px;box-shadow:0 0 30px rgba(56,189,248,.3);border:1px solid rgba(255,255,255,.1);margin-bottom:25px }
    h1 { font-size:3em;font-weight:700;background:linear-gradient(to right,#38bdf8,#818cf8);-webkit-background-clip:text;color:transparent;margin-bottom:10px }
    .subtitle { color:#94a3b8;font-size:1.1em;font-weight:300 }
    .version { display:inline-block;background:rgba(56,189,248,.15);color:#38bdf8;padding:4px 14px;border-radius:20px;font-size:.85em;margin-top:10px;border:1px solid rgba(56,189,248,.2) }
    .section-title { font-size:1.3em;font-weight:700;color:#818cf8;margin:35px 0 15px;border-left:3px solid #818cf8;padding-left:12px }
    .endpoint { background:rgba(15,23,42,.8);border-left:4px solid #38bdf8;padding:25px;margin:15px 0;border-radius:0 16px 16px 0;border:1px solid rgba(255,255,255,.02) }
    .endpoint:hover { transform:translateX(5px);box-shadow:0 10px 20px rgba(0,0,0,.2);border-left-color:#818cf8;background:rgba(30,41,59,.9) }
    .method { color:#10b981;font-weight:700;background:rgba(16,185,129,.1);padding:4px 10px;border-radius:6px;font-size:.9em;margin-right:10px }
    .url { font-family:monospace;color:#cbd5e1;font-size:1.1em }
    .desc { color:#cbd5e1;font-size:1em;margin-top:10px;font-weight:300;line-height:1.6 }
    .params { margin-top:10px;font-size:.85em;color:#64748b;font-family:monospace;line-height:1.8 }
    .params span { color:#a5b4fc }
    a { color:#38bdf8;text-decoration:none;word-break:break-all;font-weight:500 }
    a:hover { color:#818cf8 }
    .footer { text-align:center;margin-top:50px;color:#475569;font-size:.9em;border-top:1px solid rgba(255,255,255,.05);padding-top:20px }
    .badge { display:inline-block;font-size:.7em;padding:2px 8px;border-radius:6px;margin-left:8px;font-weight:500;vertical-align:middle }
    .badge-new { background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3) }
    .note { background:rgba(250,204,21,.08);border:1px solid rgba(250,204,21,.15);border-radius:10px;padding:14px 18px;margin-top:12px;font-size:.88em;color:#fbbf24;line-height:1.5 }
    .note b { color:#fde68a }
    .step-num { display:inline-block;background:rgba(56,189,248,.15);color:#38bdf8;width:26px;height:26px;text-align:center;line-height:26px;border-radius:50%;font-size:.85em;font-weight:700;margin-right:8px }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="https://www.miruro.to/icon-512x512.png" alt="Logo" class="logo">
      <h1>Miruro Native API</h1>
      <div class="subtitle">Node.js/Vercel port — decrypted anime streaming API</div>
      <div class="version">v2.0 — Node.js Edition</div>
    </div>

    <div class="section-title">🔍 Search &amp; Discovery</div>
    <div class="endpoint">
      <div><span class="method">GET</span> <span class="url">/search?query=</span></div>
      <div class="desc">Full-text anime search with 20+ metadata fields per result.</div>
      <div class="params">Params: <span>query</span> (required), <span>page</span>=1, <span>per_page</span>=20</div>
    </div>
    <div class="endpoint">
      <div><span class="method">GET</span> <span class="url">/suggestions?query=</span> <span class="badge badge-new">FAST</span></div>
      <div class="desc">Lightweight autocomplete — max 8 results, minimal fields.</div>
    </div>
    <div class="endpoint">
      <div><span class="method">GET</span> <span class="url">/filter</span></div>
      <div class="desc">Filter by genre, tag, year, season, format, status, sort. All optional.</div>
    </div>

    <div class="section-title">📊 Collections</div>
    <div class="endpoint"><div><span class="method">GET</span> <span class="url">/trending</span> · <span class="url">/popular</span> · <span class="url">/upcoming</span> · <span class="url">/recent</span> · <span class="url">/spotlight</span> · <span class="url">/schedule</span></div>
    <div class="desc">All accept page &amp; per_page. Return { page, perPage, total, hasNextPage, results[] }.</div></div>

    <div class="section-title">📖 Anime Details</div>
    <div class="endpoint"><div><span class="method">GET</span> <span class="url">/info/:anilist_id</span></div><div class="desc">Everything — characters, staff, relations, trailer, stats, recommendations.</div></div>
    <div class="endpoint"><div><span class="method">GET</span> <span class="url">/anime/:id/characters</span> · <span class="url">/anime/:id/relations</span> · <span class="url">/anime/:id/recommendations</span></div></div>

    <div class="section-title">▶️ Streaming (3-Step)</div>
    <div class="note"><b>Step 1:</b> <code>GET /episodes/:anilist_id</code> → get episode list with slugged IDs<br>
    <b>Step 2:</b> <code>GET /watch/:provider/:anilistId/:category/:slug</code> → get M3U8 + subtitles<br>
    <b>Step 3:</b> Feed <code>streams[0].url</code> into any HLS player</div>
    <div class="endpoint">
      <div><span class="step-num">2</span><span class="method">GET</span> <span class="url">/watch/{provider}/{anilistId}/{sub|dub}/{slug}</span></div>
      <div class="desc">Auto-resolves slug to provider ID, returns streams, subtitles, intro/outro timestamps.</div>
    </div>
    <div class="endpoint">
      <div><span class="method">GET</span> <span class="url">/sources?episodeId=&provider=&anilistId=&category=</span></div>
      <div class="desc">Legacy/manual sources endpoint.</div>
    </div>

    <div class="footer">
      Node.js port by Claude · Original Python by <a href="https://github.com/walterwhite-69" target="_blank">walterwhite-69</a>
    </div>
  </div>
</body>
</html>`;
}
