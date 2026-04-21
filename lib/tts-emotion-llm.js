// Optional LLM-based emotion classifier — fallback for cases where the
// regex preprocessor in tts-expression.js can't infer nuance from text alone.
//
// Talks to any OpenAI-compatible chat/completions endpoint:
//   - OpenWebUI:  https://<host>/api/chat/completions  (Bearer key)
//   - Ollama:     http://<host>:11434/v1/chat/completions  (Bearer key optional)
//   - Anything else with the same shape (LM Studio, vLLM, etc.)
//
// The model is asked to return a JSON object — we accept either:
//   {"emotion":"angry","intensity":0.8}            — single label
//   {"segments":[{"text":"...","emotion":"...","intensity":0.7}, ...]}  — multi
//
// Failures are non-fatal: caller falls back to regex segments.

'use strict';

const crypto = require('crypto');

const VALID = new Set(['neutral', 'soft', 'excited', 'yell', 'angry', 'sad', 'happy']);
const CACHE_MAX = 500;
const _cache = new Map(); // sha256(text) -> { at, segments }

function _keyFor(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function _config() {
    const url = (process.env.EMOTION_LLM_URL || '').trim();
    const model = (process.env.EMOTION_LLM_MODEL || '').trim();
    const key = (process.env.EMOTION_LLM_API_KEY || '').trim();
    const enabled = process.env.EMOTION_LLM_ENABLED === '1' || process.env.EMOTION_LLM_ENABLED === 'true';
    const timeoutMs = parseInt(process.env.EMOTION_LLM_TIMEOUT_MS || '5000', 10);
    return { url, model, key, enabled, timeoutMs };
}

function isAvailable() {
    const c = _config();
    return c.enabled && !!c.url && !!c.model;
}

function _evict() {
    if (_cache.size <= CACHE_MAX) return;
    // Drop oldest 20% — Map iterates insertion order.
    const drop = Math.floor(_cache.size * 0.2);
    let i = 0;
    for (const k of _cache.keys()) {
        _cache.delete(k);
        if (++i >= drop) break;
    }
}

function _normalizeEmotion(s) {
    const v = String(s || 'neutral').toLowerCase().trim();
    return VALID.has(v) ? v : 'neutral';
}

function _normalizeSegments(parsed, originalText) {
    // Single-label response → one segment covering whole text
    if (parsed && parsed.emotion && !parsed.segments) {
        return [{
            text: originalText,
            emotion: _normalizeEmotion(parsed.emotion),
            intensity: Math.max(0, Math.min(1, Number(parsed.intensity ?? 0.7))),
            pause_ms_after: 0,
        }];
    }
    if (!parsed || !Array.isArray(parsed.segments) || !parsed.segments.length) return null;
    const out = [];
    for (const s of parsed.segments) {
        if (!s || typeof s.text !== 'string' || !s.text.trim()) continue;
        out.push({
            text: s.text.trim(),
            emotion: _normalizeEmotion(s.emotion),
            intensity: Math.max(0, Math.min(1, Number(s.intensity ?? 0.7))),
            pause_ms_after: Number(s.pause_ms_after) || 0,
        });
    }
    return out.length ? out : null;
}

const SYSTEM_PROMPT = `You classify text into spoken-emotion segments for a TTS engine.

Available emotions: neutral, soft, excited, yell, angry, sad, happy.
Intensity is 0.0..1.0 — how strongly the emotion comes through.

Respond with ONLY valid JSON in one of these shapes:

If the whole text is one emotion:
{"emotion":"<one of the emotions>","intensity":<0.0-1.0>}

If the text shifts emotion mid-utterance, segment it (keep word order):
{"segments":[
  {"text":"<exact substring>","emotion":"<emotion>","intensity":<0.0-1.0>},
  ...
]}

Rules:
- ALL CAPS runs → emotion="yell"
- Whispered / soft cues (lowercase + ellipses, *softly*, [whisper]) → emotion="soft"
- !!! or "what?!" → emotion="excited"
- Bracketed mood tags ([angry], [sad], etc.) override and apply to following text
- Keep the original text verbatim across segments — no rewording
- No prose, no markdown, just the JSON.`;

async function _httpClassify(text) {
    const c = _config();
    if (!c.enabled || !c.url || !c.model) return null;
    const url = c.url.endsWith('/chat/completions') ? c.url : `${c.url.replace(/\/+$/, '')}/chat/completions`;
    const body = {
        model: c.model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
        ],
        temperature: 0.1,
        max_tokens: 800,
        // Some servers (Ollama via /v1) honor response_format; others ignore it
        response_format: { type: 'json_object' },
        // Disable Qwen3 thinking mode — otherwise it eats 1000–3000 tokens on a
        // chain-of-thought before returning the JSON, blowing past max_tokens.
        chat_template_kwargs: { enable_thinking: false },
        // Passed via Ollama's /v1 → options bridge. 4K keeps Qwen3's VRAM
        // footprint small enough to coexist with Fish-Speech on the 3090.
        options: { num_ctx: 4096 },
        stream: false,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (c.key) headers.Authorization = `Bearer ${c.key}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), c.timeoutMs);
    let resp;
    try {
        resp = await fetch(url, {
            method: 'POST', headers, body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } catch (e) {
        clearTimeout(t);
        return { _error: 'network: ' + (e.message || 'timeout') };
    }
    clearTimeout(t);
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return { _error: `http ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { _error: 'no choices[0].message.content in response' };
    // Some models wrap the JSON in code fences or add trailing prose. Pull
    // out the first balanced { ... } JSON object if a clean parse fails.
    let parsed;
    try { parsed = JSON.parse(content); }
    catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) return { _error: 'no JSON object in response: ' + content.slice(0, 200) };
        try { parsed = JSON.parse(m[0]); }
        catch (e) { return { _error: 'JSON parse failed: ' + e.message }; }
    }
    return parsed;
}

// Public: classify text → returns segment array (engine-agnostic, same shape
// as lib/tts-expression.js's segmentText) or null if classifier is disabled
// / unavailable / errored.
async function classifyEmotion(text) {
    if (!isAvailable()) return null;
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    const key = _keyFor(trimmed);
    const cached = _cache.get(key);
    if (cached && (Date.now() - cached.at) < 6 * 60 * 60 * 1000) return cached.segments;

    const raw = await _httpClassify(trimmed);
    if (!raw || raw._error) {
        console.warn('[tts-emotion-llm] classify failed:', raw && raw._error);
        return null;
    }
    const segments = _normalizeSegments(raw, trimmed);
    if (segments) {
        _cache.set(key, { at: Date.now(), segments });
        _evict();
    }
    return segments;
}

module.exports = {
    classifyEmotion,
    isAvailable,
    _internal: { _config, _normalizeSegments, SYSTEM_PROMPT },
};
