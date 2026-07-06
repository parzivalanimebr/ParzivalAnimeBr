const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 86400 });
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' };

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.2",
    name: "ParzivalAnimeBr",
    description: "Busca animes.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: [] 
};

const builder = new addonBuilder(manifest);

// Scraper unificado
async function scrapeSite(urlBase, name, ep, type) {
    try {
        const search = encodeURIComponent(`${name} Episódio ${ep}`);
        const res = await axios.get(`${urlBase}/?s=${search}`, { timeout: 7000, headers });
        const $ = cheerio.load(res.data);
        const epLink = $('article a, .item a').first().attr('href');
        if (!epLink) return [];
        const page = await axios.get(epLink, { timeout: 7000, headers });
        const $p = cheerio.load(page.data);
        let streams = [];
        $p(type === 'top' ? '.source-box iframe' : '.pagEpiAbasContainer iframe.metaframe').each((i, el) => {
            let src = $p(el).attr('src');
            if (src) streams.push({ title: `${type} - Player ${i+1}`, url: src });
        });
        return streams;
    } catch (e) { return []; }
}

builder.defineStreamHandler(async ({ type, id }) => {
    // Retorno de segurança para garantir que o manifesto funcione
    if (!id.startsWith("kitsu:") && !id.startsWith("tt")) return { streams: [] };
    
    // Log minimalista para não quebrar a resposta
    console.log("Processando:", id);

    try {
        let name = "";
        let ep = "1";
        if (id.startsWith("kitsu:")) {
            const [_, kId, s, e] = id.split(":");
            ep = e || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kId}`, { headers });
            name = res.data.data.attributes.canonicalTitle;
        } else {
            const [ttId, s, e] = id.split(":");
            ep = e || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`, { headers });
            name = res.data.meta.name;
        }

        const s1 = await scrapeSite('https://topanimes.net', name, ep, 'top');
        const s2 = await scrapeSite('https://animesdigital.org', name, ep, 'digi');
        return { streams: [...s1, ...s2] };
    } catch (e) {
        return { streams: [] };
    }
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
