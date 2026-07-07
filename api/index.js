const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.3.1",
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

// Muitos sites de anime usam a biblioteca "Playerjs" pro player em JS, e o
// link real do arquivo de video fica solto em texto puro dentro do HTML, no
// formato: file:"[360p]https://...mp4/,[720p]https://...mp4/,[1080p]https://...mp4/"
// Isso deixa extrair o link direto sem precisar rodar JS nenhum.
function resolvePlayerJsSources(html) {
    const match = html.match(/file\s*:\s*"([^"]+)"/);
    if (!match) return [];

    const raw = match[1];
    const qualities = [];
    const re = /\[(\d+p)\]([^,\[]+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        qualities.push({ quality: m[1], url: m[2].trim() });
    }
    // Se nao tinha tags de qualidade [360p] etc, trata o valor inteiro como uma unica URL
    if (qualities.length === 0 && /^https?:\/\//.test(raw)) {
        qualities.push({ quality: 'padrão', url: raw.split(',')[0].trim() });
    }
    return qualities;
}

// URL base do proprio deployment. Em vez de confiar em variaveis de ambiente
// (que podem vir vazias dependendo da plataforma/quando o servico foi
// criado - foi a causa de "carrega mas nao acha nada" nunca aparecer no
// log, porque o link gerado caia pra localhost e o player nem conseguia
// chegar no servidor), pegamos o host da PROPRIA requisicao que chega.
const { AsyncLocalStorage } = require('async_hooks');
const requestContext = new AsyncLocalStorage();

function getBaseUrl() {
    const store = requestContext.getStore();
    if (store && store.baseUrl) return store.baseUrl;
    // fallback, so deve ser usado se algo chamar isso fora de uma requisicao HTTP
    return process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : (process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`);
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Tenta resolver um link de embed (iframe) para arquivo de video direto.
// Se conseguir, retorna streams "nativos" que passam pelo NOSSO proxy
// (/proxy/stream), que busca o video no CDN com o Referer certo e repassa os
// bytes pro player. Isso evita depender do player suportar headers
// customizados (proxyHeaders nao e respeitado por todo cliente Stremio).
// Se nao conseguir extrair o link direto, cai pro externalUrl (abre no
// navegador) como ultimo recurso.
async function resolveEmbedToStreams(sourceName, index, embedUrl, originSiteUrl) {
    try {
        const html = await fetchViaProxy(embedUrl, 6000);
        const sources = resolvePlayerJsSources(html);
        if (sources.length > 0) {
            const embedOrigin = new URL(embedUrl).origin;
            return sources.map(s => {
                const proxied = `${getBaseUrl()}/proxy/stream?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(embedOrigin + '/')}`;
                return {
                    title: `${sourceName} - ${s.quality}`,
                    url: proxied
                };
            });
        }
    } catch (e) {
        console.error(`[resolveEmbedToStreams] falhou em ${embedUrl}:`, e.message);
    }
    // fallback: abre a pagina do player no navegador
    return [makeExternalStream(sourceName, index, embedUrl)];
}
// Streams desses sites sao paginas de player em JS (embed), nao arquivos de
// midia direta (.mp4/.m3u8). Quando nao conseguimos extrair o link direto,
// usamos externalUrl como ultimo recurso: ele abre no navegador do aparelho.
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

        // Iframes: alguns sao players diretos, outros sao a pagina "/aviso/?url=..."
        // que embrulha o link real do player dentro do parametro url= — precisa
        // desembrulhar antes de usar.
        const candidates = [];
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
            candidates.push(realUrl);
        });

        // Pra cada candidato, tenta extrair o link direto do arquivo de video
        // (Playerjs); se nao conseguir, cai pro externalUrl como ultimo recurso.
        const resolved = await Promise.all(
            candidates.map((url, i) => resolveEmbedToStreams('TopAnimes', i, url, 'https://topanimes.net'))
        );
        let streams = resolved.flat();

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

        const candidates = [];
        $ep('iframe').each((i, el) => {
            const src = $ep(el).attr('src') || $ep(el).attr('data-src');
            if (src && src.startsWith('http') && !isJunkIframe(src)) {
                candidates.push(src);
            }
        });

        const resolved = await Promise.all(
            candidates.map((url, i) => resolveEmbedToStreams('AnimesDigital', i, url, 'https://animesdigital.org'))
        );
        let streams = resolved.flat();

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
    const timeoutGuard = new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 20000));

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

// Captura o host real de cada requisicao (funciona atras de qualquer proxy/
// plataforma, sem depender de variavel de ambiente) e deixa disponivel pra
// quem estiver montando URLs durante essa requisicao (ex: getBaseUrl()).
app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    requestContext.run({ baseUrl: `${proto}://${host}` }, next);
});

// Repassa o video do CDN pro player, com o Referer/User-Agent corretos,
// sem depender do cliente Stremio suportar headers customizados.
// Suporta Range (necessario pra avançar/voltar no video).
app.get('/proxy/stream', async (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).send('missing url');

    try {
        const upstream = await axios.get(url, {
            responseType: 'stream',
            timeout: 15000,
            headers: {
                'User-Agent': UA,
                'Referer': referer || '',
                ...(req.headers.range ? { Range: req.headers.range } : {})
            },
            validateStatus: () => true
        });

        res.status(upstream.status);
        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
            if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
        });
        if (!upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', 'bytes');

        upstream.data.pipe(res);
        upstream.data.on('error', (err) => {
            console.error('[proxy/stream] erro no stream upstream:', err.message);
            res.end();
        });
    } catch (e) {
        console.error('[proxy/stream] erro:', e.message);
        res.status(502).send('proxy error');
    }
});

app.use(getRouter(builder.getInterface()));

// Na Vercel (funcao serverless) so exportamos o app - a plataforma cuida do
// resto. Só que funções serverless da Vercel têm limite de 4.5MB por
// resposta, então o /proxy/stream NUNCA vai conseguir mandar um vídeo
// inteiro por lá (por isso "carregava e não tocava" - a resposta era
// cortada no meio). Fora da Vercel (ex: Render.com, ou local), rodamos como
// servidor tradicional de verdade, sem esse limite - é isso que faz o
// /proxy/stream funcionar de fato.
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`ParzivalAnimeBr rodando na porta ${PORT}`));
}

module.exports = app;
