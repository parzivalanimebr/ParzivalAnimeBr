const BASE_URL = 'https://sfumaypqhxzjssarmyrn.supabase.co/rest/v1/rpc';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmdW1heXBxaHh6anNzYXJteXJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MDU1ODUsImV4cCI6MjA4Nzk4MTU4NX0.Ff3DMipcepJuFXuhaXLsievmPG-Czu6FutHZJVxJTO8';

async function rpc(fn, body = {}) {
    const response = await fetch(`${BASE_URL}/${fn}`, {
        method: 'POST',
        headers: {
            apikey: ANON_KEY,
            Authorization: `Bearer ${ANON_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`RPC ${fn} falhou: ${response.status}`);
    return response.json();
}

function normalizeTitle(title) {
    return title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function getSearchVariations(title) {
    const variations = [title];
    if (title.includes(':')) {
        variations.push(title.split(':')[0].trim());
    }
    const firstWord = title.split(' ')[0];
    if (firstWord && firstWord.length > 3 && !variations.includes(firstWord)) {
        variations.push(firstWord);
    }
    const cleaned = normalizeTitle(title);
    if (!variations.includes(cleaned)) {
        variations.push(cleaned);
    }
    return [...new Set(variations)];
}

async function findItemByTmdbId(tmdbId, mediaType, tmdbTitle) {
    const type = mediaType === 'tv' ? 'series' : 'movie';
    const targetId = String(tmdbId);

    const searchTerms = getSearchVariations(tmdbTitle);
    for (const term of searchTerms) {
        try {
            const catalog = await rpc('get_catalog', {
                p_type: type,
                p_search: term,
                p_page: 1,
                p_order_by: 'rating',
                p_is_adult: false
            });

            if (catalog && catalog.items && catalog.items.length > 0) {
                for (const item of catalog.items) {
                    const itemTmdbId = (item.tmdb && item.tmdb.id) ? String(item.tmdb.id) : null;
                    if (itemTmdbId === targetId) {
                        return await rpc('get_item', { p_id: item.id });
                    }
                }
                const normalizedSearch = normalizeTitle(term);
                let bestMatch = null;
                let bestScore = 0;
                for (const item of catalog.items) {
                    const itemTitleNormalized = normalizeTitle(item.name || '');
                    let score = 0;
                    if (itemTitleNormalized === normalizedSearch) {
                        score = 2;
                    } else if (itemTitleNormalized.includes(normalizedSearch) || normalizedSearch.includes(itemTitleNormalized)) {
                        score = 1;
                    }
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = item;
                    }
                }
                if (bestMatch) {
                    return await rpc('get_item', { p_id: bestMatch.id });
                }
            }
        } catch (e) {
        }
    }

    try {
        let page = 1;
        const maxPages = 5;
        while (page <= maxPages) {
            const catalog = await rpc('get_catalog', {
                p_type: type,
                p_page: page,
                p_order_by: 'rating',
                p_is_adult: false
            });
            if (!catalog || !catalog.items) break;
            for (const item of catalog.items) {
                const itemTmdbId = (item.tmdb && item.tmdb.id) ? String(item.tmdb.id) : null;
                if (itemTmdbId === targetId) {
                    return await rpc('get_item', { p_id: item.id });
                }
            }
            if (page >= (catalog.totalPages || 1)) break;
            page++;
        }
    } catch (e) {
    }

    throw new Error(`"${tmdbTitle}" (TMDB ${tmdbId}) não encontrado no Saimo TV.`);
}

async function getStreamUrl(tmdbId, mediaType, tmdbTitle, season, episode) {
    const item = await findItemByTmdbId(tmdbId, mediaType, tmdbTitle);

    if (mediaType === 'tv' && season && episode && item.episodes) {
        const seasonKey = String(season);
        const eps = item.episodes[seasonKey];
        if (!eps || eps.length === 0) {
            throw new Error(`Temporada ${season} não encontrada.`);
        }
        const ep = eps.find(e => Number(e.episode) === Number(episode));
        if (!ep) {
            throw new Error(`Episódio ${episode} não encontrado na temporada ${season}.`);
        }
        return ep.url;
    }

    if (!item.url) {
        throw new Error('URL do stream não disponível.');
    }
    return item.url;
}

const TMDB_API_KEY = 'c6c6f4c1cb446e0d5c305f3fa7eeb4a9';

async function getStreams(tmdbId, mediaType, season, episode) {
    if (!['movie', 'tv'].includes(mediaType)) {
        return [];
    }

    try {
        const tmdbRes = await fetch(
            `https://api.themoviedb.org/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}&language=pt-BR`
        );
        if (!tmdbRes.ok) throw new Error(`TMDB fetch error: ${tmdbRes.status}`);
        const tmdbData = await tmdbRes.json();
        const title = tmdbData.title || tmdbData.name;

        const url = await getStreamUrl(tmdbId, mediaType, title, season, episode);

        return [{
            name: 'Saimo TV',
            title: title,
            url: url,
            quality: '720p',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://saimo-tv.vercel.app/',
                'Origin': 'https://saimo-tv.vercel.app'
            }
        }];
    } catch (error) {
        return [];
    }
}

export { getStreams };
