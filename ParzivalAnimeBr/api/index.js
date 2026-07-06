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
        
        // Tenta encontrar o link do episódio de forma mais flexível
        let epLink = '';
        $('article a, .item a, .list-episodes a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes(ep)) epLink = href;
        });
        if (!epLink) return [];

        const epPage = await axios.get(`https://api.allorigins.win/get?url=${encodeURIComponent(epLink)}`, { timeout: 10000 });
        const epData = JSON.parse(epPage.data.contents);
        const $ep = cheerio.load(epData);
        
        let streams = [];
        // Captura QUALQUER iframe presente na página, aumentando a chance de sucesso
        $ep('iframe').each((i, el) => {
            let src = $ep(el).attr('src');
            if (src && (src.includes('player') || src.includes('embed') || src.includes('video'))) {
                streams.push({ title: `${type === 'top' ? 'TopAnimes' : 'AnimesDigital'} - Player ${i+1}`, url: src });
            }
        });
        return streams;
    } catch (e) { return []; }
}
