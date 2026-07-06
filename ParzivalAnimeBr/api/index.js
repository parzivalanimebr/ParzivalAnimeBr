const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

// ==========================================
// CONFIGURAÇÕES E CACHE
// ==========================================
const cache = new NodeCache({ stdTTL: 86400 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.1",
    name: "ParzivalAnimeBr",
    description: "Fornece streams diretos extraídos do TopAnimes e AnimesDigital.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: [] 
};

const builder = new addonBuilder(manifest);

// ==========================================
// FUNÇÕES DE SCRAPING
// ==========================================

async function scrapeTopAnimes(animeName, episode) {
    const streams = [];
    try {
        const searchQuery = encodeURIComponent(`${animeName} Episódio ${episode}`);
        const searchUrl = `https://topanimes.net/?s=${searchQuery}`;
        
        const searchResponse = await axios.get(searchUrl, { timeout: 7000 });
        const $search = cheerio.load(searchResponse.data);
        
        const episodeUrl = $search('article a, .item a').first().attr('href');
        if (!episodeUrl) return streams;

        const episodeResponse = await axios.get(episodeUrl, { timeout: 7000 });
        const $ = cheerio.load(episodeResponse.data);

        $('.source-box iframe').each((index, element) => {
            let src = $(element).attr('src');
            if (!src) return;
            let finalUrl = src;
            if (src.includes('/aviso/?url=')) {
                try {
                    const urlObj = new URL(src.startsWith('http') ? src : `https://topanimes.net${src}`);
                    const encodedUrl = urlObj.searchParams.get('url');
                    if (encodedUrl) finalUrl = decodeURIComponent(encodedUrl);
                } catch (e) { console.error("TopAnimes - Falha ao parsear URL"); }
            }
            streams.push({ title: `TopAnimes - Player ${index + 1}`, url: finalUrl });
        });
    } catch (error) { console.error(`[TopAnimes Scraper] Erro:`, error.message); }
    return streams;
}

async function scrapeAnimesDigital(animeName, episode) {
    const streams = [];
    try {
        const searchQuery = encodeURIComponent(`${animeName} Episódio ${episode}`);
        const searchUrl = `https://animesdigital.org/?s=${searchQuery}`;
        
        const searchResponse = await axios.get(searchUrl, { timeout: 7000 });
        const $search = cheerio.load(searchResponse.data);
        
        const episodeUrl = $search('article a, .item a').first().attr('href');
        if (!episodeUrl) return streams;

        const episodeResponse = await axios.get(episodeUrl, { timeout: 7000 });
        const $ = cheerio.load(episodeResponse.data);

        $('.pagEpiAbasContainer iframe.metaframe').each((index, element) => {
            let src = $(element).attr('src');
            if (!src) return;
            let finalUrl = src;
            try {
                const urlObj = new URL(src.startsWith('http') ? src : `https://animesdigital.org${src}`);
                if (urlObj.searchParams.has('d')) finalUrl = urlObj.searchParams.get('d');
            } catch (e) { console.error("AnimesDigital - Falha ao parsear URL"); }
            streams.push({ title: `AnimesDigital - Player ${index + 1}`, url: finalUrl });
        });
    } catch (error) { console.error(`[AnimesDigital Scraper] Erro:`, error.message); }
    return streams;
}

// ==========================================
// FLUXO PRINCIPAL
// ==========================================

builder.defineStreamHandler(async ({ type, id }) => {
    if (!id.startsWith("kitsu:") && !id.startsWith("tt")) return Promise.resolve({ streams: [] });
    if (cache.has(id)) return Promise.resolve({ streams: cache.get(id) });

    let animeName = "";
    let episode = "1";

    try {
        if (id.startsWith("kitsu:")) {
            const [prefix, kitsuId, season, ep] = id.split(":");
            episode = ep || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`);
            animeName = res.data.data.attributes.canonicalTitle;
        } else if (id.startsWith("tt")) {
            const [ttId, season, ep] = id.split(":");
            episode = ep || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`);
            animeName = res.data.meta.name;
        }
    } catch (e) { return Promise.resolve({ streams: [] }); }

    const results = await Promise.allSettled([
        scrapeTopAnimes(animeName, episode),
        scrapeAnimesDigital(animeName, episode)
    ]);

    const finalStreams = [];
    results.forEach(res => { if (res.status === "fulfilled") finalStreams.push(...res.value); });
    if (finalStreams.length > 0) cache.set(id, finalStreams);

    return Promise.resolve({ streams: finalStreams });
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
