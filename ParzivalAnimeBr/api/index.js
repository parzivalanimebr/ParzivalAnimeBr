const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "2.0.0",
    name: "ParzivalAnimeBr",
    description: "Animes em português - busca nos melhores sites brasileiros.",
    resources: ["stream"],
    types: ["series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// ─── Utilitários ─────────────────────────────────────────────────────────────

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
            'Referer': 'https://topanimes.net/',
            ...extraHeaders
        }
    });
    return res.data;
}

// ─── Extrator de MP4 do player csst.online / fsst.online ─────────────────────
//
// O player usa o padrão Playerjs. As URLs de vídeo ficam diretamente no HTML
// do embed, dentro do campo "file:" da configuração do player:
//
//   file:"[360p]https://...1017112_360p.mp4/,[720p]https://...1017112_720p.mp4/,[1080p]https://...1017112.mp4/"
//
// Basta um axios.get + regex para extrair — sem Puppeteer.

async function extractMp4FromEmbed(embedUrl) {
    const cached = cache.get(`mp4:${embedUrl}`);
    if (cached) return cached;

    try {
        const html = await fetchHtml(embedUrl, 12000, { 'Referer': embedUrl });

        // Extrai o bloco do campo file:"..."
        const fileMatch = html.match(/file\s*:\s*["']([^"']+)["']/);
        if (!fileMatch) {
            console.error(`[extractMp4] campo "file" não encontrado em ${embedUrl}`);
            return [];
        }

        const fileStr = fileMatch[1];
        const streams = [];

        // Formato: [qualidade]url,[qualidade]url,...
        // Também aceita URL única sem rótulo de qualidade
        const qualityRegex = /\[([^\]]+)\](https?:\/\/[^\s,]+)/g;
        let match;
        while ((match = qualityRegex.exec(fileStr)) !== null) {
            streams.push({ quality: match[1], url: match[2] });
        }

        // Se não encontrou nenhum com rótulo, tenta URLs soltas
        if (streams.length === 0) {
            const urlRegex = /(https?:\/\/[^\s,"']+\.mp4[^\s,"']*)/g;
            while ((match = urlRegex.exec(fileStr)) !== null) {
                streams.push({ quality: 'SD', url: match[1] });
            }
        }

        if (streams.length > 0) {
            console.log(`[extractMp4] ${streams.length} qualidade(s) extraída(s) de ${embedUrl}`);
            cache.set(`mp4:${embedUrl}`, streams);
        } else {
            console.error(`[extractMp4] nenhuma URL de vídeo encontrada em ${embedUrl}`);
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
        const searchHtml = await fetchHtml(`https://topanimes.net/?s=${search}`);
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
        const epHtml = await fetchHtml(epUrl);
        const $ep = cheerio.load(epHtml);

        // Coleta iframes válidos
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

            // Ignora iframes de anúncio/social
            const junk = ['disqus', 'facebook', 'twitter', 'doubleclick', 'google', 'gstatic', 'youtube.com/sub'];
            if (junk.some(j => src.includes(j))) return;

            iframeSrcs.push(src);
        });

        if (iframeSrcs.length === 0) {
            console.error(`[topanimes] nenhum iframe encontrado em ${epUrl}`);
            return [];
        }

        console.log(`[topanimes] ${iframeSrcs.length} iframe(s) encontrado(s): ${iframeSrcs.join(', ')}`);

        // Extrai MP4s de cada iframe
        const streams = [];
        for (const src of iframeSrcs) {
            const mp4s = await extractMp4FromEmbed(src);
            for (const { quality, url } of mp4s) {
                let hostLabel = src;
                try { hostLabel = new URL(src).hostname; } catch (e) {}
                streams.push({
                    title: `TopAnimes - ${quality}`,
                    url,
                    behaviorHints: { notWebReady: false }
                });
            }
            // Se não achou MP4, fallback para externalUrl
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

// ─── Scraper: AnimesDigital.org ───────────────────────────────────────────────

async function scrapeAnimesDigital(name, ep) {
    const cacheKey = `digi:${name}:${ep}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const search = encodeURIComponent(name.split(':')[0]);
        const searchHtml = await fetchHtml(`https://animesdigital.org/?s=${search}`);
        const $search = cheerio.load(searchHtml);

        let animeUrl = '';
        const targetName = norm(name.split(':')[0]);

        $search('article a, .item a, h2 a, h3 a').each((i, el) => {
            if (animeUrl) return;
            const href = $search(el).attr('href') || '';
            const text = norm($search(el).text());
            if (href.includes('/anime/') && text && (text.includes(targetName) || targetName.includes(text))) {
                animeUrl = href;
            }
        });

        if (!animeUrl) {
            console.error(`[animesdigital] anime não encontrado: "${name}"`);
            return [];
        }

        const animeHtml = await fetchHtml(animeUrl);
        const $anime = cheerio.load(animeHtml);

        let epUrl = '';
        const epRegexes = [
            new RegExp(`epis[oó]dio\\s*0*${ep}\\b`, 'i'),
            new RegExp(`\\bep\\s*0*${ep}\\b`, 'i')
        ];
        $anime('a').each((i, el) => {
            if (epUrl) return;
            const href = $anime(el).attr('href') || '';
            const text = $anime(el).text().trim();
            if (href.includes('/video/') && epRegexes.some(re => re.test(text))) {
                epUrl = href;
            }
        });

        if (!epUrl) {
            console.error(`[animesdigital] ep ${ep} não encontrado em ${animeUrl}`);
            return [];
        }

        const epHtml = await fetchHtml(epUrl);
        const $ep = cheerio.load(epHtml);

        const iframeSrcs = [];
        $ep('iframe').each((i, el) => {
            const src = $ep(el).attr('src') || $ep(el).attr('data-src');
            if (!src || !src.startsWith('http')) return;
            const junk = ['disqus', 'facebook', 'twitter', 'doubleclick', 'google', 'gstatic'];
            if (junk.some(j => src.includes(j))) return;
            iframeSrcs.push(src);
        });

        if (iframeSrcs.length === 0) {
            console.error(`[animesdigital] nenhum iframe em ${epUrl}`);
            return [];
        }

        const streams = [];
        for (const src of iframeSrcs) {
            const mp4s = await extractMp4FromEmbed(src);
            for (const { quality, url } of mp4s) {
                streams.push({
                    title: `AnimesDigital - ${quality}`,
                    url,
                    behaviorHints: { notWebReady: false }
                });
            }
            if (mp4s.length === 0) {
                let hostLabel = src;
                try { hostLabel = new URL(src).hostname; } catch (e) {}
                streams.push({
                    title: `AnimesDigital - ${hostLabel} (navegador)`,
                    externalUrl: src
                });
            }
        }

        cache.set(cacheKey, streams);
        return streams;

    } catch (e) {
        console.error('[animesdigital] erro:', e.message);
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

    // Timeout de 25s — suficiente para axios + regex, sem precisar de Puppeteer
    const timeoutGuard = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 25000));

    const results = await Promise.race([
        Promise.all([
            withFallback(scrapeTopAnimes(name, ep)),
            withFallback(scrapeAnimesDigital(name, ep))
        ]),
        timeoutGuard
    ]);

    if (results === 'TIMEOUT') {
        console.error('[handler] timeout atingido');
        return { streams: [] };
    }

    const streams = [...results[0], ...results[1]];
    console.log(`[handler] ${streams.length} stream(s) para "${name}" ep ${ep}`);
    return { streams };
});

// ─── Servidor ─────────────────────────────────────────────────────────────────

const app = express();
app.use(getRouter(builder.getInterface()));

// Vercel usa module.exports; local usa listen
if (process.env.VERCEL) {
    module.exports = app;
} else {
    const PORT = process.env.PORT || 7000;
    app.listen(PORT, () => {
        console.log(`ParzivalAnimeBr rodando em http://localhost:${PORT}/manifest.json`);
    });
    module.exports = app;
}
