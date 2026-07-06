const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "2.3.0",
    name: "ParzivalAnimeBr",
    description: "Animes em português - busca nos melhores sites brasileiros.",
    resources: ["stream"],
    types: ["series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// ─── Base URL do próprio addon (para montar as URLs de proxy) ───────────────
// Vercel expõe VERCEL_URL automaticamente, mas ela muda a cada deploy de preview.
// Priorizamos um domínio fixo se configurado.
function getSelfBaseUrl(req) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
    if (req && req.headers && req.headers.host) {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        return `${proto}://${req.headers.host}`;
    }
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return 'http://localhost:7000';
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function norm(str) {
    return (str || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchHtml(url, timeout = 15000, extraHeaders = {}) {
    const res = await axios.get(url, {
        timeout,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...extraHeaders
        }
    });
    return res.data;
}

function cleanEmbedUrl(raw) {
    try {
        const u = new URL(raw);
        ['img', 'poster', 'thumbnail', 'image', 'cover'].forEach(p => u.searchParams.delete(p));
        return u.toString();
    } catch (e) {
        const m = raw.match(/^(https?:\/\/[^&]+)/);
        return m ? m[1] : raw;
    }
}

function extractDirectStream(src) {
    try {
        const u = new URL(src);
        if (u.pathname.match(/\.(m3u8|mp4)$/i)) {
            return { url: src, quality: 'HD' };
        }
        const id = u.searchParams.get('id') || '';
        if (id.match(/\.(m3u8|mp4)$/i)) {
            const base = u.origin + u.pathname;
            return { url: base + id, quality: 'HD' };
        }
        if (id.match(/\.mp4/i)) {
            return { url: id.startsWith('http') ? id : src, quality: 'HD' };
        }
    } catch (e) {}
    return null;
}

// Monta a URL de proxy que passa pelo NOSSO servidor, garantindo que o
// Referer/Origin corretos sejam enviados ao CDN independente do que o
// player (Nuvio/Stremio) suporte.
function buildProxyUrl(selfBase, targetUrl, referer) {
    const params = new URLSearchParams({
        url: targetUrl,
        ref: referer || ''
    });
    return `${selfBase}/proxy?${params.toString()}`;
}

// ─── Extrator de MP4/M3U8 do player Playerjs ─────────────────────────────────

async function extractMp4FromEmbed(rawEmbedUrl, selfBase) {
    const embedUrl = cleanEmbedUrl(rawEmbedUrl);

    const direct = extractDirectStream(embedUrl);
    if (direct) {
        console.log(`[extractMp4] stream direto detectado: ${direct.url}`);
        let origin = '';
        try { origin = new URL(embedUrl).origin; } catch (e) {}
        return [{
            quality: direct.quality,
            url: buildProxyUrl(selfBase, direct.url, origin + '/')
        }];
    }

    const cached = cache.get(`mp4:${embedUrl}`);
    if (cached) return cached.map(s => ({ ...s, url: buildProxyUrl(selfBase, s.rawUrl, s.referer) }));

    let origin;
    try { origin = new URL(embedUrl).origin; } catch (e) { origin = ''; }

    try {
        const html = await fetchHtml(embedUrl, 12000, {
            'Referer': origin + '/',
            'Origin': origin
        });

        const fileMatch = html.match(/file\s*:\s*["']([^"']{10,})["']/);
        if (!fileMatch) {
            console.error(`[extractMp4] campo "file" não encontrado em ${embedUrl}`);
            return [];
        }

        const fileStr = fileMatch[1];
        const rawStreams = [];

        const qualityRegex = /\[([^\]]+)\](https?:\/\/[^,\s"']+)/g;
        let match;
        while ((match = qualityRegex.exec(fileStr)) !== null) {
            rawStreams.push({ quality: match[1], rawUrl: match[2], referer: origin + '/' });
        }

        if (rawStreams.length === 0) {
            const urlRegex = /(https?:\/\/[^\s,"']+\.(mp4|m3u8)[^\s,"']*)/g;
            while ((match = urlRegex.exec(fileStr)) !== null) {
                rawStreams.push({ quality: 'SD', rawUrl: match[1], referer: origin + '/' });
            }
        }

        if (rawStreams.length > 0) {
            console.log(`[extractMp4] ${rawStreams.length} qualidade(s) de ${embedUrl}`);
            cache.set(`mp4:${embedUrl}`, rawStreams);
        } else {
            console.error(`[extractMp4] nenhuma URL de vídeo em ${embedUrl}`);
        }

        return rawStreams.map(s => ({
            quality: s.quality,
            url: buildProxyUrl(selfBase, s.rawUrl, s.referer)
        }));

    } catch (e) {
        console.error(`[extractMp4] erro em ${embedUrl}:`, e.message);
        return [];
    }
}

// ─── Scraper: TopAnimes.net ───────────────────────────────────────────────────

async function scrapeTopAnimes(name, ep, selfBase) {
    const cacheKey = `top:${name}:${ep}:${selfBase}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const search = encodeURIComponent(name.split(':')[0]);
        const searchHtml = await fetchHtml(`https://topanimes.net/?s=${search}`, 15000, {
            'Referer': 'https://topanimes.net/'
        });
        const $search = cheerio.load(searchHtml);

        let animeUrl = '';
        const targetName = norm(name.split(':')[0]);

        $search('article a, .item a, h2 a, h3 a').each((i, el) => {
            if (animeUrl) return;
            const href = $search(el).attr('href') || '';
            const text = norm($search(el).text());
            if (href.includes('/animes/') && text && (text.includes(targetName) || targetName.includes(text))) {
                animeUrl = href;
            }
        });

        if (!animeUrl) {
            console.error(`[topanimes] anime não encontrado: "${name}"`);
            return [];
        }

        const slugMatch = animeUrl.match(/\/animes\/([^\/]+)\/?/);
        if (!slugMatch) return [];
        const slug = slugMatch[1];

        const epUrl = `https://topanimes.net/episodio/${slug}-episodio-${ep}/`;
        const epHtml = await fetchHtml(epUrl, 15000, { 'Referer': animeUrl });
        const $ep = cheerio.load(epHtml);

        const iframeSrcs = [];
        $ep('iframe').each((i, el) => {
            let src = $ep(el).attr('src') || $ep(el).attr('data-src');
            if (!src || !src.startsWith('http')) return;

            if (src.includes('/aviso/?url=')) {
                try {
                    const u = new URL(src, 'https://topanimes.net');
                    src = u.searchParams.get('url') || src;
                } catch (e) {}
            }

            const junk = ['disqus', 'facebook.com', 'twitter', 'doubleclick', 'googlesyndication', 'gstatic', 'youtube.com/sub'];
            if (junk.some(j => src.includes(j))) return;

            iframeSrcs.push(src);
        });

        const uniqueSrcs = [...new Set(iframeSrcs)];

        if (uniqueSrcs.length === 0) {
            console.error(`[topanimes] nenhum iframe em ${epUrl}`);
            return [];
        }

        console.log(`[topanimes] ${uniqueSrcs.length} iframe(s): ${uniqueSrcs.join(', ')}`);

        const streams = [];
        for (const src of uniqueSrcs) {
            const mp4s = await extractMp4FromEmbed(src, selfBase);
            for (const item of mp4s) {
                streams.push({
                    title: `TopAnimes - ${item.quality}`,
                    url: item.url
                });
            }
            if (mp4s.length === 0) {
                let hostLabel = src;
                try { hostLabel = new URL(cleanEmbedUrl(src)).hostname; } catch (e) {}
                streams.push({
                    title: `TopAnimes - ${hostLabel} (navegador)`,
                    externalUrl: cleanEmbedUrl(src)
                });
            }
        }

        cache.set(cacheKey, streams);
        return streams;

    } catch (e) {
        console.error('[topanimes] erro:', e.message);
        return [];
    }
}

// ─── Handler principal ────────────────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id }, req) => {
    if (!id.startsWith("kitsu:") && !id.startsWith("tt")) return { streams: [] };

    let name = "";
    let ep = "1";

    try {
        if (id.startsWith("kitsu:")) {
            const parts = id.split(":");
            ep = parts[2] || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${parts[1]}`);
            name = res.data.data.attributes.canonicalTitle;
        } else {
            const parts = id.split(":");
            ep = parts[2] || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`);
            name = res.data.meta.name;
        }
    } catch (e) {
        console.error('[handler] erro ao resolver metadata:', e.message);
        return { streams: [] };
    }

    console.log(`[handler] buscando: "${name}" ep ${ep}`);

    // Determina a base URL pública para montar os links de proxy
    const selfBase = process.env.PUBLIC_URL || 'https://parzival-anime-br.vercel.app';

    const withFallback = (p) => p.catch(() => []);
    const timeoutGuard = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 25000));

    const results = await Promise.race([
        Promise.all([withFallback(scrapeTopAnimes(name, ep, selfBase))]),
        timeoutGuard
    ]);

    if (results === 'TIMEOUT') {
        console.error('[handler] timeout atingido');
        return { streams: [] };
    }

    const streams = [...results[0]];
    console.log(`[handler] ${streams.length} stream(s) para "${name}" ep ${ep}`);
    return { streams };
});

// ─── Servidor ─────────────────────────────────────────────────────────────────

const app = express();

// Endpoint de proxy: busca o vídeo no CDN de origem com o Referer/Origin
// corretos e repassa os bytes para o player (suporta Range para seek).
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const referer = req.query.ref || '';

    if (!targetUrl) {
        return res.status(400).send('Missing url parameter');
    }

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        };
        if (referer) {
            headers['Referer'] = referer;
            try { headers['Origin'] = new URL(referer).origin; } catch (e) {}
        }
        // Repassa o Range header do player para permitir seek/skip
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const upstream = await axios.get(targetUrl, {
            headers,
            responseType: 'stream',
            timeout: 20000,
            validateStatus: () => true // repassamos o status como veio
        });

        // Repassa os headers relevantes de volta ao player
        const passHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
        passHeaders.forEach(h => {
            if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
        });
        res.status(upstream.status);

        upstream.data.pipe(res);

        upstream.data.on('error', (err) => {
            console.error('[proxy] erro no stream upstream:', err.message);
            if (!res.headersSent) res.status(502).end();
            else res.end();
        });

    } catch (e) {
        console.error(`[proxy] erro ao buscar ${targetUrl}:`, e.message);
        if (!res.headersSent) res.status(502).send('Erro ao buscar o vídeo de origem');
    }
});

app.use(getRouter(builder.getInterface()));

if (process.env.VERCEL) {
    module.exports = app;
} else {
    const PORT = process.env.PORT || 7000;
    app.listen(PORT, () => {
        console.log(`ParzivalAnimeBr rodando em http://localhost:${PORT}/manifest.json`);
    });
    module.exports = app;
}
