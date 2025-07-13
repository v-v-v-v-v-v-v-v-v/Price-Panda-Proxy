
import crypto from 'crypto';

const OFFICIAL_API_GATEWAY = "https://api-sg.aliexpress.com/sync";
const OFFICIAL_API_METHOD = "aliexpress.affiliate.product.query";

function generateAliexpressSignature(params, secretKey) {
    const sortedKeys = Object.keys(params).sort();
    const concatenatedString = sortedKeys.map(key => key + params[key]).join('');
    const signature = crypto.createHmac('sha256', secretKey)
                            .update(concatenatedString)
                            .digest('hex')
                            .toUpperCase();
    return signature;
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
        const body = request.body;

        const appKey = process.env.ALIEXPRESS_APP_KEY;
        const secretKey = process.env.ALIEXPRESS_SECRET_KEY;
        const trackingId = process.env.ALIEXPRESS_TRACKING_ID || "default";

        const { keywords, categoryId } = body;

        if (!appKey || !secretKey) {
            console.error("Server Error: API keys not configured on Vercel.");
            return response.status(500).json({ error: 'API keys are not configured on the server.' });
        }
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
                'tracking_id': trackingId, 
                'target_language': 'en',
                'target_currency': 'USD',
                'page_size': '50',
                'sort': sortOrder,
            };
            if (categoryId) { params.category_id = categoryId; }
            params.sign = generateAliexpressSignature(params, secretKey);

            const apiResponse = await fetch(OFFICIAL_API_GATEWAY, { method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(params) });
            if (!apiResponse.ok) return [];
            const data = await apiResponse.json();
            if (data.error_response || !data.aliexpress_affiliate_product_query_response?.resp_result?.result) return [];
            return data.aliexpress_affiliate_product_query_response.resp_result.result.products?.product || [];
        };

        const [bestMatchResults, bestSellerResults] = await Promise.all([ createApiCall('MATCH_ORDER_DESC'), createApiCall('LAST_VOLUME_DESC') ]);
        const uniqueResults = Array.from(new Map([...bestMatchResults, ...bestSellerResults].map(item => [item.product_id, item])).values());
        
        return response.status(200).json({ products: uniqueResults });

    } catch (err) {
        console.error("Critical Server Error:", err);
        return response.status(500).json({ error: "An internal server error occurred." });
    }
}
