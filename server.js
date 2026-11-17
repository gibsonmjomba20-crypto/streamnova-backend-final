const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const TMDB_API = '04c35731a5ee918f014970082a0088b1';

/* ============================================
   1. DYNAMIC PROXY ENGINE (Ad-Stripping)
   ============================================ */
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');

    const isM3U8 = targetUrl.includes('.m3u8');
    const HEADERS = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 
        'Accept': '*/*', 
        'Origin': new URL(targetUrl).origin, 
        'Referer': new URL(targetUrl).origin + '/' 
    };

    const currentHost = req.get('host');
    const protocol = req.protocol;

    try {
        if (isM3U8) {
            const response = await axios.get(targetUrl, { headers: HEADERS });
            let m3u8Text = response.data;
            const lines = m3u8Text.split('\n');
            const newLines = [];
            for (let line of lines) {
                line = line.trim();
                if (line.startsWith('#EXTINF:')) {
                    const duration = parseFloat(line.split(':')[1].split(',')[0]);
                    if (duration < 6.0) continue; // Strip short ads
                }
                if (line && !line.startsWith('#')) {
                    const absoluteUrl = new URL(line, targetUrl).href;
                    const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
                    line = `${protocol}://${currentHost}/proxy?url=${encodedUrl}`;
                }
                newLines.push(line);
            }
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(newLines.join('\n'));
        } else {
            const range = req.headers.range;
            if (range) HEADERS['Range'] = range;
            const response = await axios({ method: 'GET', url: targetUrl, headers: HEADERS, responseType: 'stream' });
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
            if (response.headers['content-range']) { res.setHeader('Content-Range', response.headers['content-range']); res.status(206); }
            res.setHeader('Access-Control-Allow-Origin', '*');
            response.data.pipe(res);
        }
    } catch (error) { res.status(500).send('Stream blocked'); }
});

/* ============================================
   2. DISCOVERY (Strict English Dub Filter)
   ============================================ */
app.get('/api/discover', async (req, res) => {
    try {
        const { type = 'movie', category, page = 1, company } = req.query;
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;

        if (company) {
            url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&with_companies=${company}&page=${page}&sort_by=popularity.desc`;
        } else if (category === 'trending') {
            url = `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_API}&page=${page}`;
        } 
        // English Dubbed Filter: Keyword 234265 ("Dubbed") + excludes English originals
        else if (category === 'dubbed_en') {
            url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&with_keywords=234265&without_original_language=en&sort_by=popularity.desc`;
        }
        // All Dubbed (Multilingual)
        else if (category === 'dubbed_all') {
            url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&with_original_language=ja|ko|zh|es|fr|hi|tr|ig|yo|ha&sort_by=popularity.desc`;
        }
        else if (category === 'kdrama') {
            url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&with_origin_country=KR&sort_by=popularity.desc&page=${page}`;
        } else if (category === 'upcoming') {
            url = `https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_API}&page=${page}`;
        } else if (category === 'nkiri') {
            return res.redirect(`/api/nkiri?page=${page}`);
        }

        const response = await axios.get(url, { timeout: 5000 });
        res.json({ results: response.data.results });
    } catch (error) { res.status(500).json({ error: "API Error" }); }
});

/* ============================================
   3. DETAILS & SEARCH
   ============================================ */
app.get('/api/details', async (req, res) => {
    try {
        const { id, type } = req.query;
        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API}&append_to_response=credits,similar,videos,translations`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed to load details" }); }
});

app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        const response = await axios.get(`https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API}&query=${encodeURIComponent(query)}`, { timeout: 5000 });
        res.json({ results: response.data.results });
    } catch (error) { res.status(500).json({ error: "Search failed" }); }
});

/* ============================================
   4. STREAM WATERFALL (Force English Dub Audio)
   ============================================ */
app.get('/api/stream', async (req, res) => {
    const { id, type, title, season = 1, episode = 1 } = req.query;
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

    // Method 1: VidLink (Force English Audio Track)
    try {
        let vidLinkUrl = `https://vidlink.pro/api/b/${type}/${id}?lang=en`;
        if (type === 'tv') vidLinkUrl += `/${season}/${episode}`;
        
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 4000 });
        if (vidLinkRes.data?.stream) {
            const hlsUrl = vidLinkRes.data.stream.playlist;
            const mp4Url = vidLinkRes.data.stream.mp4; 
            if (hlsUrl) {
                return res.json({ 
                    success: true, 
                    mode: 'native', 
                    streamUrl: `${proxyBase}${encodeURIComponent(hlsUrl)}`,
                    downloadUrl: mp4Url ? `${proxyBase}${encodeURIComponent(mp4Url)}` : null,
                    note: "Defaulting to English audio if available."
                });
            }
        }
    } catch (e) { }

    // Method 2: Iframe Fallbacks (Force English Audio)
    let iframeUrls = type === 'movie' 
        ? [
            `https://vidsrc.to/embed/movie/${id}?ds_lang=en`, 
            `https://www.2embed.cc/embed/${id}?lang=en`
          ]
        : [
            `https://vidsrc.to/embed/tv/${id}/${season}/${episode}?ds_lang=en`, 
            `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}&lang=en`
          ];

    return res.json({ 
        success: true, 
        mode: 'iframe', 
        iframeUrls: iframeUrls, 
        downloadUrl: null,
        note: "Players forced to English audio. Use the player settings cog if it defaults to original audio."
    });
});

/* ============================================
   5. NKIRI SCRAPER (African Movies & Series)
   ============================================ */
app.get('/api/nkiri', async (req, res) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto('https://nkiri.com/?s=movie', { waitUntil: 'networkidle2', timeout: 60000 });

        const results = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.post-item, article, .movie-item'));
            return items.slice(0, 20).map(el => {
                const link = el.querySelector('a');
                const img = el.querySelector('img');
                const title = el.querySelector('h2, h3, .title')?.innerText?.trim() || '';
                return {
                    title,
                    link: link ? link.href : null,
                    poster: img ? (img.src || img.dataset.src) : null
                };
            }).filter(item => item.link && item.title);
        });

        await browser.close();
        res.json({ success: true, count: results.length, results });
    } catch (error) {
        if (browser) await browser.close();
        console.error('Nkiri Scraper Error:', error.message);
        res.status(500).json({ error: "Nkiri scraping failed." });
    }
});

/* ============================================
   6. LIVE SPORTS STREAMING
   ============================================ */
app.get('/api/live', async (req, res) => {
    try {
        const sources = [
            'https://raw.githubusercontent.com/dtankdempsey2/pixelsport-m3u/main/pixelsport.m3u',
            'https://iptv-org.github.io/iptv/categories/sports.m3u'
        ];

        const streams = [];
        for (const src of sources) {
            try {
                const { data } = await axios.get(src, { timeout: 8000 });
                const lines = data.split('\n');
                let pendingName = null;
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('#EXTINF:')) {
                        const parts = line.split(',');
                        pendingName = parts[parts.length - 1]?.trim() || 'Live Sport';
                    } else if (line && !line.startsWith('#') && pendingName) {
                        const proxyUrl = `${req.protocol}://${req.get('host')}/proxy?url=${Buffer.from(line).toString('base64')}`;
                        streams.push({ name: pendingName, url: proxyUrl, original: line });
                        pendingName = null;
                    }
                }
            } catch (e) { console.warn('Live source failed:', src, e.message); }
        }

        res.json({ success: true, count: streams.length, streams });
    } catch (error) {
        console.error('Live Sports Error:', error.message);
        res.status(500).json({ error: "Failed to load live sports streams." });
    }
});

/* ============================================
   7. DIRECT DOWNLOAD SCRAPERS (Fzmovies & Goojara)
   ============================================ */
app.get('/api/download', async (req, res) => {
    const { title, site } = req.query;
    if (!title || !site) return res.status(400).json({ error: "Title and site required" });

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        let downloadLink = null;

        if (site === 'fzmovies') {
            await page.goto(`https://fzmovies.net/search.php?searchname=${encodeURIComponent(title)}`, { waitUntil: 'networkidle2', timeout: 60000 });
            const movieLink = await page.evaluate(() => document.querySelector('a[href*="movie-"]')?.href || null);
            if (movieLink) {
                await page.goto(movieLink, { waitUntil: 'networkidle2', timeout: 60000 });
                const dlPage = await page.evaluate(() => document.querySelector('a[href*="download"], a[href*="server"]')?.href || null);
                if (dlPage) {
                    await page.goto(dlPage, { waitUntil: 'networkidle2', timeout: 60000 });
                    downloadLink = await page.evaluate(() => document.querySelector('a[href$=".mp4"], a[href$=".mkv"]')?.href || null);
                }
            }
        }

        if (site === 'goojara') {
            await page.goto(`https://goojara.to/?s=${encodeURIComponent(title)}`, { waitUntil: 'networkidle2', timeout: 60000 });
            const resultLink = await page.evaluate(() => document.querySelector('a[href*="/movie/"]')?.href || null);
            if (resultLink) {
                await page.goto(resultLink, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // Try to click a "Play" button if it exists to trigger the player/link
                try {
                    const playBtn = await page.$('button.play-button, .play-icon, button:has-text("Play")');
                    if (playBtn) {
                        await playBtn.click();
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } catch (e) { /* Ignore if no play button */ }

                downloadLink = await page.evaluate(() => document.querySelector('a[href*=".mp4"], a[href*="download"]')?.href || null);
            }
        }

        await browser.close();
        if (downloadLink) return res.json({ success: true, downloadUrl: downloadLink });
        res.status(404).json({ error: "Direct download link not found." });
    } catch (error) {
        if (browser) await browser.close();
        console.error(`Scraper Error (${site}):`, error.message);
        res.status(500).json({ error: "Scraper blocked or timed out." });
    }
});

/* ============================================
   8. START SERVER
   ============================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 SERVER running on port ${PORT}`));
