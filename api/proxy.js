// api/proxy.js - FINAL "Dumb Proxy" Version (with Rate Limiter)

// --- A. IMPORTS & RATE LIMITER SETUP ---
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import crypto from 'crypto';

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

// --- B. HELPER FUNCTIONS ---
const OFFICIAL_API_GATEWAY = "https://api-sg.aliexpress.com/sync";
const OFFICIAL_API_METHOD = "aliexpress.affiliate.product.query";

function generateAliexpressSignature(params, secretKey) {
    const sortedKeys = Object.keys(params).sort();
    const concatenatedString = sortedKeys.map(key => key + params[key]).join('');
    return crypto.createHmac('sha256', secretKey).update(concatenatedString).digest('hex').toUpperCase();
}

// --- C. MAIN SERVER HANDLER ---
export default async function handler(request, response) {
    // 1. APPLY RATE LIMITER (with "Fail Open" logic)
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
        // 2. EXTRACT KEYWORDS FROM REQUEST
        const { keywords, categoryId } = request.body;
        const appKey = process.env.ALIEXPRESS_APP_KEY;
        const secretKey = process.env.ALIEXPRESS_SECRET_KEY;
        const trackingId = process.env.ALIEXPRESS_TRACKING_ID || "default";

        if (!keywords || !appKey || !secretKey) {
            return response.status(400).json({ error: "Missing required parameters or server keys." });
        }
        
        // 3. CALL THE ALIEXPRESS API
        const params = {
            'app_key': appKey, 'method': OFFICIAL_API_METHOD, 'sign_method': 'hmac-sha256',
            'timestamp': String(Date.now()), 'keywords': keywords, 'tracking_id': trackingId,
            'target_language': 'en', 'target_currency': 'USD', 'page_size': '50', 'sort': 'BEST_MATCH'
        };
        if (categoryId) { params.category_id = categoryId; }
        params.sign = generateAliexpressSignature(params, secretKey);

        const apiResponse = await fetch(OFFICIAL_API_GATEWAY, {
            method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded;charset=utf-8' },
            body: new URLSearchParams(params)
        });

        if (!apiResponse.ok) { throw new Error('AliExpress API request failed'); }
        const data = await apiResponse.json();
        const allResults = data.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product || [];

        // 4. SEND RAW, UNSORTED RESULTS BACK TO THE CLIENT
        // The background.js script is now responsible for all ranking.
        return response.status(200).json({ products: allResults });

    } catch (err) {
        console.error("Critical Server Error:", err);
        return response.status(500).json({ error: "An internal server error occurred." });
    }
}
