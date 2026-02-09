/**
 * Inline Image Generation Extension for SillyTavern
 * * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 */

(function() {
    const MODULE_NAME = 'inline_image_gen';

    // Track messages currently being processed to prevent duplicate processing
    const processingMessages = new Set();

    // Log buffer for debugging
    const logBuffer = [];
    const MAX_LOG_ENTRIES = 200;

    function iigLog(level, ...args) {
        const timestamp = new Date().toISOString();
        const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const entry = `[${timestamp}] [${level}] ${message}`;
        
        logBuffer.push(entry);
        if (logBuffer.length > MAX_LOG_ENTRIES) {
            logBuffer.shift();
        }
        
        if (level === 'ERROR') {
            console.error('[IIG]', ...args);
        } else if (level === 'WARN') {
            console.warn('[IIG]', ...args);
        } else {
            console.log('[IIG]', ...args);
        }
    }

    function exportLogs() {
        const logsText = logBuffer.join('\n');
        const blob = new Blob([logsText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Логи экспортированы', 'Генерация картинок');
    }

    // Default settings
    const defaultSettings = Object.freeze({
        enabled: true,
        apiType: 'gemini', 
        endpoint: '',
        apiKey: '',
        model: '',
        size: '1024x1024',
        quality: 'standard',
        maxRetries: 0, 
        retryDelay: 1000,
        // Nano-banana specific
        sendCharAvatar: false,
        sendUserAvatar: false,
        userAvatarFile: '', 
        aspectRatio: '1:1', 
        imageSize: '1K', 
    });

    // Valid aspect ratios for Gemini/nano-banana
    const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
    // Valid image sizes for Gemini/nano-banana
    const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];
    
    // Prompt prefixes to force aspect ratio (Hack for Imagen 3)
    const RATIO_PROMPTS = {
        '16:9': 'Wide landscape view, cinematic shot, 16:9 aspect ratio, ',
        '21:9': 'Ultrawide cinematic panorama, 21:9 aspect ratio, ',
        '9:16': 'Tall vertical portrait, full body shot, 9:16 aspect ratio, ',
        '3:4': 'Vertical portrait, 3:4 aspect ratio, ',
        '4:3': 'Landscape view, 4:3 aspect ratio, ',
        '2:3': 'Vertical portrait, 2:3 aspect ratio, ',
        '3:2': 'Landscape view, 3:2 aspect ratio, ',
        '1:1': 'Square image, 1:1 aspect ratio, '
    };

    // Image model detection keywords
    const IMAGE_MODEL_KEYWORDS = [
        'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
        'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
        'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
    ];

    // Video model keywords to exclude
    const VIDEO_MODEL_KEYWORDS = [
        'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
        'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
        'vidu', 'wan-ai', 'hunyuan', 'hailuo'
    ];

    /**
     * Check if model ID is an image generation model
     */
    function isImageModel(modelId) {
        const mid = modelId.toLowerCase();
        for (const kw of VIDEO_MODEL_KEYWORDS) {
            if (mid.includes(kw)) return false;
        }
        if (mid.includes('vision') && mid.includes('preview')) return false;
        for (const kw of IMAGE_MODEL_KEYWORDS) {
            if (mid.includes(kw)) return true;
        }
        return false;
    }

    /**
     * Check if model is Gemini/nano-banana type
     */
    function isGeminiModel(modelId) {
        const mid = modelId.toLowerCase();
        return mid.includes('nano-banana') || mid.includes('gemini');
    }

    /**
     * Get extension settings
     */
    function getSettings() {
        const context = SillyTavern.getContext();
        
        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        }
        
        // Ensure all default keys exist
        for (const key of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
                context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
            }
        }
        
        return context.extensionSettings[MODULE_NAME];
    }

    /**
     * Save settings
     */
    function saveSettings() {
        const context = SillyTavern.getContext();
        context.saveSettingsDebounced();
    }

    /**
     * Fetch models list from endpoint
     */
    async function fetchModels() {
        const settings = getSettings();
        
        if (!settings.endpoint || !settings.apiKey) {
            console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
            return [];
        }
        
        let url = settings.endpoint;
        if (!url.endsWith('/models') && !url.includes('generateContent')) {
            url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
        }
        
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`
                }
            });
            
            if (!response.ok) {
                return [];
            }
            
            const data = await response.json();
            const models = data.data || [];
            
            return models.filter(m => isImageModel(m.id)).map(m => m.id);
        } catch (error) {
            return [];
        }
    }

    /**
     * Fetch list of user avatars
     */
    async function fetchUserAvatars() {
        try {
            const context = SillyTavern.getContext();
            const response = await fetch('/api/avatars/get', {
                method: 'POST',
                headers: context.getRequestHeaders(),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('[IIG] Failed to fetch user avatars:', error);
            return [];
        }
    }

    /**
     * Convert image URL to base64
     */
    async function imageUrlToBase64(url) {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const result = reader.result;
                    const base64 = result.includes(',') ? result.split(',')[1] : result;
                    resolve(base64);
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            iigLog('WARN', `Failed to convert image to base64 (CORS?): ${error.message}`);
            return null;
        }
    }

    /**
     * Save base64 image to file via SillyTavern API
     */
    async function saveImageToFile(dataUrl) {
        const context = SillyTavern.getContext();
        
        if (!dataUrl.startsWith('data:image')) {
             dataUrl = `data:image/jpeg;base64,${dataUrl}`;
        }

        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) {
            throw new Error('Invalid data URL format');
        }
        
        const format = match[1]; 
        const base64Data = match[2];
        
        let charName = 'generated';
        if (context.characterId !== undefined && context.characters?.[context.characterId]) {
            charName = context.characters[context.characterId].name || 'generated';
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `iig_${timestamp}`;
        
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                image: base64Data,
                format: format,
                ch_name: charName,
                filename: filename
            })
        });
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(error.error || `Upload failed: ${response.status}`);
        }
        
        const result = await response.json();
        console.log('[IIG] Image saved to:', result.path);
        return result.path;
    }

    /**
     * Get character avatar as base64
     */
    async function getCharacterAvatarBase64() {
        try {
            const context = SillyTavern.getContext();
            
            if (context.characterId === undefined || context.characterId === null) {
                return null;
            }
            
            if (typeof context.getCharacterAvatar === 'function') {
                const avatarUrl = context.getCharacterAvatar(context.characterId);
                if (avatarUrl) {
                    return await imageUrlToBase64(avatarUrl);
                }
            }
            
            const character = context.characters?.[context.characterId];
            if (character?.avatar) {
                const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
                return await imageUrlToBase64(avatarUrl);
            }
            
            return null;
        } catch (error) {
            console.error('[IIG] Error getting character avatar:', error);
            return null;
        }
    }

    /**
     * Get user avatar as base64
     */
    async function getUserAvatarBase64() {
        try {
            const settings = getSettings();
            
            if (!settings.userAvatarFile) {
                return null;
            }
            
            const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
            return await imageUrlToBase64(avatarUrl);
        } catch (error) {
            console.error('[IIG] Error getting user avatar:', error);
            return null;
        }
    }

    /**
     * Validate settings before generation
     */
    function validateSettings() {
        const settings = getSettings();
        const errors = [];
        
        if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
        if (!settings.apiKey) errors.push('API ключ не настроен');
        if (!settings.model) errors.push('Модель не выбрана');
        
        if (errors.length > 0) {
            throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
        }
    }

    /**
     * Generate image via OpenAI-compatible endpoint
     */
    async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
        const settings = getSettings();
        
        let url = settings.endpoint;
        if (!url.includes('/images/generations')) {
            url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
        }
        
        const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
        
        let size = settings.size;
        if (options.aspectRatio) {
            if (options.aspectRatio === '16:9') size = '1792x1024';
            else if (options.aspectRatio === '9:16') size = '1024x1792';
            else if (options.aspectRatio === '1:1') size = '1024x1024';
        }
        
        const body = {
            model: settings.model,
            prompt: fullPrompt,
            n: 1,
            size: size,
            quality: options.quality || settings.quality,
            response_format: 'b64_json'
        };
        
        if (referenceImages.length > 0) {
            body.image = `data:image/png;base64,${referenceImages[0]}`;
        }
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error (${response.status}): ${text}`);
        }
        
        const result = await response.json();
        const dataList = result.data || [];
        
        if (dataList.length > 0) {
            const imageObj = dataList[0];
            if (imageObj.b64_json) {
                return `data:image/png;base64,${imageObj.b64_json}`;
            }
            return imageObj.url;
        }
        
        if (result.url) return result.url;
        
        throw new Error('No image data in response');
    }

    /**
     * Generate image via Gemini-compatible endpoint (nano-banana)
     */
    async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
        const settings = getSettings();
        const model = settings.model;
        
        const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;
        
        let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
        if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
            aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
        }
        
        let imageSize = options.imageSize || settings.imageSize || '1K';
        if (!VALID_IMAGE_SIZES.includes(imageSize)) {
            imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
        }
        
        iigLog('INFO', `Using aspect ratio: ${aspectRatio}, image size: ${imageSize}`);
        
        const parts = [];
        
        for (const imgB64 of referenceImages.slice(0, 4)) {
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: imgB64
                }
            });
        }
        
        let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
        
        // --- FIX: Force aspect ratio in text prompt ---
        if (RATIO_PROMPTS[aspectRatio]) {
            fullPrompt = RATIO_PROMPTS[aspectRatio] + fullPrompt;
            iigLog('INFO', `Injected ratio prompt: ${RATIO_PROMPTS[aspectRatio]}`);
        }
        // ----------------------------------------------
        
        if (referenceImages.length > 0) {
            const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). Copy their visual features precisely.]`;
            fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
        }
        
        parts.push({ text: fullPrompt });
        
        const body = {
            contents: [{
                role: 'user',
                parts: parts
            }],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: imageSize
                }
            }
        };
        
        iigLog('INFO', `Gemini request: model=${model}, refs=${referenceImages.length}`);
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error (${response.status}): ${text}`);
        }
        
        const result = await response.json();
        console.log('[IIG] Gemini Raw Response:', result);
        
        const candidates = result.candidates || [];
        if (candidates.length === 0) {
            if (result.promptFeedback && result.promptFeedback.blockReason) {
                throw new Error(`Блокировка промпта (Safety): ${result.promptFeedback.blockReason}`);
            }
            throw new Error('Пустой ответ от модели.');
        }

        const responseParts = candidates[0].content?.parts || [];
        
        // 1. Ищем картинку в inlineData (base64)
        for (const part of responseParts) {
            if (part.inlineData) {
                return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
            if (part.inline_data) {
                return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
            }
        }

        // 2. Ищем ССЫЛКУ на картинку в тексте
        const textPart = responseParts.find(p => p.text);
        if (textPart) {
            const text = textPart.text;
            const imgMatch = text.match(/!\[.*?\]\((.*?)\)/) || text.match(/(https?:\/\/[^\s)]+)/);
            
            if (imgMatch) {
                const imgUrl = imgMatch[1];
                iigLog('INFO', `Found image URL: ${imgUrl}`);
                
                // Пытаемся скачать
                const base64 = await imageUrlToBase64(imgUrl);
                if (base64) {
                     return `data:image/jpeg;base64,${base64}`;
                } else {
                     // Если скачать не вышло, возвращаем URL как есть
                     iigLog('WARN', 'Returning remote URL directly');
                     return imgUrl;
                }
            }
            
            // Если ссылки нет, значит отказ
            const finishReason = candidates[0].finishReason;
            if (finishReason && finishReason !== 'STOP') {
                 throw new Error(`Отказ генерации (${finishReason}): "${text.substring(0, 100)}..."`);
            }
            throw new Error(`Модель ответила текстом без картинки: "${text.substring(0, 100)}..."`);
        }
        
        throw new Error('В ответе нет ни картинки, ни текста.');
    }

    /**
     * Generate image with retry logic
     */
    async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
        validateSettings();
        
        const settings = getSettings();
        const maxRetries = settings.maxRetries;
        const baseDelay = settings.retryDelay;
        
        const referenceImages = [];
        
        if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
            if (settings.sendCharAvatar) {
                console.log('[IIG] Fetching character avatar...');
                const charAvatar = await getCharacterAvatarBase64();
                if (charAvatar) referenceImages.push(charAvatar);
            }
            
            if (settings.sendUserAvatar) {
                console.log('[IIG] Fetching user avatar...');
                const userAvatar = await getUserAvatarBase64();
                if (userAvatar) referenceImages.push(userAvatar);
            }
        }
        
        let lastError;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
                
                if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                    return await generateImageGemini(prompt, style, referenceImages, options);
                } else {
                    return await generateImageOpenAI(prompt, style, referenceImages, options);
                }
            } catch (error) {
                lastError = error;
                console.error(`[IIG] Generation attempt ${attempt + 1} failed:`, error);
                
                const isRetryable = error.message?.includes('429') ||
                                   error.message?.includes('503') ||
                                   error.message?.includes('502') ||
                                   error.message?.includes('network');
                
                if (!isRetryable || attempt === maxRetries) {
                    break;
                }
                
                const delay = baseDelay * Math.pow(2, attempt);
                onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        throw lastError;
    }

    /**
     * Check if a file exists on the server
     */
    async function checkFileExists(path) {
        try {
            const response = await fetch(path, { method: 'HEAD' });
            return response.ok;
        } catch (e) {
            return false;
        }
    }

    /**
     * Parse image generation tags from message text
     */
    async function parseImageTags(text, options = {}) {
        const { checkExistence = false, forceAll = false } = options;
        const tags = [];
        
        // NEW FORMAT
        const imgTagMarker = 'data-iig-instruction=';
        let searchPos = 0;
        
        while (true) {
            const markerPos = text.indexOf(imgTagMarker, searchPos);
            if (markerPos === -1) break;
            
            let imgStart = text.lastIndexOf('<img', markerPos);
            if (imgStart === -1 || markerPos - imgStart > 500) {
                searchPos = markerPos + 1;
                continue;
            }
            
            const afterMarker = markerPos + imgTagMarker.length;
            let jsonStart = text.indexOf('{', afterMarker);
            if (jsonStart === -1 || jsonStart > afterMarker + 10) {
                searchPos = markerPos + 1;
                continue;
            }
            
            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;
            
            for (let i = jsonStart; i < text.length; i++) {
                const char = text[i];
                if (escapeNext) { escapeNext = false; continue; }
                if (char === '\\' && inString) { escapeNext = true; continue; }
                if (char === '"') { inString = !inString; continue; }
                if (!inString) {
                    if (char === '{') braceCount++;
                    else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) { jsonEnd = i + 1; break; }
                    }
                }
            }
            
            if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }
            
            let imgEnd = text.indexOf('>', jsonEnd);
            if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
            imgEnd++;
            
            const fullImgTag = text.substring(imgStart, imgEnd);
            const instructionJson = text.substring(jsonStart, jsonEnd);
            const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
            const srcValue = srcMatch ? srcMatch[1] : '';
            
            let needsGeneration = false;
            const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
            const hasErrorImage = srcValue.includes('error.svg');
            const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
            
            if (hasErrorImage && !forceAll) {
                searchPos = imgEnd;
                continue;
            }
            
            if (forceAll) {
                needsGeneration = true;
            } else if (hasMarker || !srcValue) {
                needsGeneration = true;
            } else if (hasPath && checkExistence) {
                const exists = await checkFileExists(srcValue);
                if (!exists) needsGeneration = true;
            } else if (hasPath) {
                searchPos = imgEnd;
                continue;
            }
            
            if (!needsGeneration) {
                searchPos = imgEnd;
                continue;
            }
            
            try {
                let normalizedJson = instructionJson
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&#34;/g, '"')
                    .replace(/&amp;/g, '&');
                
                const data = JSON.parse(normalizedJson);
                
                tags.push({
                    fullMatch: fullImgTag,
                    index: imgStart,
                    style: data.style || '',
                    prompt: data.prompt || '',
                    aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                    imageSize: data.image_size || data.imageSize || null,
                    quality: data.quality || null,
                    isNewFormat: true,
                    existingSrc: hasPath ? srcValue : null
                });
            } catch (e) {
                iigLog('WARN', `Failed to parse instruction JSON`, e.message);
            }
            
            searchPos = imgEnd;
        }
        
        // LEGACY FORMAT
        const marker = '[IMG:GEN:';
        let searchStart = 0;
        
        while (true) {
            const markerIndex = text.indexOf(marker, searchStart);
            if (markerIndex === -1) break;
            
            const jsonStart = markerIndex + marker.length;
            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;
            
            for (let i = jsonStart; i < text.length; i++) {
                const char = text[i];
                if (escapeNext) { escapeNext = false; continue; }
                if (char === '\\' && inString) { escapeNext = true; continue; }
                if (char === '"') { inString = !inString; continue; }
                if (!inString) {
                    if (char === '{') braceCount++;
                    else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) { jsonEnd = i + 1; break; }
                    }
                }
            }
            
            if (jsonEnd === -1) { searchStart = jsonStart; continue; }
            
            const jsonStr = text.substring(jsonStart, jsonEnd);
            const afterJson = text.substring(jsonEnd);
            if (!afterJson.startsWith(']')) { searchStart = jsonEnd; continue; }
            
            const tagOnly = text.substring(markerIndex, jsonEnd + 1);
            
            try {
                const normalizedJson = jsonStr.replace(/'/g, '"');
                const data = JSON.parse(normalizedJson);
                
                tags.push({
                    fullMatch: tagOnly,
                    index: markerIndex,
                    style: data.style || '',
                    prompt: data.prompt || '',
                    aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                    imageSize: data.image_size || data.imageSize || null,
                    quality: data.quality || null,
                    isNewFormat: false
                });
            } catch (e) {
                iigLog('WARN', `Failed to parse legacy tag JSON`, e.message);
            }
            
            searchStart = jsonEnd + 1;
        }
        
        return tags;
    }

    /**
     * Create loading placeholder element
     */
    function createLoadingPlaceholder(tagId) {
        const placeholder = document.createElement('div');
        placeholder.className = 'iig-loading-placeholder';
        placeholder.dataset.tagId = tagId;
        placeholder.innerHTML = `
            <div class="iig-spinner"></div>
            <div class="iig-status">Генерация картинки...</div>
        `;
        return placeholder;
    }

    // Error image path
    const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

    /**
     * Create error placeholder element
     */
    function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
        const img = document.createElement('img');
        img.className = 'iig-error-image';
        img.src = ERROR_IMAGE_PATH;
        img.alt = 'Ошибка генерации';
        img.title = `Ошибка: ${errorMessage}`;
        img.dataset.tagId = tagId;
        
        if (tagInfo.fullMatch) {
            const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
            if (instructionMatch) {
                img.setAttribute('data-iig-instruction', instructionMatch[2]);
            }
        }
        return img;
    }

    /**
     * Process image tags in a message
     */
    async function processMessageTags(messageId) {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        
        if (!settings.enabled) return;
        
        if (processingMessages.has(messageId)) return;
        
        const message = context.chat[messageId];
        if (!message || message.is_user) return;
        
        const tags = await parseImageTags(message.mes, { checkExistence: true });
        if (tags.length === 0) return;
        
        processingMessages.add(messageId);
        toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });
        
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) {
            toastr.error('Не удалось найти элемент сообщения', 'Генерация картинок');
            return;
        }
        
        const mesTextEl = messageElement.querySelector('.mes_text');
        if (!mesTextEl) return;
        
        const processTag = async (tag, index) => {
            const tagId = `iig-${messageId}-${index}`;
            const loadingPlaceholder = createLoadingPlaceholder(tagId);
            let targetElement = null;
            
            if (tag.isNewFormat) {
                const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
                const searchPrompt = tag.prompt.substring(0, 30);
                
                for (const img of allImgs) {
                    const instruction = img.getAttribute('data-iig-instruction');
                    if (instruction && instruction.includes(searchPrompt)) {
                        targetElement = img;
                        break;
                    }
                }
                
                if (!targetElement) {
                    const allImgsBroad = mesTextEl.querySelectorAll('img');
                    for (const img of allImgsBroad) {
                        const src = img.getAttribute('src') || '';
                        if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                            targetElement = img;
                            break;
                        }
                    }
                }
            } else {
                const tagEscaped = tag.fullMatch
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/"/g, '(?:"|&quot;)');
                const tagRegex = new RegExp(tagEscaped, 'g');
                
                mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
                    tagRegex,
                    `<span data-iig-placeholder="${tagId}"></span>`
                );
                
                targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
            }
            
            if (targetElement) {
                targetElement.replaceWith(loadingPlaceholder);
            } else {
                mesTextEl.appendChild(loadingPlaceholder);
            }
            
            const statusEl = loadingPlaceholder.querySelector('.iig-status');
            
            try {
                const dataUrl = await generateImageWithRetry(
                    tag.prompt,
                    tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
                );
                
                let imagePath;
                if (dataUrl.startsWith('http')) {
                    imagePath = dataUrl;
                } else {
                    statusEl.textContent = 'Сохранение...';
                    imagePath = await saveImageToFile(dataUrl);
                }
                
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
                
                if (tag.isNewFormat) {
                    const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                    if (instructionMatch) {
                        img.setAttribute('data-iig-instruction', instructionMatch[2]);
                    }
                }
                
                loadingPlaceholder.replaceWith(img);
                
                if (tag.isNewFormat) {
                    const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                    message.mes = message.mes.replace(tag.fullMatch, updatedTag);
                } else {
                    const completionMarker = `[IMG:✓:${imagePath}]`;
                    message.mes = message.mes.replace(tag.fullMatch, completionMarker);
                }
                
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок');
            } catch (error) {
                iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
                
                const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
                loadingPlaceholder.replaceWith(errorPlaceholder);
                
                if (tag.isNewFormat) {
                    const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                    message.mes = message.mes.replace(tag.fullMatch, errorTag);
                } else {
                    const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                    message.mes = message.mes.replace(tag.fullMatch, errorMarker);
                }
                
                toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
            }
        };
        
        try {
            await Promise.all(tags.map((tag, index) => processTag(tag, index)));
        } finally {
            processingMessages.delete(messageId);
        }
        
        await context.saveChat();
    }

    /**
     * Regenerate all images in a message
     */
    async function regenerateMessageImages(messageId) {
        const context = SillyTavern.getContext();
        const message = context.chat[messageId];
        
        if (!message) return;
        
        const tags = await parseImageTags(message.mes, { forceAll: true });
        if (tags.length === 0) {
            toastr.warning('Нет тегов для перегенерации', 'Генерация картинок');
            return;
        }
        
        toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
        processingMessages.add(messageId);
        
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) { processingMessages.delete(messageId); return; }
        
        const mesTextEl = messageElement.querySelector('.mes_text');
        
        for (let index = 0; index < tags.length; index++) {
            const tag = tags[index];
            const tagId = `iig-regen-${messageId}-${index}`;
            
            try {
                const existingImg = mesTextEl.querySelector(`img[data-iig-instruction]`);
                if (existingImg) {
                    const instruction = existingImg.getAttribute('data-iig-instruction');
                    const loadingPlaceholder = createLoadingPlaceholder(tagId);
                    existingImg.replaceWith(loadingPlaceholder);
                    const statusEl = loadingPlaceholder.querySelector('.iig-status');
                    
                    const dataUrl = await generateImageWithRetry(
                        tag.prompt,
                        tag.style,
                        (status) => { statusEl.textContent = status; },
                        { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
                    );
                    
                    let imagePath;
                    if (dataUrl.startsWith('http')) {
                        imagePath = dataUrl;
                    } else {
                        statusEl.textContent = 'Сохранение...';
                        imagePath = await saveImageToFile(dataUrl);
                    }
                    
                    const img = document.createElement('img');
                    img.className = 'iig-generated-image';
                    img.src = imagePath;
                    img.alt = tag.prompt;
                    if (instruction) img.setAttribute('data-iig-instruction', instruction);
                    
                    loadingPlaceholder.replaceWith(img);
                    
                    const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                    message.mes = message.mes.replace(tag.fullMatch, updatedTag);
                    
                    toastr.success(`Картинка ${index + 1}/${tags.length} готова`);
                }
            } catch (error) {
                toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
            }
        }
        
        processingMessages.delete(messageId);
        await context.saveChat();
    }

    /**
     * Add regenerate button to message
     */
    function addRegenerateButton(messageElement, messageId) {
        if (messageElement.querySelector('.iig-regenerate-btn')) return;
        
        const extraMesButtons = messageElement.querySelector('.extraMesButtons');
        if (!extraMesButtons) return;
        
        const btn = document.createElement('div');
        btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
        btn.title = 'Перегенерировать картинки';
        btn.tabIndex = 0;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await regenerateMessageImages(messageId);
        });
        
        extraMesButtons.appendChild(btn);
    }

    /**
     * Add buttons to all existing AI messages
     */
    function addButtonsToExistingMessages() {
        const context = SillyTavern.getContext();
        if (!context.chat || context.chat.length === 0) return;
        
        const messageElements = document.querySelectorAll('#chat .mes');
        for (const messageElement of messageElements) {
            const mesId = messageElement.getAttribute('mesid');
            if (mesId === null) continue;
            
            const messageId = parseInt(mesId, 10);
            const message = context.chat[messageId];
            
            if (message && !message.is_user) {
                addRegenerateButton(messageElement, messageId);
            }
        }
    }

    /**
     * Handle CHARACTER_MESSAGE_RENDERED event
     */
    async function onMessageReceived(messageId) {
        const settings = getSettings();
        if (!settings.enabled) return;
        
        const context = SillyTavern.getContext();
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) return;
        
        addRegenerateButton(messageElement, messageId);
        await processMessageTags(messageId);
    }

    /**
     * Create settings UI
     */
    function createSettingsUI() {
        const settings = getSettings();
        const container = document.getElementById('extensions_settings');
        if (!container) return;
        
        const html = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Генерация картинок</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="iig-settings">
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                            <span>Включить генерацию картинок</span>
                        </label>
                        <hr>
                        <h4>Настройки API</h4>
                        <div class="flex-row">
                            <label for="iig_api_type">Тип API</label>
                            <select id="iig_api_type" class="flex1">
                                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                            </select>
                        </div>
                        <div class="flex-row">
                            <label for="iig_endpoint">URL эндпоинта</label>
                            <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="http://localhost:8045">
                        </div>
                        <div class="flex-row">
                            <label for="iig_api_key">API ключ</label>
                            <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
                            <div id="iig_key_toggle" class="menu_button iig-key-toggle"><i class="fa-solid fa-eye"></i></div>
                        </div>
                        <div class="flex-row">
                            <label for="iig_model">Модель</label>
                            <select id="iig_model" class="flex1">
                                ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                            </select>
                            <div id="iig_refresh_models" class="menu_button iig-refresh-btn"><i class="fa-solid fa-sync"></i></div>
                        </div>
                        <hr>
                        <div id="iig_avatar_section" class="iig-avatar-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                            <h4>Настройки Nano-Banana</h4>
                            <div class="flex-row">
                                <label for="iig_image_size">Разрешение</label>
                                <select id="iig_image_size" class="flex1">
                                    <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (Стандарт)</option>
                                    <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K (Высокое)</option>
                                    <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K (Ультра)</option>
                                </select>
                            </div>
                            <div class="flex-row">
                                <label for="iig_aspect_ratio">Соотношение</label>
                                <select id="iig_aspect_ratio" class="flex1">
                                    <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                    <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                    <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                    <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Портрет)</option>
                                    <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Альбом)</option>
                                    <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Портрет)</option>
                                    <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Альбом)</option>
                                    <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикальный)</option>
                                    <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                    <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Кино)</option>
                                </select>
                            </div>
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                                <span>Отправлять аватар {{char}} (Может вызвать блок Safety!)</span>
                            </label>
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                                <span>Отправлять аватар {{user}}</span>
                            </label>
                        </div>
                        <hr>
                        <div class="flex-row">
                            <div id="iig_export_logs" class="menu_button" style="width: 100%;"><i class="fa-solid fa-download"></i> Экспорт логов</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        container.insertAdjacentHTML('beforeend', html);
        bindSettingsEvents();
    }

    /**
     * Bind settings event handlers
     */
    function bindSettingsEvents() {
        const settings = getSettings();
        
        document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
            settings.enabled = e.target.checked;
            saveSettings();
        });
        
        document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
            settings.apiType = e.target.value;
            saveSettings();
            document.getElementById('iig_avatar_section')?.classList.toggle('hidden', e.target.value !== 'gemini');
        });
        
        document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
            settings.endpoint = e.target.value;
            saveSettings();
        });
        
        document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
            settings.apiKey = e.target.value;
            saveSettings();
        });
        
        document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
            const input = document.getElementById('iig_api_key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        
        document.getElementById('iig_model')?.addEventListener('change', (e) => {
            settings.model = e.target.value;
            saveSettings();
            if (isGeminiModel(e.target.value)) {
                document.getElementById('iig_api_type').value = 'gemini';
                settings.apiType = 'gemini';
                document.getElementById('iig_avatar_section')?.classList.remove('hidden');
            }
        });
        
        document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.classList.add('loading');
            try {
                const models = await fetchModels();
                const select = document.getElementById('iig_model');
                const currentModel = settings.model;
                select.innerHTML = '<option value="">-- Выберите модель --</option>';
                for (const model of models) {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    option.selected = model === currentModel;
                    select.appendChild(option);
                }
                toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
            } catch (error) {
                toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
            } finally {
                btn.classList.remove('loading');
            }
        });
        
        // ДОБАВЛЕНО: Обработчик размера картинки
        document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
            settings.imageSize = e.target.value;
            saveSettings();
        });

        document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
            settings.aspectRatio = e.target.value;
            saveSettings();
        });
        
        document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
            settings.sendCharAvatar = e.target.checked;
            saveSettings();
        });
        
        document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
            settings.sendUserAvatar = e.target.checked;
            saveSettings();
        });
        
        document.getElementById('iig_export_logs')?.addEventListener('click', () => {
            exportLogs();
        });
    }

    /**
     * Initialize extension
     */
    (function init() {
        const context = SillyTavern.getContext();
        getSettings();
        
        context.eventSource.on(context.event_types.APP_READY, () => {
            createSettingsUI();
            addButtonsToExistingMessages();
            console.log('[IIG] Inline Image Generation extension loaded');
        });
        
        context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
            setTimeout(() => {
                addButtonsToExistingMessages();
            }, 100);
        });
        
        const handleMessage = async (messageId) => {
            await onMessageReceived(messageId);
        };
        
        context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
        
        console.log('[IIG] Inline Image Generation extension initialized');
    })();
})();