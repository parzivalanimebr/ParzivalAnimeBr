const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 86400 });

// Configuração do navegador para evitar bloqueios 403
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.2",
    name: "ParzivalAnimeBr",
    description: "Busca animes usando títulos em PT/EN e títulos originais.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: [] 
};

const builder = new addonBuilder(manifest);

// ==========================================
// FUNÇÕES DE SCRAPING COM HEADERS
// ==========================================

async function scrapeSite(urlBase, animeName, episode, type) {
    try {
        const searchQuery = encodeURIComponent(`${animeName} Episódio ${episode}`);
        const response = await axios.get(`${urlBase}/?s=${searchQuery}`, { timeout: 7000, headers });
        const $ = cheerio.load(response.data);
        
        const epLink = $('article a, .item a').first().attr('href');
        if (!epLink) return [];

        const epPage = await axios.get(epLink, { timeout: 7000, headers });
        const $ep = cheerio.load(epPage.data);

        let streams = [];
        const selector = type === 'top' ? '.source-box iframe' : '.pagEpiAbasContainer iframe.metaframe';
        
        $ep(selector).each((i, el) => {
            let src = $ep(el).attr('src');
            if (!src) return;
            
            if (src.includes('/aviso/?url=')) {
                try { src = decodeURIComponent(new URL(src, urlBase).searchParams.get('url')); } catch(e) {}
            } else if (src.includes('?d=')) {
                try { src = new URL(src, urlBase).searchParams.get('d'); } catch(e) {}
            }
            
            streams.push({ title: `${type === 'top' ? 'TopAnimes' : 'AnimesDigital'} - Player ${i + 1}`, url: src });
        });
        return streams;
    } catch (e) { 
        console.error(`Erro ao buscar em ${urlBase}:`, e.message); 
        return []; 
    }
}

// ==========================================
// HANDLER DE STREAM
// ==========================================

async function buscarStreams(name, ep) {
    const results = await Promise.allSettled([
        scrapeSite('https://topanimes.net', name, ep, 'top'),
        scrapeSite('https://animesdigital.org', name, ep, 'digi')
    ]);
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
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { headers });
            animeName = res.data.data.attributes.canonicalTitle;
        } else {
            const [ttId, season, ep] = id.split(":");
            episode = ep || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`, { headers });
            animeName = res.data.meta.name;
        }
    } catch (e) { return { streams: [] }; }

    const streams = await buscarStreams(animeName, episode);
    if (streams.length > 0) cache.set(id, streams);
    
    console.log(`[Finalizado] Retornando ${streams.length} streams para ${animeName}`);
    return { streams };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
