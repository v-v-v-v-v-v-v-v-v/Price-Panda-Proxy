// api/proxy.js - UPDATED with logging

import crypto from 'crypto';

const OFFICIAL_API_GATEWAY = "https://api-sg.aliexpress.com/sync";
const OFFICIAL_API_METHOD = "aliexpress.affiliate.product.query";

function generateAliexpressSignature(params, secretKey) {
    const sortedKeys = Object.keys(params).sort();
    const concatenatedString = sortedKeys.map(key => key + params[key]).join('');
    return crypto.createHmac('sha256', secretKey).update(concatenatedString).digest('hex').toUpperCase();
}

export default async function handler(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*'); 
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
        return response.status(200).end();
    }
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // *** CHECKPOINT 4: See what the proxy received ***
        console.log("PROXY: Received request body ->", request.body);

        const { keywords, categoryId, targetCurrency } = request.body;
        const appKey = process.env.ALIEXPRESS_APP_KEY;
        const secretKey = process.env.ALIEXPRESS_SECRET_KEY;
        const trackingId = process.env.ALIEXPRESS_TRACKING_ID || "default";

        if (!keywords || !appKey || !secretKey) {
            console.error("PROXY: Missing required parameters or server keys.");
            return response.status(400).json({ error: "Missing required parameters from client or server keys." });
        }
        
        const params = {
            'app_key': appKey,
            'method': OFFICIAL_API_METHOD,
            'sign_method': 'hmac-sha256',
            'timestamp': String(Date.now()),
            'keywords': keywords,
            'tracking_id': trackingId,
            'target_language': 'en',
            'target_currency': targetCurrency || 'USD',
            'page_size': '50',
            'sort': 'BEST_MATCH'
        };
        if (categoryId) {
            params.category_id = categoryId;
        }
        params.sign = generateAliexpressSignature(params, secretKey);

        console.log(`PROXY: Calling AliExpress API with currency: ${params.target_currency}`);

        const apiResponse = await fetch(OFFICIAL_API_GATEWAY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-form-urlencoded;charset=utf-8' },
            body: new URLSearchParams(params)
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.text();
            console.error("PROXY: AliExpress API Error:", errorBody);
            throw new Error(`AliExpress API request failed with status: ${apiResponse.status}`);
        }

        const data = await apiResponse.json();
        const allResults = data.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product || [];

        console.log(`PROXY: Sending ${allResults.length} raw results back to extension.`);
        return response.status(200).json({ products: allResults });

    } catch (err) {
        console.error("PROXY: Critical Server Error:", err.message);
        return response.status(500).json({ error: "An internal server error occurred." });
    }
}
