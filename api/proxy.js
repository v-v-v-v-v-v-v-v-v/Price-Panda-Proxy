// api/proxy.js - FINAL "Smart Hybrid" Version

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import crypto from 'crypto';

// --- A. RATE LIMITER SETUP ---
let ratelimit;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    ratelimit = new Ratelimit({
        redis: redis,
        limiter: Ratelimit.slidingWindow(10, "30 s"),
        analytics: true,
        prefix: "@price_panda_ratelimit",
    });
}

// --- B. KNOWLEDGE BASE (Minimalist, for the Smart Filter only) ---
const PRODUCT_NOUNS = new Set([
    'case', 'cover', 'skin', 'charger', 'adapter', 'cable', 'powerbank', 'battery',
    'mount', 'stand', 'holder', 'grip', 'tripod', 'headphones', 'earbuds', 'headset', 'speaker',
    'screen', 'protector', 'film', 'glass', 'wallet', 'airpods'
]);

const PRODUCT_CONFLICT_MAP = new Map([
    ['case', new Set(['screen', 'protector', 'film', 'glass', 'charger', 'cable', 'wallet', 'airpods', 'stand', 'holder', 'mount', 'grip', 'powerbank'])],
    ['screen', new Set(['case', 'cover', 'charger', 'cable', 'wallet', 'airpods', 'stand', 'holder'])],
    ['protector', new Set(['case', 'cover', 'charger', 'cable', 'wallet', 'airpods', 'stand', 'holder'])],
    ['charger', new Set(['case', 'cover', 'screen', 'protector', 'film', 'glass', 'stand', 'holder', 'mount', 'grip'])]
]);

// --- C. HELPER FUNCTIONS ---
const OFFICIAL_API_GATEWAY = "https://api-sg.aliexpress.com/sync";
const OFFICIAL_API_METHOD = "aliexpress.affiliate.product.query";

function generateAliexpressSignature(params, secretKey) {
    const sortedKeys = Object.keys(params).sort();
    const concatenatedString = sortedKeys.map(key => key + params[key]).join('');
    return crypto.createHmac('sha256', secretKey).update(concatenatedString).digest('hex').toUpperCase();
}

const stopWords = new Set(['a', 'an', 'for', 'with', 'the', 'and', 'in', 'on', 'of', 'at', 'to', 'is', 'it', 'pcs', 'set', 'new', 'hot', 'for', 'compatible', 'plus', 'pro', 'max', 'ultra', 'mini', 'gen', 'series']);
const getKeywordSet = (text) => new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter(word => word && !stopWords.has(word)));
const calculateSimilarity = (setA, setB) => {
    if (setA.size === 0 || setB.size === 0) return 0;
    const intersectionSize = [...setA].filter(x => setB.has(x)).length;
    const unionSize = new Set([...setA, ...setB]).size;
    return unionSize === 0 ? 0 : intersectionSize / unionSize;
};

// --- D. MAIN SERVER HANDLER ---
export default async function handler(request, response) {
    // 1. APPLY RATE LIMITER
    if (ratelimit) {
        const ip = request.ip ?? "127.0.0.1";
        try {
            const { success } = await ratelimit.limit(ip);
            if (!success) { return response.status(429).json({ error: "Too Many Requests" }); }
        } catch (error) {
            console.error("Rate limiter error (failing open):", error);
        }
    }

    // Standard CORS and method handling
    response.setHeader('Access-Control-Allow-Origin', 'chrome-extension://oaicdpnnbookbcenmgcemnfajpdcdpmm');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { return response.status(200).end(); }
    if (request.method !== 'POST') { return response.status(405).json({ error: 'Method Not Allowed' }); }

    try {
        // 2. EXTRACT DATA & PREPARE API QUERY
        const { amazonTitle, amazonPrice, amazonCategory, amazonSearchQuery } = request.body;
        const appKey = process.env.ALIEXPRESS_APP_KEY;
        const secretKey = process.env.ALIEXPRESS_SECRET_KEY;
        const trackingId = process.env.ALIEXPRESS_TRACKING_ID || "default";

        if (!amazonTitle || typeof amazonPrice !== 'number' || !appKey || !secretKey) {
            return response.status(400).json({ error: "Missing required parameters or server keys." });
        }

        const titleKeywords = getKeywordSet(amazonTitle);
        const userQueryKeywords = getKeywordSet(amazonSearchQuery || '');
        const combinedAmazonKeywords = new Set([...userQueryKeywords, ...titleKeywords]);
        const searchApiQuery = userQueryKeywords.size > 2 ? amazonSearchQuery : [...combinedAmazonKeywords].slice(0, 7).join(' ');

        // 3. CALL THE ALIEXPRESS API
        const params = {
            'app_key': appKey, 'method': OFFICIAL_API_METHOD, 'sign_method': 'hmac-sha256',
            'timestamp': String(Date.now()), 'keywords': searchApiQuery, 'tracking_id': trackingId,
            'target_language': 'en', 'target_currency': 'USD', 'page_size': '50', 'sort': 'BEST_MATCH'
        };
        if (amazonCategory) { params.category_id = amazonCategory; }
        params.sign = generateAliexpressSignature(params, secretKey);
        const apiResponse = await fetch(OFFICIAL_API_GATEWAY, {
            method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded;charset=utf-8' },
            body: new URLSearchParams(params)
        });
        if (!apiResponse.ok) { throw new Error('AliExpress API request failed'); }
        const data = await apiResponse.json();
        const allResults = data.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product || [];

        // --- 4. THE "SMART HYBRID" ALGORITHM ---

        // STAGE 1: THE SMART FILTER
        const coreNoun = [...combinedAmazonKeywords].find(kw => PRODUCT_NOUNS.has(kw));
        let candidates = allResults;

        if (coreNoun && PRODUCT_CONFLICT_MAP.has(coreNoun)) {
            const forbiddenProducts = PRODUCT_CONFLICT_MAP.get(coreNoun);
            candidates = allResults.filter(item => {
                const aliexpressTitle = item.product_title.toLowerCase();
                return ![...forbiddenProducts].some(term => aliexpressTitle.includes(term));
            });
            console.log(`Smart Filter active for "${coreNoun}". Reduced ${allResults.length} to ${candidates.length} candidates.`);
        }

        // STAGE 2: THE "PURE SIGNAL" RANKING (Your 8/10 Algorithm)
        let alternatives = candidates
            .map(item => {
                const itemPriceNum = parseFloat(item.sale_price);
                if (!(itemPriceNum > 0 && itemPriceNum < amazonPrice)) return null;

                const aliexpressKeywords = getKeywordSet(item.product_title);
                const userIntentScore = calculateSimilarity(userQueryKeywords, aliexpressKeywords);
                const productContextScore = calculateSimilarity(titleKeywords, aliexpressKeywords);
                const finalScore = (0.40 * userIntentScore) + (0.60 * productContextScore);
                
                return {
                    title: item.product_title, link: item.promotion_link, price: itemPriceNum,
                    price_str: `${item.target_sale_price_currency || 'USD'} ${itemPriceNum.toFixed(2)}`,
                    source_site: "AliExpress", imageUrl: item.product_main_image_url,
                    score: finalScore
                };
            })
            .filter(item => item !== null && item.score > 0); 
        
        alternatives.sort((a, b) => b.score - a.score);

        // 5. SEND THE FINAL, RANKED LIST BACK
        return response.status(200).json({ results: alternatives });

    } catch (err) {
        console.error("Critical Server Error:", err);
        return response.status(500).json({ error: "An internal server error occurred." });
    }
}
