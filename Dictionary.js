'use strict';

const fs = require('fs');
const path = require('path');
const { sify } = require('chinese-conv');

// --- Trie ---

class TrieNode {
    constructor() {
        this.children = new Map();
        this.translation = null; // null = không phải end-of-word
    }
}

class Trie {
    constructor() {
        this.root = new TrieNode();
    }

    insert(key, value) {
        if (!key || !value) return;
        let node = this.root;
        for (const char of key) {
            let child = node.children.get(char);
            if (!child) {
                child = new TrieNode();
                node.children.set(char, child);
            }
            node = child;
        }
        // Chỉ lưu translation đầu tiên (Names.txt load trước, ưu tiên hơn VietPhrase)
        if (node.translation === null) {
            node.translation = value;
        }
    }

    // Trả về { word, translation } của match dài nhất tại vị trí `start`
    // Nếu không có match → trả về null
    longestMatch(text, start) {
        let node = this.root;
        let lastMatch = null;

        for (let i = start; i < text.length; i++) {
            const child = node.children.get(text[i]);
            if (!child) break;
            node = child;
            if (node.translation !== null) {
                lastMatch = { end: i, translation: node.translation };
            }
        }

        return lastMatch;
    }
}

// --- Punctuation map (build 1 lần) ---

const PUNCT_MAP = {
    '。': '. ', '，': ', ', '、': ', ', '；': '; ', '！': '! ', '？': '? ',
    '：': ': ', '（': '(', '）': ')', '〔': '[', '〕': ']',
    '【': '[', '】': ']', '《': '"', '》': '"',
    '｛': '{', '｝': '}', '『': '[', '』': ']',
    '〈': '<', '〉': '>', '～': '~', '—': ' - ', '…': '...',
    '〖': '[', '〗': ']', '〘': '[', '〙': ']', '〚': '[', '〛': ']',
    '　': ' ', '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'"
};

const PUNCT_REGEX = new RegExp(`[${Object.keys(PUNCT_MAP).join('')}]`, 'g');

// --- PostProcess regex (build 1 lần, không re-compile mỗi call) ---
const RE_SPACE_BEFORE_PUNCT = / +([,.?![\]>"':;])/g;
const RE_SPACE_AFTER_OPEN   = /([<\["'(]) +/g;
const RE_MULTI_SPACE        = / {2,}/g;
const RE_CAPITALIZE         = /(^|[.!?]\s+)([a-z])/g;

// --- Dictionary ---

class Dictionary {
    constructor() {
        this.trie = new Trie();
        this.phienAmMap = new Map(); // char đơn → phiên âm
        this.names2Map = new Map();  // Từ điển Names2.txt toàn cục
        this.ready = false;
        this.dataDir = null;
    }

    /**
     * Parse nội dung file Names2.txt (format key=value mỗi dòng)
     * → trả về plain object { [key]: value } dùng được làm names2 trong translate()
     *
     * Ví dụ input:
     *   云飞=Vân Phi
     *   青云宗=Thanh Vân Tông
     *
     * @param {string} content - Nội dung file dạng string
     * @returns {{ [key: string]: string }}
     */
    static parseNames2(content) {
        const result = {};
        const lines = content.split('\n');
        for (const line of lines) {
            const eqIdx = line.indexOf('=');
            if (eqIdx <= 0) continue;

            const key = line.slice(0, eqIdx).trim();
            const value = line.slice(eqIdx + 1).trim();

            if (!key || !value) continue;
            result[key] = value; // key xuất hiện nhiều lần → giữ cái đầu tiên
        }
        return result;
    }

    // Parse file text → gọi callback(key, value) cho mỗi dòng hợp lệ
    _parseFile(content, callback) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const eqIdx = line.indexOf('=');
            if (eqIdx <= 0) continue; // bỏ dòng không có '=' hoặc key rỗng

            const key = line.slice(0, eqIdx).trim();
            const value = line.slice(eqIdx + 1).trim();

            if (!key || !value) continue;
            callback(key, value);
        }
    }

    _loadFile(filePath) {
        // Dùng sync vì chỉ gọi 1 lần lúc startup, đơn giản và nhanh hơn async ở đây
        return fs.readFileSync(filePath, 'utf8');
    }

    loadNames2() {
        this.names2Map = new Map();
        const names2Path = path.join(this.dataDir || __dirname, 'Names2.txt');
        if (fs.existsSync(names2Path)) {
            try {
                const content = fs.readFileSync(names2Path, 'utf8');
                this._parseFile(content, (key, value) => {
                    this.names2Map.set(sify(key), value);
                });
                console.log(`[Dictionary] Đã tải từ điển Names2.txt toàn cục với ${this.names2Map.size} mục từ.`);
            } catch (err) {
                console.error(`[Dictionary] Lỗi khi load Names2.txt: ${err.message}`);
            }
        } else {
            console.log(`[Dictionary] Không tìm thấy file Names2.txt toàn cục (sẽ được tạo khi lưu lần đầu).`);
        }
    }

    init(dataDir = __dirname) {
        this.dataDir = dataDir;
        console.time('dictionary_load');

        // Load Names trước (ưu tiên cao hơn VietPhrase khi trùng key)
        const namesContent = this._loadFile(path.join(dataDir, 'Names.txt'));
        this._parseFile(namesContent, (key, value) => {
            this.trie.insert(key, value);
        });

        const vpContent = this._loadFile(path.join(dataDir, 'VietPhrase.txt'));
        this._parseFile(vpContent, (key, value) => {
            this.trie.insert(key, value);
        });

        const phienAmContent = this._loadFile(path.join(dataDir, 'ChinesePhienAmWords.txt'));
        this._parseFile(phienAmContent, (key, value) => {
            this.phienAmMap.set(key, value);
        });

        // Load Names2.txt toàn cục
        this.loadNames2();

        this.ready = true;
        console.timeEnd('dictionary_load');
        console.log(`PhienAm entries: ${this.phienAmMap.size}`);
    }

    // Các particle tiếng Trung cần bỏ qua
    static SKIP_WORDS = new Set(['的', '了', '著', '着']);

    /**
     * Dịch văn bản tiếng Trung sang Việt.
     * @param {string} text - Văn bản cần dịch
     * @param {Object} names2 - Từ điển tên riêng per-request, ưu tiên cao nhất
     *                          Ví dụ: { "云飞": "Vân Phi", "青云宗": "Thanh Vân Tông" }
     */
    translate(text, names2 = null) {
        if (!text) return '';

        // Tự động chuyển đổi văn bản phồn thể sang giản thể
        const simplified = sify(text);

        // Bước 1: Chuẩn hóa dấu câu
        const normalized = simplified.replace(PUNCT_REGEX, ch => PUNCT_MAP[ch]);

        // Bước 2: Tokenize bằng Trie chính (không bao giờ thay đổi)
        // names2 chỉ ảnh hưởng bước lookup, KHÔNG ảnh hưởng tokenize
        const tokens = this._tokenize(normalized);

        // Tự động chuyển đổi toàn bộ khóa (key) của names2 sang giản thể để đối khớp chính xác
        let names2Map = null;
        if (names2 && typeof names2 === 'object') {
            names2Map = new Map();
            for (const [key, val] of Object.entries(names2)) {
                names2Map.set(sify(key), val);
            }
        }

        // Bước 3: Lookup chain — Names2 > Trie(Names+VietPhrase) > PhienAm
        const parts = [];
        for (const token of tokens) {
            if (Dictionary.SKIP_WORDS.has(token)) continue;

            // Ưu tiên 1a: Names2 per-request (O(1))
            if (names2Map) {
                const override = names2Map.get(token);
                if (override) { parts.push(override); continue; }
            }

            // Ưu tiên 1b: Names2 toàn cục hệ thống (O(1))
            if (this.names2Map) {
                const override = this.names2Map.get(token);
                if (override) { parts.push(override); continue; }
            }

            // Ưu tiên 2: Trie chính (Names + VietPhrase)
            const match = this.trie.longestMatch(token, 0);
            let word;
            if (match && match.end === token.length - 1) {
                word = match.translation.split('/')[0];
            } else {
                word = token;
            }

            // Ưu tiên 3: PhienAm fallback cho ký tự đơn chưa có trong Trie
            if (word === token && token.length === 1) {
                word = this.phienAmMap.get(token) || token;
            }

            parts.push(word);
        }

        // Bước 4: Hậu xử lý
        return this._postProcess(parts.join(' '));
    }

    _isChineseChar(ch) {
        const code = ch.charCodeAt(0);
        return (code >= 0x4E00 && code <= 0x9FFF)   // CJK cơ bản
            || (code >= 0x3400 && code <= 0x4DBF)   // Extension A
            || (code >= 0xF900 && code <= 0xFAFF);  // CJK Compatibility
    }

    _tokenize(text) {
        const output = [];
        let i = 0;

        while (i < text.length) {
            const match = this.trie.longestMatch(text, i);

            if (match) {
                output.push(text.slice(i, match.end + 1));
                i = match.end + 1;
            } else if (this._isChineseChar(text[i])) {
                // Ký tự Hán đơn không có trong Trie
                output.push(text[i]);
                i++;
            } else {
                // Chuỗi non-Chinese: gom lại
                let j = i + 1;
                while (j < text.length && !this._isChineseChar(text[j])) j++;
                output.push(text.slice(i, j));
                i = j;
            }
        }

        return output;
    }

    _postProcess(text) {
        return text
            .replace(RE_SPACE_BEFORE_PUNCT, '$1')
            .replace(RE_SPACE_AFTER_OPEN,   '$1')
            .replace(RE_MULTI_SPACE, ' ')
            .replace(RE_CAPITALIZE, (_, p1, p2) => p1 + p2.toUpperCase())
            .trim();
    }
}

module.exports = { Dictionary };
