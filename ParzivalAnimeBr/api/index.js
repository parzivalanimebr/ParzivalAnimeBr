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


// Função auxiliar de busca simplificada
async function scrapeSite(urlBase, animeName, episode, type) {
    try {
        // Remove caracteres especiais e reduz o nome para facilitar o encontro no site
        const slug = animeName
            .toLowerCase()
            .replace(/[:!?]/g, "")
            .replace(/\s+/g, "-");
        
        // Tenta buscar usando o nome simplificado, que se aproxima dos slugs dos sites
        const searchUrl = `${urlBase}/?s=${encodeURIComponent(animeName.split(':')[0])}`;
        const response = await axios.get(searchUrl, { timeout: 7000, headers });
        const $ = cheerio.load(response.data);
        
        // Pega o primeiro link que contenha o número do episódio no título ou link
        let episodeUrl = '';
        $('article a, .item a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes(episode)) {
                episodeUrl = href;
                return false; // para o loop
            }
        });

        if (!episodeUrl) return [];

        const epPage = await axios.get(episodeUrl, { timeout: 7000, headers });
        const $ep = cheerio.load(epPage.data);
        // ... (resto da lógica de extração de iframe igual à anterior)
