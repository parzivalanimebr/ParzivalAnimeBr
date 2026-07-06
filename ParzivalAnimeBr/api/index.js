const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "2.1.0",
    name: "ParzivalAnimeBr",
    description: "Animes em português - busca nos melhores sites brasileiros.",
    resources: ["stream"],
    types: ["series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

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

// ─── Limpa a URL do iframe — remove parâmetros extras injetados pelo site ─────
// Ex: https://csst.online/embed/1017112&poster=https://... → https://csst.online/embed/1017112
function cleanEmbedUrl(raw) {
    try {
        // Se a URL tem parâmetros colados com & sem ? antes, corta no primeiro &
        // que não pertence ao host do embed
        const ampIdx = raw.indexOf('&');
        if (ampIdx !== -1 && !raw.includes('?')) {
            raw = raw.substring(0, ampIdx);
        }
        return new URL(raw).toString();
    } catch (e) {
        return raw;
    }
}

// ─── Extrator de MP4 do player (Playerjs) ────────────────────────────────────
//
// O player coloca as URLs diretamente no HTML:
//   file:"[360p]https://...mp4/,[720p]https://...mp4/,[1080p]https://...mp4/"
//
// Precisa enviar Referer correto para que o CDN (incvideo1.online) aceite
// servir o vídeo ao Stremio. Sem o Referer o player retorna 403.

async function extractMp4FromEmbed(rawEmbedUrl) {
    const embedUrl = cleanEmbedUrl(rawEmbedUrl);
    const cached = cache.get(`mp4:${embedUrl}`);
    if (cached) return cached;

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
        const streams = [];

        // Formato: [qualidade]url, ...
        const qualityRegex = /\[([^\]]+)\](https?:\/\/[^,\s"']+)/g;
        let match;
        while ((match = qualityRegex.exec(fileStr)) !== null) {
            streams.push({
                quality: match[1],
                url: match[2],
                // CORREÇÃO PRINCIPAL: passa o Referer do embed para o CDN aceitar
                behaviorHints: {
                    notWebReady: false,
                    proxyHeaders: {
                        request: { 'Referer': origin + '/', 'Origin': origin }
                    }
                }
            });
        }

        // Fallback: URLs soltas sem rótulo
        if (streams.length === 0) {
            const urlRegex = /(https?:\/\/[^\s,"']+\.mp4[^\s,"']*)/g;
            while ((match = urlRegex.exec(fileStr)) !== null) {
                streams.push({
                    quality: 'SD',
                    url: match[1],
                    behaviorHints: {
                        notWebReady: false,
                        proxyHeaders: {
                            request: { 'Referer': origin + '/', 'Origin': origin }
                        }
                    }
                });
            }
        }

        if (streams.length > 0) {
            console.log(`[extractMp4] ${streams.length} qualidade(s) extraída(s) de ${embedUrl}`);
            cache.set(`mp4:${embedUrl}`, streams);
        } else {
            console.error(`[extractMp4] nenhuma URL de vídeo em ${embedUrl}`);
        }

        return streams;

    } catch (e) {
        console.error(`[extractMp4] erro em ${embedUrl}:`, e.message);
        return [];
    }
}

// ─── Scraper: TopAnimes.net ───────────────────────────────────────────────────

async function scrapeTopAnimes(name, ep) {
    const cacheKey = `top:${name}:${ep}`;
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

            // Desembrulha /aviso/?url=...
            if (src.includes('/aviso/?url=')) {
                try {
                    const u = new URL(src, 'https://topanimes.net');
                    src = u.searchParams.get('url') || src;
                } catch (e) {}
            }

            const junk = ['disqus', 'facebook.com', 'twitter', 'doubleclick', 'googlesyndication', 'gstatic', 'youtube.com/sub'];
            if (junk.some(j => src.includes(j))) return;

            // Limpa parâmetros extras antes de guardar
            iframeSrcs.push(cleanEmbedUrl(src));
        });

        // Remove duplicatas
        const uniqueSrcs = [...new Set(iframeSrcs)];

        if (uniqueSrcs.length === 0) {
            console.error(`[topanimes] nenhum iframe em ${epUrl}`);
            return [];
        }

        console.log(`[topanimes] ${uniqueSrcs.length} iframe(s): ${uniqueSrcs.join(', ')}`);

        const streams = [];
        for (const src of uniqueSrcs) {
            const mp4s = await extractMp4FromEmbed(src);
            for (const item of mp4s) {
                streams.push({
                    title: `TopAnimes - ${item.quality}`,
                    url: item.url,
                    behaviorHints: item.behaviorHints
                });
            }
            if (mp4s.length === 0) {
                let hostLabel = src;
                try { hostLabel = new URL(src).hostname; } catch (e) {}
                streams.push({
                    title: `TopAnimes - ${hostLabel} (navegador)`,
                    externalUrl: src
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

builder.defineStreamHandler(async ({ type, id }) => {
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

    const withFallback = (p) => p.catch(() => []);
    const timeoutGuard = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 25000));

    // Apenas topanimes por enquanto — animesdigital bloqueia com 403 consistentemente
    const results = await Promise.race([
        Promise.all([
            withFallback(scrapeTopAnimes(name, ep))
        ]),
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
