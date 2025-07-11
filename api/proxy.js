import crypto from 'crypto'; // Using Node.js's built-in crypto library

const OFFICIAL_API_GATEWAY = "https://api-sg.aliexpress.com/sync";
const OFFICIAL_API_METHOD = "aliexpress.affiliate.product.query";
const TRACKING_ID = "default";


function generateAliexpressSignature(params, secretKey) {
    const sortedKeys = Object.keys(params).sort();
    const concatenatedString = sortedKeys.map(key => key + params[key]).join('');
    // Use Node.js's native crypto module for HMAC-SHA256
    const signature = crypto.createHmac('sha256', secretKey)
                            .update(concatenatedString)
                            .digest('hex')
                            .toUpperCase();
    return signature;
}


export default async function handler(request, response) {
    // We expect a POST request with the search terms
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

  
    const appKey = process.env.ALIEXPRESS_APP_KEY;
    const secretKey = process.env.ALIEXPRESS_SECRET_KEY;

    if (!appKey || !secretKey) {
        return response.status(500).json({ error: 'API keys are not configured on the server.' });
    }

    const { keywords, categoryId } = request.body;
    if (!keywords) {
        return response.status(400).json({ error: 'Keywords are required.' });
    }

    const createApiCall = async (sortOrder) => {
        const params = {
            'app_key': appKey,
            'method': OFFICIAL_API_METHOD,
            'sign_method': 'hmac-sha256',
            'timestamp': String(Date.now()),
            'keywords': keywords,
            'tracking_id': TRACKING_ID,
            'target_language': 'en',
            'target_currency': 'USD',
            'page_size': '50',
            'sort': sortOrder,
        };
        if (categoryId) {
            params.category_id = categoryId;
        }
        
        params.sign = generateAliexpressSignature(params, secretKey);

        try {
            const apiResponse = await fetch(OFFICIAL_API_GATEWAY, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-form-urlencoded;charset=utf-8' },
                body: new URLSearchParams(params)
            });

            if (!apiResponse.ok) return [];
            const data = await apiResponse.json();
            if (data.error_response || !data.aliexpress_affiliate_product_query_response?.resp_result?.result) return [];
            return data.aliexpress_affiliate_product_query_response.resp_result.result.products?.product || [];
        } catch (e) {
            console.error(`API call failed for sort order ${sortOrder}:`, e);
            return [];
        }
    };

    try {
        const [bestMatchResults, bestSellerResults] = await Promise.all([
            createApiCall('MATCH_ORDER_DESC'),
            createApiCall('LAST_VOLUME_DESC')
        ]);
        
        const uniqueResults = Array.from(new Map([...bestMatchResults, ...bestSellerResults].map(item => [item.product_id, item])).values());

        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        response.status(200).json({ products: uniqueResults });

    } catch (err) {
        console.error("Top-level proxy execution error:", err);
        return response.status(500).json({ error: "Search request failed on the server." });
    }
}
