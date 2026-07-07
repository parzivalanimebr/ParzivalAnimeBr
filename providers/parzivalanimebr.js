// ParzivalAnimeBr - Nuvio Provider
// Roda DENTRO do app Nuvio (motor Hermes). Sem async/await, sem axios/cheerio.
// Só usa fetch nativo + regex.

// ─────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO: cole sua chave gratuita da TMDB aqui.
// Como conseguir: crie conta em https://www.themoviedb.org/ (grátis) →
// Configurações → API → "API Key (v3 auth)".
// ─────────────────────────────────────────────────────────────────────────
var TMDB_API_KEY = "025a145459f0ccb67f0e5b9215243e5c";

var HEADERS_BROWSER = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

function norm(str) {
    return (str || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function fetchText(url, extraHeaders) {
    var headers = {};
    for (var k in HEADERS_BROWSER) headers[k] = HEADERS_BROWSER[k];
    if (extraHeaders) for (var k2 in extraHeaders) headers[k2] = extraHeaders[k2];

    return fetch(url, { headers: headers }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " em " + url);
        return res.text();
    });
}

// Remove parâmetros de decoração (img/poster/thumbnail) da URL do iframe
function cleanEmbedUrl(raw) {
    try {
        var u = new URL(raw);
        ["img", "poster", "thumbnail", "image", "cover"].forEach(function (p) {
            u.searchParams.delete(p);
        });
        return u.toString();
    } catch (e) {
        var m = raw.match(/^(https?:\/\/[^&]+)/);
        return m ? m[1] : raw;
    }
}

// ─── Resolve título via TMDB ────────────────────────────────────────────────

function resolveTitle(tmdbId, mediaType) {
    var kind = mediaType === "movie" ? "movie" : "tv";
    var url = "https://api.themoviedb.org/3/" + kind + "/" + tmdbId +
        "?api_key=" + TMDB_API_KEY + "&language=pt-BR";

    return fetch(url).then(function (res) {
        if (!res.ok) throw new Error("TMDB HTTP " + res.status);
        return res.json();
    }).then(function (data) {
        return data.name || data.title || data.original_name || data.original_title || "";
    });
}

// ─── Extrai iframes de uma página de episódio (regex, sem cheerio) ──────────

var JUNK_HOSTS = ["disqus", "facebook.com", "twitter", "doubleclick", "googlesyndication", "gstatic", "youtube.com/sub"];

function extractIframes(html) {
    var out = [];
    var regex = /<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
    var match;
    while ((match = regex.exec(html)) !== null) {
        var src = match[1];
        if (!src || src.indexOf("http") !== 0) continue;

        // Desembrulha /aviso/?url=...
        if (src.indexOf("/aviso/?url=") !== -1) {
            try {
                var u = new URL(src, "https://topanimes.net");
                src = u.searchParams.get("url") || src;
            } catch (e) {}
        }

        var isJunk = JUNK_HOSTS.some(function (j) { return src.indexOf(j) !== -1; });
        if (isJunk) continue;

        out.push(src);
    }
    // Remove duplicatas
    return out.filter(function (v, i, a) { return a.indexOf(v) === i; });
}

// Detecta se a própria URL do iframe já é um stream direto (m3u8/mp4),
// preservando a query string original (esses endpoints costumam ser
// dinâmicos e dependem do "?id=..." completo, não podem ser reconstruídos).
function detectDirectStream(src) {
    try {
        var u = new URL(src);
        if (/\.(m3u8|mp4)$/i.test(u.pathname)) {
            return { url: cleanEmbedUrl(src), quality: "HD" };
        }
        var id = u.searchParams.get("id") || "";
        if (/\.(m3u8|mp4)/i.test(id)) {
            return { url: cleanEmbedUrl(src), quality: "HD" };
        }
    } catch (e) {}
    return null;
}

// Extrai as URLs de vídeo do campo file:"..." de players Playerjs
function extractPlayerjsUrls(html) {
    var fileMatch = html.match(/file\s*:\s*["']([^"']{10,})["']/);
    if (!fileMatch) return [];

    var fileStr = fileMatch[1];
    var streams = [];
    var qualityRegex = /\[([^\]]+)\](https?:\/\/[^,\s"']+)/g;
    var match;
    while ((match = qualityRegex.exec(fileStr)) !== null) {
        streams.push({ quality: match[1], url: match[2] });
    }
    if (streams.length === 0) {
        var urlRegex = /(https?:\/\/[^\s,"']+\.(mp4|m3u8)[^\s,"']*)/g;
        while ((match = urlRegex.exec(fileStr)) !== null) {
            streams.push({ quality: "SD", url: match[1] });
        }
    }
    return streams;
}

// Resolve um único iframe em 0+ streams reproduzíveis
function resolveEmbed(src) {
    var direct = detectDirectStream(src);
    if (direct) {
        var origin = "";
        try { origin = new URL(src).origin; } catch (e) {}
        return Promise.resolve([{
            title: "ParzivalAnimeBr - " + direct.quality,
            url: direct.url,
            quality: direct.quality,
            headers: { "Referer": origin + "/", "User-Agent": HEADERS_BROWSER["User-Agent"] }
        }]);
    }

    var embedUrl = cleanEmbedUrl(src);
    var origin2 = "";
    try { origin2 = new URL(embedUrl).origin; } catch (e) {}

    return fetchText(embedUrl, { "Referer": origin2 + "/" })
        .then(function (html) {
            var raw = extractPlayerjsUrls(html);
            return raw.map(function (item) {
                return {
                    title: "ParzivalAnimeBr - " + item.quality,
                    url: item.url,
                    quality: item.quality,
                    headers: { "Referer": origin2 + "/", "User-Agent": HEADERS_BROWSER["User-Agent"] }
                };
            });
        })
        .catch(function (e) {
            console.log("[ParzivalAnimeBr] falha ao resolver embed " + embedUrl + ": " + e.message);
            return [];
        });
}

// ─── Scraper: TopAnimes.net ───────────────────────────────────────────────────

function scrapeTopAnimes(name, episode) {
    var search = encodeURIComponent(name);
    var searchUrl = "https://topanimes.net/?s=" + search;

    return fetchText(searchUrl, { "Referer": "https://topanimes.net/" }).then(function (html) {
        var hrefRegex = /href="(https:\/\/topanimes\.net\/animes\/[^"]+)"/g;
        var hrefs = [];
        var m;
        while ((m = hrefRegex.exec(html)) !== null) hrefs.push(m[1]);
        hrefs = hrefs.filter(function (v, i, a) { return a.indexOf(v) === i; });

        var targetName = norm(name);
        var animeUrl = "";
        for (var i = 0; i < hrefs.length; i++) {
            var slugMatch = hrefs[i].match(/\/animes\/([^\/]+)\/?/);
            if (!slugMatch) continue;
            var slugAsText = norm(slugMatch[1].replace(/-/g, " "));
            if (slugAsText.indexOf(targetName) !== -1 || targetName.indexOf(slugAsText) !== -1) {
                animeUrl = hrefs[i];
                break;
            }
        }

        if (!animeUrl) {
            console.log('[ParzivalAnimeBr] anime nao encontrado no TopAnimes: "' + name + '"');
            return [];
        }

        var slugMatch2 = animeUrl.match(/\/animes\/([^\/]+)\/?/);
        if (!slugMatch2) return [];
        var slug = slugMatch2[1];

        var epUrl = "https://topanimes.net/episodio/" + slug + "-episodio-" + episode + "/";
        return fetchText(epUrl, { "Referer": animeUrl }).then(function (epHtml) {
            var iframes = extractIframes(epHtml);
            if (iframes.length === 0) {
                console.log("[ParzivalAnimeBr] nenhum iframe em " + epUrl);
                return [];
            }
            console.log("[ParzivalAnimeBr] " + iframes.length + " iframe(s) encontrado(s)");

            return Promise.all(iframes.map(resolveEmbed)).then(function (results) {
                var flat = [];
                results.forEach(function (arr) { flat = flat.concat(arr); });
                return flat;
            });
        });
    }).catch(function (e) {
        console.log("[ParzivalAnimeBr] erro no TopAnimes: " + e.message);
        return [];
    });
}

// ─── Ponto de entrada exigido pelo Nuvio ──────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
    var ep = episode || 1;

    return resolveTitle(tmdbId, mediaType).then(function (name) {
        if (!name) {
            console.log("[ParzivalAnimeBr] nao foi possivel resolver o titulo via TMDB");
            return [];
        }
        console.log('[ParzivalAnimeBr] buscando: "' + name + '" episodio ' + ep);
        return scrapeTopAnimes(name, ep);
    }).catch(function (e) {
        console.log("[ParzivalAnimeBr] erro geral: " + e.message);
        return [];
    });
}

module.exports = { getStreams: getStreams };
