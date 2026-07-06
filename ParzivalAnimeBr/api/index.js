const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.5",
    name: "ParzivalAnimeBr",
    description: "Busca animes otimizada.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// Faz o fetch via proxy allorigins e devolve o HTML já "desembrulhado"
async function fetchViaProxy(url, timeout = 8000) {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await axios.get(proxyUrl, { timeout });
    // allorigins às vezes retorna o objeto já parseado, às vezes como string
    const parsed = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return parsed.contents;
}

// Normaliza texto para comparar (remove acento, minúsculo, espaços extras)
function norm(str) {
    return (str || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

async function scrapeSite(urlBase, name, ep, type) {
    const cacheKey = `scrape:${urlBase}:${name}:${ep}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const search = encodeURIComponent(name.split(':')[0]);

        // 1) Busca no site -> pega o link da página do anime
        const searchHtml = await fetchViaProxy(`${urlBase}/?s=${search}`);
        const $search = cheerio.load(searchHtml);

        let animeLink = '';
        const targetName = norm(name.split(':')[0]);
        $search('article a, .item a, h2 a, h3 a').each((i, el) => {
            if (animeLink) return;
            const href = $search(el).attr('href');
            const text = norm($search(el).text());
            if (href && text && (text.includes(targetName) || targetName.includes(text))) {
                animeLink = href;
            }
        });
        // Fallback: se não achou por nome, pega o primeiro link de card
        if (!animeLink) {
            animeLink = $search('article a, .item a').first().attr('href') || '';
        }
        if (!animeLink) {
            console.error(`[${type}] nenhum link de anime encontrado na busca por "${name}"`);
            return [];
        }

        // 2) Abre a página do anime -> lista de episódios
        const animeHtml = await fetchViaProxy(animeLink);
        const $anime = cheerio.load(animeHtml);

        let epLink = '';
        const epRegexes = [
            new RegExp(`epis[oó]dio\\s*0*${ep}\\b`, 'i'),
            new RegExp(`\\bep\\s*0*${ep}\\b`, 'i'),
            new RegExp(`[\\/-]0*${ep}[\\/-]?$`)
        ];
        $anime('a').each((i, el) => {
            if (epLink) return;
            const href = $anime(el).attr('href') || '';
            const text = $anime(el).text().trim();
            const haystack = `${text} ${href}`;
            if (epRegexes.some(re => re.test(haystack))) {
                epLink = href;
            }
        });
        if (!epLink) {
            console.error(`[${type}] episodio ${ep} nao encontrado na pagina ${animeLink}`);
            return [];
        }

        // 3) Abre a página do episódio -> pega os players (iframes)
        const epHtml = await fetchViaProxy(epLink);
        const $ep = cheerio.load(epHtml);

        let streams = [];
        $ep('iframe').each((i, el) => {
            const src = $ep(el).attr('src') || $ep(el).attr('data-src');
            if (src && src.startsWith('http')) {
                streams.push({
                    title: `${type === 'top' ? 'TopAnimes' : 'AnimesDigital'} - Player ${i + 1}`,
                    url: src
                });
            }
        });

        if (streams.length === 0) {
            console.error(`[${type}] nenhum iframe encontrado em ${epLink}`);
        }

        cache.set(cacheKey, streams);
        return streams;
    } catch (e) {
        console.error(`[scrapeSite ${urlBase}] erro:`, e.message);
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
        scrapeSite('https://topanimes.net', name, ep, 'top'),
        scrapeSite('https://animesdigital.org', name, ep, 'digi')
    ]);

    return { streams: [...results[0], ...results[1]] };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
