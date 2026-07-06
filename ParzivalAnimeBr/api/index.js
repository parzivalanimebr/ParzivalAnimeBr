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
    version: "1.0.0",
    name: "ParzivalAnimeBr",
    description: "Fornece streams diretos extraídos do TopAnimes e AnimesDigital.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:"],
    catalogs: [] 
};

const builder = new addonBuilder(manifest);

// ==========================================
// FUNÇÕES DE SCRAPING (INDEPENDENTES)
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
                    if (encodedUrl) {
                        finalUrl = decodeURIComponent(encodedUrl);
                    }
                } catch (parseError) {
                    console.error("TopAnimes - Falha ao parsear URL:", parseError.message);
                }
            }

            streams.push({
                title: `TopAnimes - Player ${index + 1}`,
                url: finalUrl
            });
        });

    } catch (error) {
        console.error(`[TopAnimes Scraper] Erro:`, error.message);
    }
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
                if (urlObj.searchParams.has('d')) {
                    finalUrl = urlObj.searchParams.get('d');
                }
            } catch (parseError) {
                console.error("AnimesDigital - Falha ao parsear URL:", parseError.message);
            }

            streams.push({
                title: `AnimesDigital - Player ${index + 1}`,
                url: finalUrl
            });
        });

    } catch (error) {
        console.error(`[AnimesDigital Scraper] Erro:`, error.message);
    }
    return streams;
}

// ==========================================
// FLUXO PRINCIPAL DO STREMIO
// ==========================================

builder.defineStreamHandler(async ({ type, id }) => {
    if (!id.startsWith("kitsu:")) {
        return Promise.resolve({ streams: [] });
    }

    if (cache.has(id)) {
        return Promise.resolve({ streams: cache.get(id) });
    }

    const [prefix, kitsuId, season, episode] = id.split(":");
    let animeName = "";

    try {
        const kitsuResponse = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`);
        animeName = kitsuResponse.data.data.attributes.canonicalTitle;
    } catch (error) {
        console.error(`[API Kitsu] Erro na tradução do ID ${kitsuId}`);
        return Promise.resolve({ streams: [] });
    }

    const results = await Promise.allSettled([
        scrapeTopAnimes(animeName, episode),
        scrapeAnimesDigital(animeName, episode)
    ]);

    const finalStreams = [];

    results.forEach(result => {
        if (result.status === "fulfilled" && result.value.length > 0) {
            finalStreams.push(...result.value);
        }
    });

    if (finalStreams.length > 0) {
        cache.set(id, finalStreams);
    }

    return Promise.resolve({ streams: finalStreams });
});

// ==========================================
// EXPORTAÇÃO PARA VERCEL (SERVERLESS)
// ==========================================
const app = express();
app.use(getRouter(builder.getInterface()));

module.exports = app;