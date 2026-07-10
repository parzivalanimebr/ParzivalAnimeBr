// animesonlineto - bundled provider
// http.js
const BASE_URL = 'https://animesonlineto.to';

async function fetchJson(url, opts = {}) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': BASE_URL + '/',
            'Origin': BASE_URL,
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'DNT': '1',
            'Sec-GPC': '1'
        },
        ...opts
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
}

// extractor.js
function normalize(str) {
    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleToSlug(title) {
    return normalize(title)
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function generateTitleVariations(rawTitle) {
    const variations = [rawTitle];
    if (rawTitle.includes(':')) {
        variations.unshift(rawTitle.split(':')[0].trim());
    }
    variations.push(rawTitle.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim());
    return [...new Set(variations)];
}

function selectBestSlug(results, rawTitle, season) {
    if (!results || results.length === 0) return null;
    const targetClean = normalize(rawTitle).toLowerCase().replace(/\s+/g, '');
    const seasonStr = String(season);

    const scored = results.map(item => {
        const titleClean = normalize(item.title || '').toLowerCase().replace(/\s+/g, '');
        const slugClean = (item.slug || '').toLowerCase();
        let score = 0;
        if (titleClean === targetClean) score += 100;
        else if (titleClean.includes(targetClean) || targetClean.includes(titleClean)) score += 50;
        else if (slugClean.includes(targetClean)) score += 30;
        if (slugClean.includes(`-${seasonStr}-temporada`) || slugClean.endsWith(`-${seasonStr}`)) score += 80;
        const otherSeasonMatch = slugClean.match(/-(\d+)-temporada/);
        if (otherSeasonMatch && otherSeasonMatch[1] !== seasonStr) score -= 60;
        return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    console.log('[selectBestSlug] Candidatos:', scored.map(s => `${s.item.slug} (${s.score})`).join(', '));
    return scored[0]?.item;
}

async function getSlug(rawTitle, season) {
    console.log(`[getSlug] Procurando slug para: "${rawTitle}" temporada ${season}`);
    const titleVariations = generateTitleVariations(rawTitle);

    for (const title of titleVariations) {
        const normalizedTitle = normalize(title);
        try {
            const searchUrl = `${BASE_URL}/api-proxy/animes?search=${encodeURIComponent(normalizedTitle)}&limit=15`;
            const data = await fetchJson(searchUrl);
            const list = Array.isArray(data) ? data : (data.data || []);
            if (list.length > 0) {
                const best = selectBestSlug(list, normalizedTitle, season);
                if (best) {
                    console.log(`[getSlug] Selecionado via busca: slug=${best.slug}`);
                    return best.slug;
                }
            }
        } catch (e) {
            console.log(`[getSlug] Erro na busca por "${normalizedTitle}":`, e.message);
        }
    }

    const baseTitle = normalize(titleVariations[0]);
    const baseSlug = titleToSlug(baseTitle);
    const variants = [baseSlug];
    if (season > 1) {
        variants.push(
            `${baseSlug}-${season}-temporada`,
            `${baseSlug}-temporada-${season}`,
            `${baseSlug}-season-${season}`
        );
    }
    variants.push(baseSlug.replace(/-+/g, '-'));
    console.log('[getSlug] Tentando slugs gerados:', variants);
    for (const slug of variants) {
        try {
            const testData = await fetchJson(`${BASE_URL}/api-proxy/animes/${slug}`);
            if (testData?.episodes) {
                const hasSeason = testData.episodes.some(ep => Number(ep.season_number) === season);
                if (hasSeason || testData.episodes.length > 0) {
                    console.log(`[getSlug] Slug funcionou: ${slug}`);
                    return slug;
                }
            }
        } catch (e) {}
    }
    throw new Error(`Slug não encontrado para: ${rawTitle} temporada ${season}`);
}

async function fetchAnimeDetails(slug) {
    const url = `${BASE_URL}/api-proxy/animes/${encodeURIComponent(slug)}`;
    const data = await fetchJson(url);
    if (!data?.episodes) throw new Error('Detalhes do anime sem episódios');
    return data;
}

async function getStreamOptions(tmdbTitle, season, episode, episodeNumbers) {
    const slug = await getSlug(tmdbTitle, season);
    const anime = await fetchAnimeDetails(slug);
    console.log(`[getStreamOptions] Anime: ${anime.title}, total de episódios no site: ${anime.episodes.length}`);

    let matches = anime.episodes.filter(ep =>
        Number(ep.season_number) === season && Number(ep.episode_number) === episode
    );

    if (matches.length === 0 && episodeNumbers.length > 0) {
        console.log('[getStreamOptions] Site não separa temporadas, usando mapeamento TMDB');
        matches = anime.episodes.filter(ep =>
            episodeNumbers.includes(Number(ep.episode_number)) && Number(ep.episode_number) === episode
        );
    }

    if (matches.length === 0) throw new Error(`Episódio S${season}E${episode} não encontrado`);

    const results = [];
    for (const ep of matches) {
        try {
            const watchData = await fetchJson(`${BASE_URL}/api-proxy/episodes/${ep.id}/watch`);
            results.push({ url: watchData.url, audioType: ep.audio_type });
        } catch (e) {}
    }
    return results;
}

// index.js
const TMDB_API_KEY = 'c6c6f4c1cb446e0d5c305f3fa7eeb4a9';

async function getEpisodeNumbersFromTMDB(tmdbId, season) {
    const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?api_key=${TMDB_API_KEY}&language=en-US`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB season error ${res.status}`);
    const data = await res.json();
    return data.episodes?.map(ep => ep.episode_number) || [];
}

async function getStreams(tmdbId, mediaType, season, episode) {
    console.log(`[AnimesOnlineTo] Buscando: TMDB ${tmdbId}, ${mediaType}, S${season}E${episode}`);

    if (mediaType !== 'tv' || !episode) {
        console.log('[AnimesOnlineTo] Apenas animes (tv) com episódio são suportados');
        return [];
    }

    try {
        const tmdbRes = await fetch(
            `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`
        );
        if (!tmdbRes.ok) throw new Error(`TMDB error ${tmdbRes.status}`);
        const tmdbData = await tmdbRes.json();
        const title = tmdbData.name || tmdbData.original_name;
        console.log(`[AnimesOnlineTo] Título TMDB: ${title}`);

        const episodeNumbers = await getEpisodeNumbersFromTMDB(tmdbId, season);
        console.log(`[AnimesOnlineTo] Episódios da temporada (TMDB): ${episodeNumbers.length} encontrados`);

        const options = await getStreamOptions(title, season, episode, episodeNumbers);

        return options.map(opt => ({
            name: 'AnimesOnlineTo',
            title: `${title} - Ep ${episode} (${opt.audioType === 'dub' ? 'Dublado' : 'Legendado'})`,
            url: opt.url,
            quality: '720p',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
                'Referer': 'https://animesonlineto.to/',
                'Origin': 'https://animesonlineto.to'
            }
        }));
    } catch (error) {
        console.error('[AnimesOnlineTo] Erro:', error.message);
        return [];
    }
}

module.exports = { getStreams };
