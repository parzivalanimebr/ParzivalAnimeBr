const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "2.2.0",
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

// ─── Limpa a URL do iframe ────────────────────────────────────────────────────
// Remove parâmetros de tracking/decoração injetados pelo site:
//   &img=, &poster=, &thumbnail=, etc.
// Mantém parâmetros que fazem parte do embed (ex: ?id=...)
function cleanEmbedUrl(raw) {
    try {
        const u = new URL(raw);
        // Remove parâmetros que são decoração visual, não parte do player
        ['img', 'poster', 'thumbnail', 'image', 'cover'].forEach(p => u.searchParams.delete(p));
        // Remove parâmetros colados sem ? (ex: url&img=...)
        return u.toString();
    } catch (e) {
        // Se não é URL válida, tenta cortar no primeiro & suspeito
        const m = raw.match(/^(https?:\/\/[^&]+)/);
        return m ? m[1] : raw;
    }
}

// ─── Detecta se a URL já é um stream direto (.m3u8 ou .mp4) ─────────────────
// Alguns iframes do topanimes têm o stream direto num parâmetro `id`
// Ex: https://topanimes.net/antivirus2/yes/?id=sbt/.../cdn_stream.m3u8
function extractDirectStream(src) {
    try {
        const u = new URL(src);
        // Caso 1: a própria URL termina em .m3u8 ou .mp4
        if (u.pathname.match(/\.(m3u8|mp4)$/i)) {
            return { url: src, quality: 'HD' };
        }
        // Caso 2: parâmetro "id" contém o caminho do stream
        const id = u.searchParams.get('id') || '';
        if (id.match(/\.(m3u8|mp4)$/i)) {
            // Reconstrói a URL base + o caminho do id
            // Ex: https://topanimes.net/antivirus2/yes/ + sbt/.../cdn_stream.m3u8
            const base = u.origin + u.pathname;
            return { url: base + id, quality: 'HD' };
        }
        // Caso 3: a URL já é .mp4 direto (como sk-ru.alibabacdn.net)
        const idFull = u.searchParams.get('id') || '';
        if (idFull.match(/\.mp4/i)) {
            return { url: idFull.startsWith('http') ? idFull : src, quality: 'HD' };
        }
    } catch (e) {}
    return null;
}

// ─── Extrator de MP4/M3U8 do player Playerjs ─────────────────────────────────
// O player coloca as URLs diretamente no HTML:
//   file:"[360p]https://...mp4/,[720p]https://...mp4/,[1080p]https://...mp4/"
// Envia Referer correto para que o CDN aceite servir o vídeo.

async function extractMp4FromEmbed(rawEmbedUrl) {
    const embedUrl = cleanEmbedUrl(rawEmbedUrl);

    // Verifica se já é um stream direto antes de tentar fetch
    const direct = extractDirectStream(embedUrl);
    if (direct) {
        console.log(`[extractMp4] stream direto detectado: ${direct.url}`);
        return [{ ...direct, behaviorHints: { notWebReady: false } }];
    }

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

        // Formato: [qualidade]url,...
        const qualityRegex = /\[([^\]]+)\](https?:\/\/[^,\s"']+)/g;
        let match;
        while ((match = qualityRegex.exec(fileStr)) !== null) {
            streams.push({
                quality: match[1],
                url: match[2],
                // Passa Referer do embed para o CDN aceitar a requisição do Stremio
                behaviorHints: {
                    notWebReady: false,
                    proxyHeaders: {
                        request: { 'Referer': origin + '/', 'Origin': origin }
                    }
                }
            });
        }

        // Fallback: URLs soltas
        if (streams.length === 0) {
            const urlRegex = /(https?:\/\/[^\s,"']+\.(mp4|m3u8)[^\s,"']*)/g;
            while ((match = urlRegex.exec(fileStr)) !== null) {
                streams.push({
                    quality: 'SD',
                    url: match[1],
                    behaviorHints: { notWebReady: false, proxyHeaders: { request: { 'Referer': origin + '/' } } }
                });
            }
        }

        if (streams.length > 0) {
            console.log(`[extractMp4] ${streams.length} qualidade(s) de ${embedUrl}`);
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

            iframeSrcs.push(src); // guarda a URL original, cleanEmbedUrl é feito dentro do extrator
        });

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

    const results = await Promise.race([
        Promise.all([withFallback(scrapeTopAnimes(name, ep))]),
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
