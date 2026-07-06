const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

// Configuração do cache
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
        const response = await axios.get(searchUrl, { timeout: 7000 });
        const $ = cheerio.load(response.data);
        
        const episodeUrl = $('article a, .item a').first().attr('href');
        if (!episodeUrl) return streams;

        const epPage = await axios.get(episodeUrl, { timeout: 7000 });
        const $ep = cheerio.load(epPage.data);

        $ep('.source-box iframe').each((index, el) => {
            let src = $ep(el).attr('src');
            if (!src) return;
            let finalUrl = src;
            if (src.includes('/aviso/?url=')) {
                try {
                    const u = new URL(src.startsWith('http') ? src : `https://topanimes.net${src}`);
                    const encoded = u.searchParams.get('url');
                    if (encoded) finalUrl = decodeURIComponent(encoded);
                } catch (e) {}
            }
            streams.push({ title: `TopAnimes - Player ${index + 1}`, url: finalUrl });
        });
    } catch (e) { console.error("Erro TopAnimes:", e.message); }
    return streams;
}

async function scrapeAnimesDigital(animeName, episode) {
    const streams = [];
    try {
        const searchQuery = encodeURIComponent(`${animeName} Episódio ${episode}`);
        const searchUrl = `https://animesdigital.org/?s=${searchQuery}`;
        const response = await axios.get(searchUrl, { timeout: 7000 });
        const $ = cheerio.load(response.data);
        
        const episodeUrl = $('article a, .item a').first().attr('href');
        if (!episodeUrl) return streams;

        const epPage = await axios.get(episodeUrl, { timeout: 7000 });
        const $ep = cheerio.load(epPage.data);

        $ep('.pagEpiAbasContainer iframe.metaframe').each((index, el) => {
            let src = $ep(el).attr('src');
            if (!src) return;
            let finalUrl = src;
            try {
                const u = new URL(src.startsWith('http') ? src : `https://animesdigital.org${src}`);
                if (u.searchParams.has('d')) finalUrl = u.searchParams.get('d');
            } catch (e) {}
            streams.push({ title: `AnimesDigital - Player ${index + 1}`, url: finalUrl });
        });
    } catch (e) { console.error("Erro AnimesDigital:", e.message); }
    return streams;
}

// ==========================================
// HANDLER DE STREAM
// ==========================================

async function buscarStreams(name, ep) {
    const results = await Promise.allSettled([scrapeTopAnimes(name, ep), scrapeAnimesDigital(name, ep)]);
    let streams = [];
    results.forEach(res => { if (res.status === "fulfilled") streams.push(...res.value); });
    return streams;
}

builder.defineStreamHandler(async ({ type, id }) => {
    console.log("Request recebida para ID:", id);
    if (!id.startsWith("kitsu:") && !id.startsWith("tt")) return { streams: [] };
    if (cache.has(id)) return { streams: cache.get(id) };

    let animeName = "";
    let episode = "1";

    try {
        if (id.startsWith("kitsu:")) {
            const [_, kitsuId, season, ep] = id.split(":");
            episode = ep || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`);
            animeName = res.data.data.attributes.canonicalTitle;
        } else {
            const [ttId, season, ep] = id.split(":");
            episode = ep || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`);
            animeName = res.data.meta.name;
        }
    } catch (e) { return { streams: [] }; }

    const streams = await buscarStreams(animeName, episode);
    if (streams.length > 0) cache.set(id, streams);
    return { streams };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
