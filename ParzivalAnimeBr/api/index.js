const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.9",
    name: "ParzivalAnimeBr",
    description: "Busca animes otimizada.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// CORS so existe no navegador - rodando em Node (servidor) podemos chamar o
// site direto, sem proxy. Isso elimina o allorigins.win (lento/instavel, era
// a causa dos timeouts de 15-17s vistos nos logs) do meio do caminho.
async function fetchViaProxy(url, timeout = 6000) {
    const res = await axios.get(url, {
        timeout,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document'
        }
    });
    return res.data;
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

// Dominios que aparecem como <iframe> mas nunca sao o player do episodio
// (ads, comentarios, redes sociais, analytics). Ajuste essa lista conforme
// os logs [debug] forem mostrando o que sobra.
const JUNK_IFRAME_HOSTS = [
    'disqus.com', 'disquscdn.com',
    'facebook.com', 'twitter.com', 'x.com',
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'google.com/recaptcha', 'gstatic.com',
    'youtube.com/subscribe_embed'
];

function isJunkIframe(src) {
    return JUNK_IFRAME_HOSTS.some(h => src.includes(h));
}

// Streams desses sites sao paginas de player em JS (embed), nao arquivos de
// midia direta (.mp4/.m3u8). O Stremio nao consegue "tocar" uma pagina HTML
// como se fosse video, entao usamos externalUrl: ele abre no navegador do
// aparelho, onde o player em JS roda normalmente.
function makeExternalStream(sourceName, index, embedUrl) {
    let hostLabel = `Player ${index + 1}`;
    try { hostLabel = new URL(embedUrl).hostname; } catch (e) { /* mantem fallback */ }
    return {
        title: `${sourceName} - ${hostLabel} (abre no navegador)`,
        externalUrl: embedUrl,
        behaviorHints: { notWebReady: true }
    };
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

        // Iframes: alguns sao players diretos, outros sao a pagina "/aviso/?url=..."
        // que embrulha o link real do player dentro do parametro url= — precisa
        // desembrulhar antes de usar.
        $ep('iframe').each((i, el) => {
            const src = $ep(el).attr('src') || $ep(el).attr('data-src');
            if (!src || !src.startsWith('http') || isJunkIframe(src)) return;

            let realUrl = src;
            if (src.includes('/aviso/?url=')) {
                try {
                    const u = new URL(src, 'https://topanimes.net');
                    realUrl = u.searchParams.get('url') || src;
                } catch (e) { /* mantem src original se der erro */ }
            }
            streams.push(makeExternalStream('TopAnimes', i, realUrl));
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
            console.error(`[animesdigital][debug] iframe encontrado: ${src}`); // temporario p/ diagnostico
            if (src && src.startsWith('http') && !isJunkIframe(src)) {
                streams.push(makeExternalStream('AnimesDigital', i, src));
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

    // Se um dos sites travar, devolve o que já foi achado em vez de deixar o
    // Stremio esperando (limite total de 12s, bem abaixo do timeout do Vercel).
    const withFallback = (p) => p.catch(() => []);
    const timeoutGuard = new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 12000));

    const results = await Promise.race([
        Promise.all([
            withFallback(scrapeTopAnimes(name, ep)),
            withFallback(scrapeAnimesDigital(name, ep))
        ]),
        timeoutGuard
    ]);

    if (results === 'TIMEOUT') {
        console.error('[defineStreamHandler] timeout geral atingido, devolvendo vazio');
        return { streams: [] };
    }

    return { streams: [...results[0], ...results[1]] };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
