const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 86400 });

const manifest = {
    id: "org.parzivalanimebr",
    version: "1.0.3",
    name: "ParzivalAnimeBr",
    description: "Busca animes com bypass de proteção.",
    resources: ["stream"],
    types: ["anime", "series", "movie"],
    idPrefixes: ["kitsu:", "tt"],
    catalogs: [] 
};

const builder = new addonBuilder(manifest);

async function scrapeSite(urlBase, name, ep, type) {
    try {
        const search = encodeURIComponent(name.split(':')[0]);
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(`${urlBase}/?s=${search}`)}`;
        const res = await axios.get(proxyUrl, { timeout: 10000 });
        const data = JSON.parse(res.data.contents);
        const $ = cheerio.load(data);
        
        let epLink = '';
        $('article a, .item a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes(ep)) epLink = href;
        });
        if (!epLink) return [];

        const epPage = await axios.get(`https://api.allorigins.win/get?url=${encodeURIComponent(epLink)}`, { timeout: 10000 });
        const epData = JSON.parse(epPage.data.contents);
        const $ep = cheerio.load(epData);
        
        let streams = [];
        const selector = type === 'top' ? '.source-box iframe' : '.pagEpiAbasContainer iframe.metaframe';
        
        $ep(selector).each((i, el) => {
            let src = $ep(el).attr('src');
            if (src) streams.push({ title: `${type === 'top' ? 'TopAnimes' : 'AnimesDigital'} - Player ${i+1}`, url: src });
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
            const [_, kId, s, e] = id.split(":");
            ep = e || "1";
            const res = await axios.get(`https://kitsu.io/api/edge/anime/${kId}`);
            name = res.data.data.attributes.canonicalTitle;
        } else {
            const [ttId, s, e] = id.split(":");
            ep = e || "1";
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`);
            name = res.data.meta.name;
        }
    } catch (e) { return { streams: [] }; }

    const results = await Promise.all([
        scrapeSite('https://topanimes.net', name, ep, 'top'),
        scrapeSite('https://animesdigital.org', name, ep, 'digi')
    ]);
    
    return { streams: [...results[0], ...results[1]] };
});

const app = express();
app.use(getRouter(builder.getInterface()));
module.exports = app;
