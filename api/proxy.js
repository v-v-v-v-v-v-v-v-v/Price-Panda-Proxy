// api/proxy.js - FINAL "Dumb Proxy" Version (NO ranking)

import crypto from 'crypto';

// --- A. HELPER FUNCTIONS ---
const OFFICIAL_API_GATEWAY = "https://api-sg.aliexpress.com/sync";
const OFFICIAL_API_METHOD = "aliexpress.affiliate.product.query";

function generateAliexpressSignature(params, secretKey) {
    const sortedKeys = Object.keys(params).sort();
    const concatenatedString = sortedKeys.map(key => key + params[key]).join('');
    return crypto.createHmac('sha256', secretKey).update(concatenatedString).digest('hex').toUpperCase();
}

// --- B. MAIN SERVER HANDLER ---
export default async function handler(request, response) {
    // Standard CORS and method handling
    response.setHeader('Access-Control-Allow-Origin', 'chrome-extension://oaicdpnnbookbcenmgcemnfajpdcdpmm');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { return response.status(200).end(); }
    if (request.method !== 'POST') { return response.status(405).json({ error: 'Method Not Allowed' }); }

    try {
        // 1. EXTRACT THE SIMPLE PAYLOAD FROM background.js
        const { keywords, categoryId } = request.body;
        const appKey = process.env.ALIEXPRESS_APP_KEY;
        const secretKey = process.env.ALIEXPRESS_SECRET_KEY;
        const trackingId = process.env.ALIEXPRESS_TRACKING_ID || "default";

        if (!keywords || !appKey || !secretKey) {
            return response.status(400).json({ error: "Missing required parameters from client or server keys." });
        }
        
        // 2. CALL THE ALIEXPRESS API
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

        // 3. SEND RAW, UNSORTED RESULTS BACK TO THE CLIENT
        console.log(`Sending ${allResults.length} raw results back to the extension.`);
        return response.status(200).json({ products: allResults });

    } catch (err) {
        console.error("Critical Server Error:", err);
        return response.status(500).json({ error: "An internal server error occurred." });
    }
}
