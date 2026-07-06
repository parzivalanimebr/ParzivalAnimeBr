const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.4",
    name: "ParzivalAnimeBr",
    description: "Busca animes otimizada.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

async function scrapeSite(urlBase, name, ep, type) {
    try {
        const search = encodeURIComponent(name.split(':')[0]);
        // Proxy para evitar 403 e garantir acesso aos sites
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(`${urlBase}/?s=${search}`)}`;
        const res = await axios.get(proxyUrl, { timeout: 5000 });
        const data = JSON.parse(res.data.contents);
        const $ = cheerio.load(data);
        
        let epLink = '';
        $('article a, .item a, .lista-episodios a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes(ep)) epLink = href;
        });
        if (!epLink) return [];

        const epPage = await axios.get(`https://api.allorigins.win/get?url=${encodeURIComponent(epLink)}`, { timeout: 5000 });
        const epData = JSON.parse(epPage.data.contents);
        const $ep = cheerio.load(epData);
        
        let streams = [];
        // Filtro específico para garantir que apenas players sejam retornados
        $ep('iframe').each((i, el) => {
            const src = $ep(el).attr('src');
            if (src && (src.includes('video') || src.includes('player') || src.includes('embed'))) {
                streams.push({ title: `${type === 'top' ? 'TopAnimes' : 'AnimesDigital'} - Player ${i+1}`, url: src });
            }
        });
        return streams;
    } catch (e) { return []; }
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (!id.startsWith("kitsu:") && !id.startsWith("tt")) return { streams: [] };
    
    let name = "";
    let ep = "1";
    try {
        if (id.startsWith("kitsu:")) {
            const parts = id.split(":");
            ep = parts[3] || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${parts[1]}`);
            name = res.data.data.attributes.canonicalTitle;
        } else {
            const parts = id.split(":");
            ep = parts[2] || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`);
            name = res.data.meta.name;
        }
    } catch (e) { return { streams: [] }; }

    // Execução paralela com timeout total controlado para evitar carregamento infinito
    const results = await Promise.all([
        scrapeSite('https://topanimes.net', name, ep, 'top'),
        scrapeSite('https://animesdigital.org', name, ep, 'digi')
    ]);
    
    return { streams: [...results[0], ...results[1]] };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
