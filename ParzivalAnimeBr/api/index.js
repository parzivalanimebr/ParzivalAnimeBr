const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.6",
    name: "ParzivalAnimeBr",
    description: "Busca animes otimizada.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

async function fetchViaProxy(url, timeout = 10000) {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await axios.get(proxyUrl, { timeout });
    const parsed = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return parsed.contents;
}

function norm(str) {
    return (str || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// Slugifica um nome no mesmo padrão usado nas URLs dos sites (minusculo, hifens)
function slugify(str) {
    return norm(str).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// -------------------- TOPANIMES.NET --------------------
async function scrapeTopAnimes(name, ep) {
    const cacheKey = `top:${name}:${ep}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        // 1) Busca -> descobre o slug real do anime (nem sempre é igual ao slugify ingênuo)
        const search = encodeURIComponent(name.split(':')[0]);
        const searchHtml = await fetchViaProxy(`https://topanimes.net/?s=${search}`);
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
            console.error(`[topanimes] anime nao encontrado na busca: "${name}"`);
            return [];
        }

        // extrai o slug de https://topanimes.net/animes/{slug}/
        const slugMatch = animeUrl.match(/\/animes\/([^\/]+)\/?/);
        if (!slugMatch) return [];
        const slug = slugMatch[1];

        // 2) Monta a URL do episódio direto (padrao confirmado do site)
        const epUrl = `https://topanimes.net/episodio/${slug}-episodio-${ep}/`;
        const epHtml = await fetchViaProxy(epUrl);
        const $ep = cheerio.load(epHtml);

        let streams = [];

        // Players "aviso": o link real do player vem dentro do parametro ?url=
        $ep('a[href*="/aviso/?url="]').each((i, el) => {
            const href = $ep(el).attr('href');
            try {
                const u = new URL(href, 'https://topanimes.net');
                const real = u.searchParams.get('url');
                if (real) {
                    streams.push({ title: `TopAnimes - Player ${i + 1}`, url: real });
                }
            } catch (e) { /* ignora link malformado */ }
        });

        // Iframes "de verdade", se existirem
        $ep('iframe').each((i, el) => {
            const src = $ep(el).attr('src') || $ep(el).attr('data-src');
            if (src && src.startsWith('http')) {
                streams.push({ title: `TopAnimes - Player iframe ${i + 1}`, url: src });
            }
        });

        if (streams.length === 0) {
            console.error(`[topanimes] nenhum player extraido em ${epUrl} (provavelmente ofuscado via JS)`);
        }

        cache.set(cacheKey, streams);
        return streams;
    } catch (e) {
        console.error('[topanimes] erro:', e.message);
        return [];
    }
}

// -------------------- ANIMESDIGITAL.ORG --------------------
async function scrapeAnimesDigital(name, ep) {
    const cacheKey = `digi:${name}:${ep}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const search = encodeURIComponent(name.split(':')[0]);
        const searchHtml = await fetchViaProxy(`https://animesdigital.org/?s=${search}`);
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
            console.error(`[animesdigital] anime nao encontrado (ou bloqueado por anti-bot) para "${name}"`);
            return [];
        }

        // A pagina do anime lista os episodios com link /video/a/{id}/ - o id nao segue padrao fixo
        const animeHtml = await fetchViaProxy(animeUrl);
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
            console.error(`[animesdigital] episodio ${ep} nao encontrado em ${animeUrl}`);
            return [];
        }

        const epHtml = await fetchViaProxy(epUrl);
        const $ep = cheerio.load(epHtml);

        let streams = [];
        $ep('iframe').each((i, el) => {
            const src = $ep(el).attr('src') || $ep(el).attr('data-src');
            if (src && src.startsWith('http')) {
                streams.push({ title: `AnimesDigital - Player ${i + 1}`, url: src });
            }
        });

        if (streams.length === 0) {
            console.error(`[animesdigital] nenhum player extraido em ${epUrl}`);
        }

        cache.set(cacheKey, streams);
        return streams;
    } catch (e) {
        // Se o site tiver protecao anti-bot (Cloudflare), o proxy provavelmente
        // vai receber uma pagina de desafio em vez do HTML real, e isso cai aqui.
        console.error('[animesdigital] erro (pode ser bloqueio anti-bot):', e.message);
        return [];
    }
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (!id.startsWith("kitsu:") && !id.startsWith("tt")) return { streams: [] };

    let name = "";
    let ep = "1";
    try {
        if (id.startsWith("kitsu:")) {
            // Formato Stremio: kitsu:<anime_id>:<episodio>
            const parts = id.split(":");
            ep = parts[2] || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${parts[1]}`);
            name = res.data.data.attributes.canonicalTitle;
        } else {
            // Formato Stremio: tt<imdb_id>:<temporada>:<episodio>
            const parts = id.split(":");
            ep = parts[2] || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`);
            name = res.data.meta.name;
        }
    } catch (e) {
        console.error('[defineStreamHandler] erro ao resolver metadata:', e.message);
        return { streams: [] };
    }

    const results = await Promise.all([
        scrapeTopAnimes(name, ep),
        scrapeAnimesDigital(name, ep)
    ]);

    return { streams: [...results[0], ...results[1]] };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
