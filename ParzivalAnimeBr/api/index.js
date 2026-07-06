const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 86400 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.2",
    name: "ParzivalAnimeBr",
    description: "Busca animes usando títulos em PT/EN e títulos originais (Romaji).",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: [] 
};

const builder = new addonBuilder(manifest);

// ==========================================
// FUNÇÕES DE SCRAPING
// ==========================================

async function scrapeSite(urlBase, animeName, episode, type) {
    try {
        const searchQuery = encodeURIComponent(`${animeName} Episódio ${episode}`);
        const response = await axios.get(`${urlBase}/?s=${searchQuery}`, { timeout: 7000 });
        const $ = cheerio.load(response.data);
        
        const epLink = $('article a, .item a').first().attr('href');
        if (!epLink) return [];

        const page = await axios.get(epLink, { timeout: 7000 });
        const $p = cheerio.load(page.data);

        let streams = [];
        const selector = type === 'top' ? '.source-box iframe' : '.pagEpiAbasContainer iframe.metaframe';
        
        $p(selector).each((i, el) => {
            let src = $p(el).attr('src');
            if (!src) return;
            
            // Decodificação de links comuns
            if (src.includes('/aviso/?url=')) {
                try { src = decodeURIComponent(new URL(src, urlBase).searchParams.get('url')); } catch(e) {}
            } else if (src.includes('?d=')) {
                try { src = new URL(src, urlBase).searchParams.get('d'); } catch(e) {}
            }
            
            streams.push({ title: `${type === 'top' ? 'TopAnimes' : 'AnimesDigital'} - Player ${i + 1}`, url: src });
        });
        return streams;
    } catch (e) { return []; }
}

// ==========================================
// HANDLER DE STREAM APRIMORADO
// ==========================================

builder.defineStreamHandler(async ({ type, id }) => {
    if (!id.startsWith("kitsu:") && !id.startsWith("tt")) return { streams: [] };
    if (cache.has(id)) return { streams: cache.get(id) };

    let nomesParaTentar = [];
    let episode = "1";

    try {
        if (id.startsWith("kitsu:")) {
            const [_, kitsuId, season, ep] = id.split(":");
            episode = ep || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`);
            const attrs = res.data.data.attributes;
            nomesParaTentar.push(attrs.canonicalTitle);
            if (attrs.titles.en_jp) nomesParaTentar.push(attrs.titles.en_jp);
        } else {
            const [ttId, season, ep] = id.split(":");
            episode = ep || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`);
            nomesParaTentar.push(res.data.meta.name);
            if (res.data.meta.originalTitle) nomesParaTentar.push(res.data.meta.originalTitle);
        }
    } catch (e) { return { streams: [] }; }

    // Tenta os nomes até achar algum stream
    let streams = [];
    for (const nome of [...new Set(nomesParaTentar)]) {
        const res = await Promise.allSettled([
            scrapeSite('https://topanimes.net', nome, episode, 'top'),
            scrapeSite('https://animesdigital.org', nome, episode, 'digi')
        ]);
        res.forEach(r => { if (r.status === "fulfilled") streams.push(...r.value); });
        if (streams.length > 0) break;
    }

    if (streams.length > 0) cache.set(id, streams);
    return { streams };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
