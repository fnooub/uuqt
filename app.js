'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const { exec } = require('child_process');
const axios = require('axios');
const { sify } = require('chinese-conv');
const { Dictionary } = require('./Dictionary');

// --- Khởi tạo từ điển ĐỒNG BỘ trước khi làm gì khác ---
console.log('Đang load từ điển...');
const dictionary = new Dictionary();
dictionary.init(path.join(__dirname));
console.log('Từ điển sẵn sàng.');

function fetchHtmlWithCurl(url) {
    return new Promise((resolve, reject) => {
        const cmd = `curl.exe -L -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}"`;
        exec(cmd, { maxBuffer: 15 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

// Bộ từ dừng tiếng Trung thông dụng để lọc nhiễu các cụm từ không phải tên riêng
const CHINESE_STOPWORDS = new Set([
    '的', '了', '着', '著', '是', '有', '在', '他', '她', '它', '们', '这', '那', '个',
    '一', '不', '就', '和', '而', '也', '得', '过', '里', '上', '下', '去', '来', '到',
    '说', '道', '出', '看', '听', '写', '读', '吃', '走', '跑', '想', '要', '给', '对',
    '把', '被', '让', '使', '以', '由', '自', '从', '往', '向', '朝', '用', '为', '跟',
    '同', '与', '及', '或', '但', '因', '所', '如', '若', '如果', '虽然', 'si', 'si',
    '虽然', '但是', 'because', 'so', 'then', 'because', 'so', 'then',
    '因为', 'so', 'so', 'so', 'so', 'so', 'so', 'so', 'so', 'so',
    '所以', '那么', '什么', '怎么', '哪里', '哪个', '那些', '这里', '这么', 'these', 'those',
    '这样', 'base', 'base', 'base', 'base', 'base', 'base', 'base', 'base',
    '这样', '那样', '为了', '关于', '对于', '或者', '而且', '并且', '然后', '因此',
    '一个', 'base', 'base', 'base', 'base', 'base', 'base', 'base', 'base',
    '一个', 'base', 'base', 'base', 'base', 'base', 'base', 'base', 'base',
    '一个', '没有', '这个', '那个', '现在', '知道', '开始', '已经', '自己', 'we', 'we',
    '我们', '你们', '他们', '她们', '它们', '可以', '觉得', '出来', '过去', '过来',
    '起来', '感觉', '甚至', '没有什么', '什么时候', '什么样', '不知', '不知道'
]);

function countRepeatWords(text, minWordLength = 2, maxWordLength = 8, minFrequency = 2, limit = 100) {
    if (!text) return [];
    text = text.trim();

    // Tách các dấu câu, khoảng trắng, dòng mới để phân đoạn văn bản
    const regex = /[\p{P}\n\t\r]/ug;
    const segments = text.split(regex).map(item => item.trim()).filter(Boolean);

    const uniqueWords = new Set();
    for (const segment of segments) {
        for (let j = 0; j < segment.length; j++) {
            for (let k = minWordLength; k <= maxWordLength; k++) {
                if (j + k > segment.length) continue;
                const word = segment.slice(j, j + k).trim();

                // Chỉ giữ lại các cụm từ chứa toàn chữ Hán
                if (!/^[\u4e00-\u9fa5]+$/.test(word)) continue;

                // Bỏ qua nếu thuộc bộ từ dừng thông dụng
                if (CHINESE_STOPWORDS.has(word)) continue;

                if (word.length >= minWordLength) {
                    uniqueWords.add(word);
                }
            }
        }
    }

    const uniqueWordsArray = Array.from(uniqueWords);
    const result = [];

    for (const word of uniqueWordsArray) {
        // Đếm tần suất xuất hiện trong văn bản gốc bằng split
        const frequency = text.split(word).length - 1;
        if (frequency >= minFrequency) {
            result.push({ word, freq: frequency });
        }
    }

    // Sắp xếp theo tần suất giảm dần, nếu tần suất bằng nhau thì ưu tiên từ dài hơn
    result.sort((a, b) => b.freq - a.freq || b.word.length - a.word.length);
    return result.slice(0, limit);
}

function mergeArrays(array1, array2) {
    const frequencyMap = new Map();
    const updateFrequency = (word, freq) => {
        frequencyMap.set(word, (frequencyMap.get(word) || 0) + freq);
    };

    array1.forEach(item => updateFrequency(item.word, item.freq));
    array2.forEach(item => updateFrequency(item.word, item.freq));

    return Array.from(frequencyMap.entries()).map(([word, freq]) => ({ word, freq }));
}

// --- App ---
const app = express();

// 2. Cấu hình CORS để cho phép các trang web gọi vào server local
app.use(cors({
    origin: '*', // Cho phép tất cả các trang web
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Parse JSON body, giới hạn 500KB (names2 có thể lớn hơn)
app.use(express.json({ limit: '500kb' }));

// Rate limiting đơn giản (không cần thư viện)
const rateLimitMap = new Map();
const RATE_LIMIT = 60;        // số request tối đa
const RATE_WINDOW = 60_000;   // trong 60 giây

function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now - entry.start > RATE_WINDOW) {
        rateLimitMap.set(ip, { count: 1, start: now });
        return next();
    }

    if (entry.count >= RATE_LIMIT) {
        return res.status(429).json({ error: 'Quá nhiều request, thử lại sau.' });
    }

    entry.count++;
    next();
}

// Dọn rateLimitMap mỗi 5 phút để tránh memory leak
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now - entry.start > RATE_WINDOW) rateLimitMap.delete(ip);
    }
}, 5 * 60_000);

// --- Routes ---

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', ready: dictionary.ready });
});

// API dịch
// Body: { text: string, names2?: { [hanzi: string]: string } }
app.post('/translate', rateLimit, (req, res) => {
    const { text, names2 } = req.body ?? {};

    if (typeof text !== 'string') {
        return res.status(400).json({ error: 'Body phải có field "text" kiểu string.' });
    }

    if (text.length === 0) {
        return res.json({ translatedText: '' });
    }

    if (text.length > 50_000) {
        return res.status(400).json({ error: 'Text quá dài, tối đa 50.000 ký tự.' });
    }

    // Validate names2 (không bắt buộc)
    if (names2 != null) {
        if (typeof names2 !== 'object' || Array.isArray(names2)) {
            return res.status(400).json({ error: 'names2 phải là object dạng { "汉字": "Hán Việt" }.' });
        }
        const entries = Object.entries(names2);
        if (entries.length > 2_000) {
            return res.status(400).json({ error: 'names2 tối đa 2.000 entry.' });
        }
        for (const [k, v] of entries) {
            if (typeof k !== 'string' || typeof v !== 'string') {
                return res.status(400).json({ error: 'Mọi key và value trong names2 phải là string.' });
            }
        }
    }

    try {
        const translatedText = dictionary.translate(text, names2 ?? null);
        res.json({ translatedText });
    } catch (err) {
        console.error('Lỗi translate:', err);
        res.status(500).json({ error: 'Lỗi server khi dịch.' });
    }
});

// API đọc truyện (Book Info)
app.get('/book/:bookId', async (req, res) => {
    const bookId = req.params.bookId;
    if (!/^\d+$/.test(bookId)) {
        return res.status(400).send('ID truyện không hợp lệ.');
    }
    
    try {
        const url = `https://uukanshu.cc/book/${bookId}/`;
        const html = await fetchHtmlWithCurl(url);
        const $ = cheerio.load(html);
        
        const titleRaw = $('h1.booktitle').text().replace(/[\r\n]+/g, ' ').trim() || 'Không rõ tiêu đề';
        const authorRaw = ($('.bookinfo .booktag a.red').first().text().trim() || $('.bookinfo .booktag a').first().text().trim() || 'Tác giả ẩn danh').replace(/[\r\n]+/g, ' ');
        const introRaw = ($('p.bookintro').text().trim() || 'Không có giới thiệu.').replace(/[\r\n]+/g, ' ');
        
        const chapterList = [];
        const chapterLinks = $('#list-chapterAll dd a, .chapterlist dd a');
        chapterLinks.each((i, el) => {
            const href = $(el).attr('href');
            const title = $(el).text().trim();
            if (href && title) {
                const match = href.match(/\/book\/\d+\/(\d+)\.html/i);
                if (match) {
                    chapterList.push({
                        url: `/book/${bookId}/${match[1]}`,
                        originalTitle: title
                    });
                }
            }
        });
        
        const title = dictionary.translate(titleRaw);
        const author = dictionary.translate(authorRaw);
        const intro = dictionary.translate(introRaw);
        
        let chaptersHtml = '';
        if (chapterList.length > 0) {
            const chapterTitles = chapterList.map(c => c.originalTitle);
            console.log(`Đang dịch danh sách chương truyện ${bookId} (Tổng cộng ${chapterTitles.length} chương)...`);
            const translatedJoined = dictionary.translate(chapterTitles.join('\n'));
            const translatedItems = translatedJoined.split('\n');
            
            for (let i = 0; i < chapterList.length; i++) {
                const translatedTitle = translatedItems[i] ? translatedItems[i].trim() : chapterList[i].originalTitle;
                chaptersHtml += `<a href="${chapterList[i].url}" class="chapter-item">
                    <span class="chapter-num">${i + 1}</span>
                    <span class="chapter-name">${translatedTitle}</span>
                </a>\n`;
            }
        }
        
        let template = fs.readFileSync(path.join(__dirname, 'views', 'book.html'), 'utf8');
        template = template
            .replaceAll('{{title}}', title)
            .replaceAll('{{author}}', author)
            .replaceAll('{{intro}}', intro)
            .replaceAll('{{chapters}}', chaptersHtml)
            .replaceAll('{{bookId}}', bookId);
            
        res.send(template);
        
    } catch (e) {
        console.error('Lỗi khi tải book:', e);
        res.status(500).send('Không thể tải thông tin truyện. Lỗi: ' + e.message);
    }
});

// API tải toàn bộ truyện thành file .txt
app.get('/book/:bookId/download', async (req, res) => {
    const { bookId } = req.params;
    if (!/^\d+$/.test(bookId)) {
        return res.status(400).send('ID truyện không hợp lệ.');
    }

    let isAborted = false;
    req.on('close', () => {
        isAborted = true;
        console.log(`Người dùng đã hủy tải truyện ${bookId}.`);
    });

    try {
        const url = `https://uukanshu.cc/book/${bookId}/`;
        const html = await fetchHtmlWithCurl(url);
        const $ = cheerio.load(html);

        const titleRaw = $('h1.booktitle').text().replace(/[\r\n]+/g, ' ').trim() || 'Không rõ tiêu đề';
        const authorRaw = ($('.bookinfo .booktag a.red').first().text().trim() || $('.bookinfo .booktag a').first().text().trim() || 'Tác giả ẩn danh').replace(/[\r\n]+/g, ' ');
        const introRaw = ($('p.bookintro').text().trim() || 'Không có giới thiệu.').replace(/[\r\n]+/g, ' ');

        const title = dictionary.translate(titleRaw);
        const author = dictionary.translate(authorRaw);
        const intro = dictionary.translate(introRaw);

        const chapterList = [];
        const chapterLinks = $('#list-chapterAll dd a, .chapterlist dd a');
        chapterLinks.each((i, el) => {
            const href = $(el).attr('href');
            const originalTitle = $(el).text().trim();
            if (href && originalTitle) {
                const match = href.match(/\/book\/\d+\/(\d+)\.html/i);
                if (match) {
                    chapterList.push({
                        chapterId: match[1],
                        originalTitle,
                        url: `https://uukanshu.cc${href}`
                    });
                }
            }
        });

        if (chapterList.length === 0) {
            return res.status(404).send('Không tìm thấy danh sách chương.');
        }

        console.log(`Đang chuẩn bị tải truyện ${title} (${bookId}), tổng số: ${chapterList.length} chương...`);

        // Thiết lập header streaming tải file
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(title)}.txt`);

        // Ghi phần mở đầu truyện
        res.write(`${title}\n`);
        res.write(`Tác giả: ${author}\n`);
        res.write(`Mô tả:\n${intro}\n\n`);
        res.write(`=========================================\n\n`);

        // Tải và dịch từng chương truyện
        for (let i = 0; i < chapterList.length; i++) {
            if (isAborted) break;

            const chap = chapterList[i];
            console.log(`[Tải truyện ${bookId}] Đang tải chương ${i + 1}/${chapterList.length}: ${chap.originalTitle}`);

            let retries = 2;
            let chapHtml = '';
            while (retries > 0) {
                try {
                    chapHtml = await fetchHtmlWithCurl(chap.url);
                    break;
                } catch (err) {
                    retries--;
                    if (retries === 0) {
                        console.error(`Lỗi khi tải chương ${chap.chapterId}:`, err.message);
                    } else {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            }

            if (!chapHtml) {
                res.write(`\n\nChương ${i + 1}: ${dictionary.translate(chap.originalTitle)}\n\n[Lỗi tải nội dung chương này từ nguồn gốc]\n\n`);
                continue;
            }

            const c$ = cheerio.load(chapHtml);
            const chapTitleRaw = c$('h1.pt10').text().trim() || chap.originalTitle;
            const contentEl = c$('div.readcotent');
            contentEl.find('script').remove();

            const rawContent = contentEl.html() || '';
            const rawParagraphs = rawContent
                .split(/<br\s*\/?>/i)
                .map(p => cheerio.load(p).text().replace(/&nbsp;/g, ' ').replace(/[\r\n\t]+/g, ' ').trim())
                .filter(p => p.length > 0 && !p.includes('uu看书') && !p.includes('uukanshu'));

            // Dịch tiêu đề chương và nội dung chương
            const translatedTitle = dictionary.translate(chapTitleRaw);
            const joinedText = rawParagraphs.join('\n');
            const translatedContent = dictionary.translate(joinedText);

            // Ghi nội dung chương đã dịch vào file
            res.write(`\n\n${translatedTitle}\n\n`);
            res.write(`${translatedContent}\n`);

            // Delay nhỏ để tránh spam request liên tục (200ms)
            await new Promise(r => setTimeout(r, 200));
        }

        res.end();
        console.log(`Đã hoàn thành tải truyện ${title} (${bookId})!`);

    } catch (e) {
        console.error('Lỗi khi tải và kết xuất truyện:', e);
        if (!res.headersSent) {
            res.status(500).send('Lỗi máy chủ khi tải truyện. Lỗi: ' + e.message);
        } else {
            res.write(`\n\n[Lỗi trong quá trình tải truyện: ${e.message}]\n`);
            res.end();
        }
    }
});

// API lấy nội dung chương truyện dạng JSON (hỗ trợ client-side tải song song)
app.get('/api/book/:bookId/:chapterId', async (req, res) => {
    const { bookId, chapterId } = req.params;
    if (!/^\d+$/.test(bookId) || !/^\d+$/.test(chapterId)) {
        return res.status(400).json({ error: 'ID truyện hoặc chương không hợp lệ.' });
    }
    
    try {
        const url = `https://uukanshu.cc/book/${bookId}/${chapterId}.html`;
        const html = await fetchHtmlWithCurl(url);
        const $ = cheerio.load(html);
        
        const titleRaw = $('h1.pt10').text().trim() || 'Chương không rõ tiêu đề';
        
        const contentEl = $('div.readcotent');
        contentEl.find('script').remove();
        
        const paragraphs = (contentEl.html() || '')
            .split(/<br\s*\/?>/i)
            .map(p => cheerio.load(p).text().replace(/&nbsp;/g, ' ').replace(/[\r\n\t]+/g, ' ').trim())
            .filter(p => p.length > 0 && !p.includes('uu看书') && !p.includes('uukanshu'));
            
        const textsToTranslate = [titleRaw, ...paragraphs];
        const joinedText = textsToTranslate.join('\n');
        
        const translatedJoined = dictionary.translate(joinedText);
        const translatedItems = translatedJoined.split('\n');
        
        const title = translatedItems[0] ? translatedItems[0].trim() : titleRaw;
        const content = translatedItems.slice(1).map(p => p.trim()).filter(p => p.length > 0).join('\n\n');
        
        res.json({ title, content });
        
    } catch (e) {
        console.error(`Lỗi tải JSON chương ${chapterId}:`, e);
        res.status(500).json({ error: 'Không thể tải nội dung chương. Lỗi: ' + e.message });
    }
});

// API quét và trích xuất tên riêng từ nhiều chương truyện tuần tự bằng AI
app.post('/api/extract-names-multi', rateLimit, async (req, res) => {
    const { bookId, startChapter, endChapter, apiKey, model, apiType, endpointUrl, customSystemPrompt } = req.body ?? {};
    
    if (!/^\d+$/.test(bookId)) {
        return res.status(400).json({ error: 'ID truyện không hợp lệ.' });
    }
    
    const startNum = parseInt(startChapter, 10);
    const endNum = parseInt(endChapter, 10);
    
    if (isNaN(startNum) || isNaN(endNum) || startNum < 1 || endNum < startNum) {
        return res.status(400).json({ error: 'Khoảng chương không hợp lệ.' });
    }
    
    const finalApiType = apiType || 'openai';
    const finalApiKey = apiKey || process.env.COMETAPI_KEY || '';
    const finalModel = model || process.env.COMETAPI_MODEL || 'gemini-2.5-flash-lite';
    const finalEndpointUrl = endpointUrl || 'https://api.cometapi.com/v1/chat/completions';
    
    if (!finalApiKey) {
        return res.status(400).json({ error: 'Thiếu API Key. Vui lòng cấu hình trong bảng điều khiển UI.' });
    }
    
    try {
        // 1. Tải danh sách chương
        const url = `https://uukanshu.cc/book/${bookId}/`;
        const html = await fetchHtmlWithCurl(url);
        const $ = cheerio.load(html);
        
        const chapterList = [];
        const chapterLinks = $('#list-chapterAll dd a, .chapterlist dd a');
        chapterLinks.each((i, el) => {
            const href = $(el).attr('href');
            const title = $(el).text().trim();
            if (href && title) {
                const match = href.match(/\/book\/\d+\/(\d+)\.html/i);
                if (match) {
                    chapterList.push({
                        chapterId: match[1],
                        originalTitle: title
                    });
                }
            }
        });
        
        if (chapterList.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy danh sách chương.' });
        }
        
        // Giới hạn tối đa quét 30 chương một lần để tránh lạm dụng và quá tải
        const countToScan = endNum - startNum + 1;
        if (countToScan > 30) {
            return res.status(400).json({ error: 'Chỉ hỗ trợ quét tối đa 30 chương một lúc.' });
        }
        
        // Lọc các chương cần quét (1-indexed)
        const targetChapters = chapterList.slice(startNum - 1, endNum);
        if (targetChapters.length === 0) {
            return res.status(400).json({ error: 'Không tìm thấy chương nào trong khoảng đã chọn.' });
        }
        
        console.log(`[AI Scanner] Bắt đầu quét tên riêng từ chương ${startNum} đến ${endNum} của truyện ${bookId} bằng API ${finalApiType}...`);
        
        // 2. Tải và phân tích các chương để lọc từ lặp
        let mergedCandidates = [];
        let contextText = '';

        console.log(`[AI Scanner] Bắt đầu tải và phân tích ${targetChapters.length} chương để trích xuất từ lặp...`);

        for (let i = 0; i < targetChapters.length; i++) {
            const chap = targetChapters[i];
            const chapIdx = startNum + i;
            console.log(`[AI Scanner] Đang tải chương ${chapIdx}/${endNum}: ${chap.originalTitle}`);
            
            try {
                const chapUrl = `https://uukanshu.cc/book/${bookId}/${chap.chapterId}.html`;
                const chapHtml = await fetchHtmlWithCurl(chapUrl);
                const c$ = cheerio.load(chapHtml);
                
                const titleRaw = c$('h1.pt10').text().trim() || chap.originalTitle;
                const contentEl = c$('div.readcotent');
                contentEl.find('script').remove();
                
                const paragraphs = (contentEl.html() || '')
                    .split(/<br\s*\/?>/i)
                    .map(p => cheerio.load(p).text().replace(/&nbsp;/g, ' ').replace(/[\r\n\t]+/g, ' ').trim())
                    .filter(p => p.length > 0 && !p.includes('uu看书') && !p.includes('uukanshu'));
                
                const rawText = [titleRaw, ...paragraphs].join('\n');
                
                // Thu thập bối cảnh (tối đa ~12000 ký tự đầu của truyện để tránh quá tải ngữ cảnh)
                if (contextText.length < 12000) {
                    contextText += rawText + '\n\n';
                }
                
                // Đếm từ lặp cho chương này
                const chapCandidates = countRepeatWords(rawText, 2, 8, 2, 100);
                // Gộp vào danh sách tổng
                mergedCandidates = mergeArrays(mergedCandidates, chapCandidates);
                console.log(`   => Chương ${chapIdx}: Trích xuất ${chapCandidates.length} từ lặp cục bộ. Tổng số từ sau gộp: ${mergedCandidates.length}`);
            } catch (err) {
                console.error(`   => Lỗi khi tải chương ${chapIdx}: ${err.message}`);
            }

            // Tránh spam request dồn dập
            if (i < targetChapters.length - 1) {
                await new Promise(r => setTimeout(r, 800));
            }
        }

        // Sắp xếp lại danh sách ứng viên đã gộp theo tần suất giảm dần
        mergedCandidates.sort((a, b) => b.freq - a.freq || b.word.length - a.word.length);

        // Lấy top 50 ứng viên nổi bật nhất
        const topCandidates = mergedCandidates.slice(0, 50);

        console.log(`[AI Scanner] Phân tích hoàn tất! Tổng cộng có ${mergedCandidates.length} ứng viên duy nhất.`);
        console.log(`[AI Scanner] Đang lọc lấy top ${topCandidates.length} ứng viên nghi vấn nhất.`);
        
        if (topCandidates.length > 0) {
            console.log(`[AI Scanner] Top 10 ứng viên lặp nhiều nhất:`);
            topCandidates.slice(0, 10).forEach((c, idx) => {
                console.log(`   [Top ${idx + 1}] Từ: "${c.word}" - Tần suất xuất hiện: ${c.freq} lần`);
            });
        } else {
            console.log('[AI Scanner] Không tìm thấy từ lặp nghi vấn nào.');
            return res.json({ names: '' });
        }

        // Định dạng danh sách gửi cho AI
        const candidatesText = topCandidates.map((c, idx) => `${idx + 1}. ${c.word} (tần suất: ${c.freq})`).join('\n');

        // Bối cảnh truyện (giới hạn 8000 ký tự đầu tiên để gửi cho AI)
        const contextExcerpt = contextText.slice(0, 8000);

        const systemPrompt = customSystemPrompt && customSystemPrompt.trim()
            ? customSystemPrompt.trim()
            : `Bạn là một chuyên gia phân tích ngôn ngữ Trung - Việt chuyên trích xuất tên riêng cho truyện.
Nhiệm vụ của bạn là:
1. Nhận danh sách các từ Trung Quốc nghi vấn được lấy từ giải thuật đếm tần suất lặp lại.
2. Dựa trên bối cảnh truyện được cung cấp, xác định xem từ nào trong danh sách thực sự là tên riêng (Tên nhân vật, Tên địa danh/tông môn, Tên chiêu thức, Tên vũ khí/vật phẩm). Loại bỏ các từ sai sót, từ chung chung (như động từ, tính từ thông dụng) không phải tên riêng.
3. Xác định phong cách dịch phù hợp cho truyện này (ví dụ: Hán Việt cổ đại/tiên hiệp/kiếm hiệp, hoặc phiên âm phương Tây/fantasy, hoặc hiện đại/đô thị). Dịch các tên riêng đó sang tiếng Việt theo phong cách đó.
4. CHỈ trả về kết quả theo định dạng 'Từ_tiếng_Trung=Nghĩa_Dịch' (ví dụ: '云飞=Vân Phi'), mỗi dòng một tên.
5. KHÔNG giải thích, KHÔNG thêm tiêu đề, KHÔNG thêm số thứ tự hay bất kỳ ký tự thừa nào khác.`;

        const userPrompt = `Bối cảnh truyện (đoạn trích):\n---\n${contextExcerpt}\n---\n\nDanh sách từ nghi vấn cần xác minh và dịch (hãy kiểm chứng từng từ một dựa trên bối cảnh ở trên, bỏ qua từ sai sót/không phải tên riêng, và dịch sang nghĩa tiếng Việt phù hợp):\n${candidatesText}`;

        console.log(`[AI Scanner] Đang gửi yêu cầu xác minh và dịch sang AI (${finalApiType} - Model: ${finalModel})...`);

        let resultText = '';

        if (finalApiType === 'gemini') {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${finalModel}:generateContent?key=${finalApiKey}`;
            const response = await axios.post(geminiUrl, {
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                text: `${systemPrompt}\n\nYêu cầu cụ thể:\n${userPrompt}`
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.2
                }
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            });
            
            resultText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
            // OpenAI / CometAPI
            const response = await axios.post(finalEndpointUrl, {
                model: finalModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.2
            }, {
                headers: {
                    'Authorization': `Bearer ${finalApiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            });
            
            resultText = response.data?.choices?.[0]?.message?.content || '';
        }

        console.log(`[AI Scanner] AI đã phản hồi thành công.`);
        console.log(`[AI Scanner] Phản hồi thô của AI:\n---\n${resultText.trim()}\n---`);

        // 3. Xử lý và làm sạch đầu ra từ AI
        const nameMap = new Map();
        if (resultText) {
            const lines = resultText.split('\n');
            lines.forEach(line => {
                const eqIdx = line.indexOf('=');
                if (eqIdx <= 0) return;
                
                const rawKey = line.slice(0, eqIdx).trim();
                const value = line.slice(eqIdx + 1).trim();
                
                if (rawKey && value) {
                    const key = sify(rawKey); // Đồng bộ khóa thành chữ giản thể
                    if (!nameMap.has(key)) {
                        nameMap.set(key, value);
                    }
                }
            });
        }

        // Kết xuất dữ liệu sang text key=value
        let extractedText = '';
        for (const [k, v] of nameMap) {
            extractedText += `${k}=${v}\n`;
        }
        
        console.log(`[AI Scanner] Hoàn thành quét! Tìm thấy tổng cộng ${nameMap.size} tên riêng hợp lệ sau khi AI xác minh.`);
        res.json({ names: extractedText.trim() });
        
    } catch (err) {
        console.error('[AI Scanner] Lỗi hệ thống:', err);
        res.status(500).json({ error: 'Lỗi máy chủ khi quét tên riêng: ' + err.message });
    }
});

// API cập nhật và lưu gộp từ điển Names2.txt toàn hệ thống
app.post('/api/save-names2', rateLimit, async (req, res) => {
    const { names } = req.body ?? {};
    if (typeof names !== 'string') {
        return res.status(400).json({ error: 'Nội dung names không hợp lệ.' });
    }
    
    try {
        const names2Path = path.join(__dirname, 'Names2.txt');
        let existingMap = new Map();
        
        // 1. Đọc dữ liệu cũ nếu có để gộp thông minh
        if (fs.existsSync(names2Path)) {
            const oldContent = fs.readFileSync(names2Path, 'utf8');
            const lines = oldContent.split('\n');
            lines.forEach(line => {
                const eqIdx = line.indexOf('=');
                if (eqIdx <= 0) return;
                const key = sify(line.slice(0, eqIdx).trim());
                const val = line.slice(eqIdx + 1).trim();
                if (key && val) {
                    existingMap.set(key, val);
                }
            });
        }
        
        // 2. Gộp dữ liệu mới quét được vào bản đồ
        const newLines = names.split('\n');
        newLines.forEach(line => {
            const eqIdx = line.indexOf('=');
            if (eqIdx <= 0) return;
            const key = sify(line.slice(0, eqIdx).trim());
            const val = line.slice(eqIdx + 1).trim();
            if (key && val) {
                existingMap.set(key, val); // Ghi đè hoặc thêm mới từ dịch
            }
        });
        
        // 3. Viết lại tệp tin Names2.txt
        let newContent = '';
        for (const [k, v] of existingMap) {
            newContent += `${k}=${v}\n`;
        }
        
        fs.writeFileSync(names2Path, newContent.trim() + '\n', 'utf8');
        
        // 4. Reload từ điển trong RAM tức thì
        dictionary.loadNames2();
        
        console.log(`[Names2 Server] Đã lưu gộp Names2.txt toàn hệ thống. Tổng số: ${existingMap.size} mục từ.`);
        res.json({ success: true, count: existingMap.size });
        
    } catch (err) {
        console.error('[Names2 Server] Lỗi khi lưu từ điển:', err);
        res.status(500).json({ error: 'Lỗi máy chủ khi lưu từ điển: ' + err.message });
    }
});

// API đọc chương (Chapter Content)
app.get('/book/:bookId/:chapterId', async (req, res) => {
    const { bookId, chapterId } = req.params;
    if (!/^\d+$/.test(bookId) || !/^\d+$/.test(chapterId)) {
        return res.status(400).send('ID truyện hoặc chương không hợp lệ.');
    }
    
    try {
        const url = `https://uukanshu.cc/book/${bookId}/${chapterId}.html`;
        const html = await fetchHtmlWithCurl(url);
        const $ = cheerio.load(html);
        
        const titleRaw = $('h1.pt10').text().trim() || 'Chương không rõ tiêu đề';
        
        const contentEl = $('div.readcotent');
        contentEl.find('script').remove();
        
        const paragraphs = contentEl.html()
            .split(/<br\s*\/?>/i)
            .map(p => cheerio.load(p).text().trim())
            .filter(p => p.length > 0);
            
        let prevUrl = `/book/${bookId}`;
        let nextUrl = `/book/${bookId}`;
        let prevDisabled = 'disabled';
        let nextDisabled = 'disabled';
        
        $('a').each((i, el) => {
            const txt = $(el).text().trim();
            const href = $(el).attr('href');
            if (href) {
                if (txt.includes('上一章') || txt.includes('上') && txt.includes('章')) {
                    const match = href.match(/\/book\/\d+\/(\d+)\.html/i);
                    if (match) {
                        prevUrl = `/book/${bookId}/${match[1]}`;
                        prevDisabled = '';
                    }
                } else if (txt.includes('下一章') || txt.includes('下') && txt.includes('章')) {
                    const match = href.match(/\/book\/\d+\/(\d+)\.html/i);
                    if (match) {
                        nextUrl = `/book/${bookId}/${match[1]}`;
                        nextDisabled = '';
                    }
                }
            }
        });
        
        let bookTitleRaw = 'Quay lại mục lục';
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href === `/book/${bookId}/` || href === `/book/${bookId}`)) {
                const text = $(el).text().trim();
                if (text && !text.includes('目录') && !text.includes('目錄')) {
                    bookTitleRaw = text;
                }
            }
        });
        
        const textsToTranslate = [bookTitleRaw, titleRaw, ...paragraphs];
        const joinedText = textsToTranslate.join('\n');
        
        console.log(`Đang dịch chương ${chapterId} của truyện ${bookId} (${paragraphs.length} đoạn)...`);
        const translatedJoined = dictionary.translate(joinedText);
        const translatedItems = translatedJoined.split('\n');
        
        const bookTitle = translatedItems[0] ? translatedItems[0].trim() : bookTitleRaw;
        const title = translatedItems[1] ? translatedItems[1].trim() : titleRaw;
        
        let contentHtml = '';
        for (let i = 2; i < translatedItems.length; i++) {
            const pText = translatedItems[i] ? translatedItems[i].trim() : paragraphs[i - 2];
            if (pText) {
                contentHtml += `<p>${pText}</p>\n`;
            }
        }
        
        let template = fs.readFileSync(path.join(__dirname, 'views', 'chapter.html'), 'utf8');
        template = template
            .replaceAll('{{title}}', title)
            .replaceAll('{{bookTitle}}', bookTitle)
            .replaceAll('{{content}}', contentHtml)
            .replaceAll('{{prevUrl}}', prevUrl)
            .replaceAll('{{prevDisabled}}', prevDisabled)
            .replaceAll('{{indexUrl}}', `/book/${bookId}`)
            .replaceAll('{{nextUrl}}', nextUrl)
            .replaceAll('{{nextDisabled}}', nextDisabled)
            .replaceAll('{{bookId}}', bookId);
            
        res.send(template);
        
    } catch (e) {
        console.error('Lỗi khi tải chương:', e);
        res.status(500).send('Không thể tải nội dung chương. Lỗi: ' + e.message);
    }
});

// Giao diện web
app.get('/', async (req, res) => {
    const page = parseInt(req.query.page || '1', 10);
    const classId = parseInt(req.query.class || '0', 10); // Mặc định là 0 (Mới Cập Nhật)
    if (isNaN(page) || page < 1) {
        return res.status(400).send('Số trang không hợp lệ.');
    }
    if (isNaN(classId) || classId < 0 || classId > 10) {
        return res.status(400).send('Thể loại không hợp lệ.');
    }
    
    try {
        const novels = [];
        let totalPages = 1;

        if (classId === 0) {
            // Cào bảng "最近更新" (Cập nhật gần đây) tại trang chủ uukanshu.cc
            const url = 'https://uukanshu.cc/';
            const html = await fetchHtmlWithCurl(url);
            const $ = cheerio.load(html);

            $('#gengxin ul li, .content-left ul li').each((i, el) => {
                const $el = $(el);
                const categoryRaw = $el.find('.s1').text().replace('[', '').replace(']', '').trim();
                const titleRaw = $el.find('.s2 a').text().replace(/[\r\n]+/g, ' ').trim();
                const href = $el.find('.s2 a').attr('href');

                let bookId = '';
                if (href) {
                    const match = href.match(/\/book\/(\d+)\/?/i);
                    if (match) bookId = match[1];
                }

                const latestChapterRaw = $el.find('.s3 a').text().replace(/[\r\n]+/g, ' ').trim();
                const latestChapterHref = $el.find('.s3 a').attr('href');
                let latestChapterId = '';
                if (latestChapterHref) {
                    const match = latestChapterHref.match(/\/book\/\d+\/(\d+)\.html/i);
                    if (match) latestChapterId = match[1];
                }

                const authorRaw = $el.find('.s4').text().replace(/[\r\n]+/g, ' ').trim();

                if (bookId && titleRaw) {
                    const translatedCategory = dictionary.translate(categoryRaw);
                    novels.push({
                        bookId,
                        titleRaw,
                        authorRaw,
                        wordCountRaw: `Thể loại: ${translatedCategory}`,
                        latestChapterRaw,
                        latestChapterId,
                        introRaw: `Chương mới nhất vừa cập nhật. Bấm vào nút bên dưới để đọc ngay.`
                    });
                }
            });
        } else {
            // Cào danh sách truyện theo thể loại có phân trang
            const url = `https://uukanshu.cc/class_${classId}_${page}.html`;
            const html = await fetchHtmlWithCurl(url);
            const $ = cheerio.load(html);

            $('.bookbox').each((i, el) => {
                const $el = $(el);
                const titleRaw = $el.find('h4.bookname a').text().replace(/[\r\n]+/g, ' ').trim();
                const href = $el.find('h4.bookname a').attr('href');
                
                let bookId = '';
                if (href) {
                    const match = href.match(/\/book\/(\d+)\/?/i);
                    if (match) bookId = match[1];
                }

                let authorRaw = 'Không rõ';
                let wordCountRaw = 'Không rõ';
                $el.find('.author').each((idx, aEl) => {
                    const text = $(aEl).text().trim();
                    if (text.startsWith('作者：')) {
                        authorRaw = text.replace('作者：', '').replace(/[\r\n]+/g, ' ').trim();
                    } else if (text.startsWith('字數：')) {
                        wordCountRaw = text.replace('字數：', '').replace(/[\r\n]+/g, ' ').trim();
                    }
                });

                const latestChapterRaw = $el.find('.cat a').text().replace(/[\r\n]+/g, ' ').trim();
                const latestChapterHref = $el.find('.cat a').attr('href');
                let latestChapterId = '';
                if (latestChapterHref) {
                    const match = latestChapterHref.match(/\/book\/\d+\/(\d+)\.html/i);
                    if (match) latestChapterId = match[1];
                }

                const introRaw = $el.find('.update').text().replace('簡介：', '').replace(/[\r\n]+/g, ' ').trim();

                if (bookId) {
                    novels.push({
                        bookId,
                        titleRaw,
                        authorRaw,
                        wordCountRaw: `Số chữ: ${wordCountRaw}`,
                        latestChapterRaw,
                        latestChapterId,
                        introRaw
                    });
                }
            });

            // Parse total pages
            const lastPageHref = $('a.last').attr('href');
            if (lastPageHref) {
                const match = lastPageHref.match(/class_\d+_(\d+)\.html/i);
                if (match) totalPages = parseInt(match[1]);
            } else {
                $('.pagelink a, .pages a').each((idx, el) => {
                    const href = $(el).attr('href');
                    if (href) {
                        const match = href.match(/class_\d+_(\d+)\.html/i);
                        if (match) {
                            const pNum = parseInt(match[1]);
                            if (pNum > totalPages) totalPages = pNum;
                        }
                    }
                });
            }
        }

        // Translate novels individually to prevent any indexing alignment shift
        let novelsHtml = '';
        if (novels.length > 0) {
            console.log(`Đang dịch danh sách truyện (thể loại ${classId}, trang ${page})...`);
            for (let i = 0; i < novels.length; i++) {
                const title = dictionary.translate(novels[i].titleRaw);
                const author = dictionary.translate(novels[i].authorRaw);
                const latestChapter = dictionary.translate(novels[i].latestChapterRaw);
                const intro = dictionary.translate(novels[i].introRaw);
                
                const bookUrl = `/book/${novels[i].bookId}`;
                const latestChapterUrl = novels[i].latestChapterId ? `/book/${novels[i].bookId}/${novels[i].latestChapterId}` : bookUrl;
                
                novelsHtml += `
                <div class="book-card">
                    <div class="book-card-header">
                        <a href="${bookUrl}" class="book-card-title">${title}</a>
                        <span class="book-card-author">${author}</span>
                    </div>
                    <div class="book-card-meta">
                        <span>Mã số: ${novels[i].bookId}</span>
                        <span>${novels[i].wordCountRaw}</span>
                    </div>
                    <div class="book-card-intro">${intro || 'Không có giới thiệu.'}</div>
                    <a href="${latestChapterUrl}" class="book-card-latest">Mới nhất: ${latestChapter}</a>
                </div>\n`;
            }
        } else {
            novelsHtml = '<p style="text-align: center; color: #64748b; padding: 20px;">Không có truyện nào được tìm thấy.</p>';
        }

        // Pagination HTML
        let paginationHtml = '';
        if (classId !== 0) {
            if (page > 1) {
                paginationHtml += `<a href="/?class=${classId}&page=${page - 1}" class="pagination-btn">‹ Trước</a>\n`;
            } else {
                paginationHtml += `<a href="#" class="pagination-btn disabled">‹ Trước</a>\n`;
            }
            
            const startPage = Math.max(1, page - 2);
            const endPage = Math.min(totalPages, page + 2);
            
            if (startPage > 1) {
                paginationHtml += `<a href="/?class=${classId}&page=1" class="pagination-btn">1</a>\n`;
                if (startPage > 2) {
                    paginationHtml += `<span style="padding: 6px 8px; color: #cbd5e1;">...</span>\n`;
                }
            }
            
            for (let p = startPage; p <= endPage; p++) {
                const activeClass = p === page ? 'active' : '';
                paginationHtml += `<a href="/?class=${classId}&page=${p}" class="pagination-btn ${activeClass}">${p}</a>\n`;
            }
            
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) {
                    paginationHtml += `<span style="padding: 6px 8px; color: #cbd5e1;">...</span>\n`;
                }
                paginationHtml += `<a href="/?class=${classId}&page=${totalPages}" class="pagination-btn">${totalPages}</a>\n`;
            }
            
            if (page < totalPages) {
                paginationHtml += `<a href="/?class=${classId}&page=${page + 1}" class="pagination-btn">Sau ›</a>\n`;
            } else {
                paginationHtml += `<a href="#" class="pagination-btn disabled">Sau ›</a>\n`;
            }
        }

        const CATEGORY_MAP = {
            0: 'Mới Cập Nhật',
            1: 'Huyền Huyễn Kỳ Huyễn',
            2: 'Võ Hiệp Tiên Hiệp',
            3: 'Hiện Đại Đô Thị',
            4: 'Lịch Sử Quân Sự',
            5: 'Khoa Huyễn Tiểu Thuyết',
            6: 'Du Hí Cạnh Kỹ',
            7: 'Khủng Bố Linh Dị',
            8: 'Ngôn Tình Tiểu Thuyết',
            9: 'Động Mạn Đồng Nhân',
            10: 'Khác'
        };

        const categoryName = CATEGORY_MAP[classId] || 'Mới Cập Nhật';

        const categories = [
            { id: 0, name: 'Mới Nhất' },
            { id: 1, name: 'Huyền Huyễn' },
            { id: 2, name: 'Võ Hiệp' },
            { id: 3, name: 'Đô Thị' },
            { id: 4, name: 'Lịch Sử' },
            { id: 5, name: 'Khoa Huyễn' },
            { id: 6, name: 'Du Hí' },
            { id: 7, name: 'Linh Dị' },
            { id: 8, name: 'Ngôn Tình' },
            { id: 9, name: 'Đồng Nhân' },
            { id: 10, name: 'Khác' }
        ];

        let categoryTabsHtml = '';
        categories.forEach(c => {
            const activeClass = c.id === classId ? 'active' : '';
            categoryTabsHtml += `<a href="/?class=${c.id}" class="category-tab ${activeClass}">${c.name}</a>\n`;
        });

        let template = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8');
        template = template
            .replace('{{novels}}', novelsHtml)
            .replace('{{pagination}}', paginationHtml)
            .replace('{{categoryName}}', categoryName)
            .replace('{{categoryTabs}}', categoryTabsHtml);
            
        res.send(template);

    } catch (e) {
        console.error('Lỗi khi tải trang chủ:', e);
        res.status(500).send('Không thể tải trang chủ. Lỗi: ' + e.message);
    }
});

// --- API CRUD Names2 ---

// Giao diện quản lý Names2
app.get('/names2', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'names2.html'));
});

// Lấy danh sách từ trong Names2.txt dưới dạng JSON
app.get('/api/names2', (req, res) => {
    try {
        const names2Path = path.join(__dirname, 'Names2.txt');
        const list = [];
        if (fs.existsSync(names2Path)) {
            const content = fs.readFileSync(names2Path, 'utf8');
            const lines = content.split('\n');
            lines.forEach(line => {
                const eqIdx = line.indexOf('=');
                if (eqIdx <= 0) return;
                const key = sify(line.slice(0, eqIdx).trim());
                const val = line.slice(eqIdx + 1).trim();
                if (key && val) {
                    list.push({ key, value: val });
                }
            });
        }
        res.json({ list });
    } catch (err) {
        console.error('Lỗi khi lấy từ điển Names2:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// Thêm mới hoặc cập nhật một mục từ
app.post('/api/names2/upsert', (req, res) => {
    const { key, value } = req.body ?? {};
    if (typeof key !== 'string' || typeof value !== 'string' || !key.trim() || !value.trim()) {
        return res.status(400).json({ error: 'Khóa (key) và giá trị (value) phải là chuỗi không rỗng.' });
    }

    try {
        const targetKey = sify(key.trim());
        const targetVal = value.trim();
        const names2Path = path.join(__dirname, 'Names2.txt');
        let existingMap = new Map();

        if (fs.existsSync(names2Path)) {
            const content = fs.readFileSync(names2Path, 'utf8');
            content.split('\n').forEach(line => {
                const eqIdx = line.indexOf('=');
                if (eqIdx <= 0) return;
                const k = sify(line.slice(0, eqIdx).trim());
                const v = line.slice(eqIdx + 1).trim();
                if (k && v) existingMap.set(k, v);
            });
        }

        existingMap.set(targetKey, targetVal);

        let newContent = '';
        for (const [k, v] of existingMap) {
            newContent += `${k}=${v}\n`;
        }
        fs.writeFileSync(names2Path, newContent.trim() + '\n', 'utf8');
        
        dictionary.loadNames2(); // Reload RAM
        res.json({ success: true, count: existingMap.size });
    } catch (err) {
        console.error('Lỗi khi lưu từ điển:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// Xóa một từ khỏi từ điển
app.post('/api/names2/delete', (req, res) => {
    const { key } = req.body ?? {};
    if (typeof key !== 'string' || !key.trim()) {
        return res.status(400).json({ error: 'Thiếu khóa (key) cần xóa.' });
    }

    try {
        const targetKey = sify(key.trim());
        const names2Path = path.join(__dirname, 'Names2.txt');
        let existingMap = new Map();

        if (fs.existsSync(names2Path)) {
            const content = fs.readFileSync(names2Path, 'utf8');
            content.split('\n').forEach(line => {
                const eqIdx = line.indexOf('=');
                if (eqIdx <= 0) return;
                const k = sify(line.slice(0, eqIdx).trim());
                const v = line.slice(eqIdx + 1).trim();
                if (k && v) existingMap.set(k, v);
            });
        }

        if (existingMap.has(targetKey)) {
            existingMap.delete(targetKey);
            let newContent = '';
            for (const [k, v] of existingMap) {
                newContent += `${k}=${v}\n`;
            }
            fs.writeFileSync(names2Path, (newContent ? newContent.trim() + '\n' : ''), 'utf8');
            dictionary.loadNames2(); // Reload RAM
            res.json({ success: true, count: existingMap.size });
        } else {
            res.json({ success: true, count: existingMap.size, message: 'Khóa không tồn tại.' });
        }
    } catch (err) {
        console.error('Lỗi khi xóa từ:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// Xóa sạch toàn bộ từ điển
app.post('/api/names2/clear', (req, res) => {
    try {
        const names2Path = path.join(__dirname, 'Names2.txt');
        fs.writeFileSync(names2Path, '', 'utf8');
        dictionary.loadNames2(); // Reload RAM
        res.json({ success: true, count: 0 });
    } catch (err) {
        console.error('Lỗi khi xóa sạch từ điển:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// Lưu gộp từ đĩa thô đè trực tiếp toàn bộ (phục vụ Bulk Edit)
app.post('/api/names2/save-raw', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
        return res.status(400).json({ error: 'Nội dung không hợp lệ.' });
    }

    try {
        const names2Path = path.join(__dirname, 'Names2.txt');
        let newContent = '';
        let count = 0;
        
        const lines = content.split('\n');
        const map = new Map();
        lines.forEach(line => {
            const eqIdx = line.indexOf('=');
            if (eqIdx <= 0) return;
            const k = sify(line.slice(0, eqIdx).trim());
            const v = line.slice(eqIdx + 1).trim();
            if (k && v) {
                map.set(k, v);
            }
        });

        for (const [k, v] of map) {
            newContent += `${k}=${v}\n`;
            count++;
        }

        fs.writeFileSync(names2Path, (newContent ? newContent.trim() + '\n' : ''), 'utf8');
        dictionary.loadNames2(); // Reload RAM
        res.json({ success: true, count });
    } catch (err) {
        console.error('Lỗi khi lưu từ điển raw:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Không tìm thấy endpoint.' });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
