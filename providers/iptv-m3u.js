const TMDB_KEY = 'c6c6f4c1cb446e0d5c305f3fa7eeb4a9';

const M3U_LISTS = [
    'https://raw.githubusercontent.com/Ramys/Iptv-Brasil-2026/refs/heads/master/Lista%20Mundial01.m3u',
    'https://raw.githubusercontent.com/Ramys/Iptv-Brasil-2026/refs/heads/master/CanaisBR02.m3u8',
];

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const CHUNK_SIZE = 200 * 1024;
const MAX_CHUNKS = 400;
const BATCH = 12;

function normalizeName(name) {
    return (name || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ').trim();
}

function matchLine(pendingName, targets) {
    const n = normalizeName(pendingName);
    const ny = n.replace(/\s*\b(19|20)\d{2}\b\s*/g, ' ').replace(/\s+/g, ' ').trim();
    for (let j = 0; j < targets.length; j++) {
        if (n === targets[j] || ny === targets[j]) return true;
    }
    return false;
}

function scanChunk(text, targets) {
    let pendingName = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf('#EXTINF') !== -1) {
            const m = line.match(/tvg-name="([^"]+)"/);
            if (m) pendingName = m[1];
            else { const c = line.lastIndexOf(','); pendingName = c !== -1 ? line.slice(c + 1) : ''; }
        } else if (line && line.charAt(0) !== '#' && pendingName) {
            if (matchLine(pendingName, targets)) return line.trim();
            pendingName = '';
        }
    }
    return null;
}

async function fetchChunk(url, index) {
    const start = index * CHUNK_SIZE;
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Range': 'bytes=' + start + '-' + (start + CHUNK_SIZE - 1) },
        });
        if (res.status !== 206 && res.status !== 200) return { index: index, text: '', total: 0, end: true };
        let total = 0;
        const cr = res.headers.get('content-range');
        if (cr) { const m = cr.match(/\/(\d+)/); if (m) total = parseInt(m[1], 10); }
        const text = await res.text();
        return { index: index, text: text, total: total, end: false };
    } catch (e) {
        return { index: index, text: '', total: 0, end: true };
    }
}

async function rangeSearch(url, targets) {
    const first = await fetchChunk(url, 0);
    if (first.end && !first.text) {
        try {
            const full = await fetch(url, { headers: HEADERS });
            return scanChunk(await full.text(), targets);
        } catch (e) { return null; }
    }
    let hit = scanChunk(first.text, targets);
    if (hit) { return hit; }

    const total = first.total;
    const numChunks = total ? Math.min(Math.ceil(total / CHUNK_SIZE), MAX_CHUNKS) : MAX_CHUNKS;

    for (let batchStart = 1; batchStart < numChunks; batchStart += BATCH) {
        const promises = [];
        for (let i = 0; i < BATCH && (batchStart + i) < numChunks; i++) {
            promises.push(fetchChunk(url, batchStart + i));
        }
        const chunks = await Promise.all(promises);
        chunks.sort(function (a, b) { return a.index - b.index; });
        for (let c = 0; c < chunks.length; c++) {
            if (!chunks[c].text) continue;
            hit = scanChunk(chunks[c].text, targets);
            if (hit) { return hit; }
        }
    }
    return null;
}

function guessQuality(url) {
    if (/1080|fhd|full ?hd/i.test(url)) return '1080p';
    if (/2160|4k|uhd/i.test(url)) return '4K';
    if (/720|hd/i.test(url)) return '720p';
    return '720p';
}

async function getStreams(tmdbId, mediaType, season, episode) {
    if (mediaType !== 'movie' && mediaType !== 'tv') return [];

    try {
        const t = mediaType === 'tv' ? 'tv' : 'movie';
        const tmdb = await fetch('https://api.themoviedb.org/3/' + t + '/' + tmdbId + '?api_key=' + TMDB_KEY + '&language=pt-BR').then(function (r) { return r.json(); });
        const ptTitle = tmdb.name || tmdb.title || '';
        const origTitle = tmdb.original_name || tmdb.original_title || '';
        if (!ptTitle && !origTitle) return [];

        const targets = [];
        const rawTargets = [];
        if (mediaType === 'tv') {
            const s = String(season).padStart(2, '0'), e = String(episode).padStart(2, '0');
            const bases = [ptTitle, origTitle];
            for (let i = 0; i < bases.length; i++) {
                if (!bases[i]) continue;
                rawTargets.push(bases[i] + ' s' + s + 'e' + e);
                rawTargets.push(bases[i] + ' ' + season + 'x' + e);
                rawTargets.push(bases[i] + ' t' + s + 'e' + e);
            }
        } else {
            const bases = [ptTitle, origTitle];
            for (let i = 0; i < bases.length; i++) {
                if (!bases[i]) continue;
                rawTargets.push(bases[i]);
            }
        }
        for (let i = 0; i < rawTargets.length; i++) {
            const n = normalizeName(rawTargets[i]);
            if (n && targets.indexOf(n) === -1) targets.push(n);
        }

        const promises = [];
        for (let i = 0; i < M3U_LISTS.length; i++) {
            promises.push(rangeSearch(M3U_LISTS[i], targets));
        }
        const results = await Promise.all(promises);

        const found = [], seen = [];
        for (let i = 0; i < results.length; i++) {
            const url = results[i];
            if (!url || seen.indexOf(url) !== -1) continue;
            seen.push(url);
            found.push({
                name: 'IPTV M3U',
                title: ptTitle + (mediaType === 'tv' ? ' S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0') : ''),
                url: url,
                quality: guessQuality(url),
                headers: HEADERS,
            });
        }

        return found;

    } catch (e) {
        return [];
    }
}

export { getStreams };
