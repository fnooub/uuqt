'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const { exec } = require('child_process');
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

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Không tìm thấy endpoint.' });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
