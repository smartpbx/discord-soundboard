// Voice training orchestration.
//
// Spawns `claude -p` headless with the voice-trainer agent, parses
// stream-json events, persists progress to data/training-jobs/<job_id>/.
//
// Architecture:
//   * Claude Code CLI installed on CT 109 (this container)
//   * Claude SSH-invokes pipeline scripts on CT 110 (GPU)
//   * Each job's state lives in data/training-jobs/<job_id>/
//       - meta.json     (input + status snapshot)
//       - events.jsonl  (newline-delimited claude stream-json events)
//       - agent.log     (raw stdout for debugging)
//
// Jobs run as detached subprocesses (survive parent restarts). On startup
// we scan for jobs and re-attach to any still-running PID.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const JOBS_DIR = path.join(__dirname, '..', 'data', 'training-jobs');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TTS_HOST = process.env.TTS_SSH_HOST || 'root@10.10.10.72';
const VOICE_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function listJobs() {
    ensureDir(JOBS_DIR);
    return fs.readdirSync(JOBS_DIR)
        .filter(f => fs.statSync(path.join(JOBS_DIR, f)).isDirectory())
        .map(loadJob)
        .filter(Boolean);
}

function loadJob(jobId) {
    const metaPath = path.join(JOBS_DIR, jobId, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
}

function saveJob(meta) {
    const dir = path.join(JOBS_DIR, meta.id);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function jobLogPath(jobId) { return path.join(JOBS_DIR, jobId, 'agent.log'); }
function jobEventsPath(jobId) { return path.join(JOBS_DIR, jobId, 'events.jsonl'); }
function jobAgentMdPath() { return path.join(__dirname, '..', 'tts-server', 'tools', 'rvc_pipeline', 'voice-trainer-agent.md'); }

function isPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// Build the user-facing prompt that gets passed to claude -p.
function buildPrompt(input) {
    const lines = [
        `Train a voice model for **${input.name}** (voice_id: \`${input.voice_id}\`).`,
        ``,
        `Group: ${input.group}`,
        `Gender: ${input.gender}`,
    ];
    if (input.urls && input.urls.length) {
        lines.push(``, `Use these source clips:`);
        input.urls.forEach(u => lines.push(`  - ${u}`));
    } else {
        lines.push(``, `Find good source clips yourself. Aim for 5-10 clips totaling 20-30 minutes of clean audio.`);
    }
    if (input.speaker_markers && input.speaker_markers.length) {
        lines.push(``, `Speaker marker words (used by the cluster phase to identify the target): ${input.speaker_markers.join(', ')}`);
    }
    if (input.notes) {
        lines.push(``, `Additional notes from the requester: ${input.notes}`);
    }
    lines.push(
        ``,
        `Run the full six-phase pipeline. Report concise status updates as you go.`,
        `Do NOT flip skip_rvc on the Chatterbox metadata — leave the human gate intact.`,
    );
    return lines.join('\n');
}

function buildAllowedTools() {
    // Claude needs to:
    //   - SSH to CT 110 to invoke pipeline scripts and check files
    //   - Run yt-dlp / ffprobe locally for quick URL validation
    //   - Read/Write local files for job state and prompts
    //   - WebSearch / WebFetch for finding source URLs
    return [
        `Bash(ssh ${TTS_HOST}:*)`,
        `Bash(yt-dlp:*)`,
        `Bash(ffprobe:*)`,
        `Bash(cat:*)`,
        `Bash(ls:*)`,
        `Read`,
        `Write`,
        `WebSearch`,
        `WebFetch`,
    ];
}

function startJob(input) {
    const voiceId = String(input.voice_id || '').trim().toLowerCase();
    if (!VOICE_ID_RE.test(voiceId)) throw Object.assign(new Error('Invalid voice_id'), { status: 400 });
    if (!input.name || typeof input.name !== 'string') throw Object.assign(new Error('name required'), { status: 400 });

    const jobId = `${voiceId}_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(JOBS_DIR, jobId);
    ensureDir(dir);

    const cleanInput = {
        voice_id: voiceId,
        name: String(input.name).trim().slice(0, 80),
        group: ['Celebrity', 'Cartoon', 'Gaming', 'Other'].includes(input.group) ? input.group : 'Celebrity',
        gender: ['male', 'female', 'unknown'].includes(input.gender) ? input.gender : 'male',
        urls: Array.isArray(input.urls) ? input.urls.filter(u => typeof u === 'string').slice(0, 20) : [],
        speaker_markers: Array.isArray(input.speaker_markers) ? input.speaker_markers.filter(m => typeof m === 'string').slice(0, 20) : [],
        notes: typeof input.notes === 'string' ? input.notes.slice(0, 500) : '',
    };

    const agentMdPath = jobAgentMdPath();
    if (!fs.existsSync(agentMdPath)) throw Object.assign(new Error('Agent definition missing: ' + agentMdPath), { status: 500 });
    const systemPrompt = fs.readFileSync(agentMdPath, 'utf8');

    const prompt = buildPrompt(cleanInput);
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
    fs.writeFileSync(path.join(dir, 'system_prompt.md'), systemPrompt);

    const allowedTools = buildAllowedTools();
    const args = [
        '-p', prompt,
        '--verbose',
        '--output-format', 'stream-json',
        '--append-system-prompt', systemPrompt,
        '--allowedTools', allowedTools.join(' '),
        '--max-turns', '200',
    ];

    const logFd = fs.openSync(jobLogPath(jobId), 'a');
    const eventsFd = fs.openSync(jobEventsPath(jobId), 'a');

    // Spawn claude as a detached subprocess. It survives parent restarts.
    // stdout streams stream-json events; we tee them to events.jsonl + agent.log.
    const child = spawn(CLAUDE_BIN, args, {
        detached: true,
        stdio: ['ignore', 'pipe', logFd],
        env: { ...process.env },
    });

    child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        fs.writeSync(eventsFd, text);
        fs.writeSync(logFd, text);
    });
    child.on('exit', (code) => {
        try { fs.closeSync(logFd); } catch {}
        try { fs.closeSync(eventsFd); } catch {}
        const meta = loadJob(jobId);
        if (meta) {
            meta.status = code === 0 ? 'completed' : 'failed';
            meta.exit_code = code;
            meta.finished_at = Date.now();
            saveJob(meta);
        }
    });
    child.unref();

    const meta = {
        id: jobId,
        input: cleanInput,
        status: 'running',
        pid: child.pid,
        started_at: Date.now(),
        finished_at: null,
        exit_code: null,
    };
    saveJob(meta);
    return meta;
}

function cancelJob(jobId) {
    const meta = loadJob(jobId);
    if (!meta) throw Object.assign(new Error('Job not found'), { status: 404 });
    if (meta.pid && isPidAlive(meta.pid)) {
        try { process.kill(meta.pid, 'SIGTERM'); } catch {}
    }
    meta.status = 'cancelled';
    meta.finished_at = Date.now();
    saveJob(meta);
    return meta;
}

// Read events.jsonl, parse, return flattened progress events.
// Stream-json from claude is a sequence of objects; we extract the ones we
// care about (system init for session_id, assistant text deltas for user-
// visible messages, tool_use for what claude is doing, errors).
function getJobEvents(jobId, sinceLine = 0) {
    const p = jobEventsPath(jobId);
    if (!fs.existsSync(p)) return { events: [], lines: 0 };
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const events = [];
    for (let i = sinceLine; i < lines.length; i++) {
        let evt;
        try { evt = JSON.parse(lines[i]); } catch { continue; }
        const type = evt.type;
        if (type === 'system' && evt.subtype === 'init') {
            events.push({ kind: 'session_started', session_id: evt.session_id || null, line: i });
        } else if (type === 'assistant') {
            // Final assistant message (full content blocks)
            const content = evt.message && evt.message.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'text') events.push({ kind: 'message', text: block.text, line: i });
                    else if (block.type === 'tool_use') events.push({ kind: 'tool_use', name: block.name, input: block.input, line: i });
                }
            }
        } else if (type === 'user' && evt.message && Array.isArray(evt.message.content)) {
            for (const block of evt.message.content) {
                if (block.type === 'tool_result') {
                    let summary;
                    if (typeof block.content === 'string') summary = block.content.slice(0, 500);
                    else if (Array.isArray(block.content)) summary = block.content.map(c => c.text || '').join('').slice(0, 500);
                    events.push({ kind: 'tool_result', summary, line: i });
                }
            }
        } else if (type === 'result') {
            events.push({ kind: 'result', subtype: evt.subtype, usage: evt.usage, total_cost_usd: evt.total_cost_usd, line: i });
        }
    }
    return { events, lines: lines.length };
}

function getJobStatus(jobId) {
    const meta = loadJob(jobId);
    if (!meta) throw Object.assign(new Error('Job not found'), { status: 404 });
    if (meta.status === 'running' && meta.pid && !isPidAlive(meta.pid)) {
        // Detect orphaned status — the subprocess died but exit handler didn't fire
        // (e.g. parent process restarted). Mark as finished.
        meta.status = 'unknown_exit';
        meta.finished_at = Date.now();
        saveJob(meta);
    }
    return meta;
}

// Parse events.jsonl to derive current phase, training progress, and ETA.
// Returns null if not enough info yet.
const PHASE_ORDER = ['init', 'download', 'transcribe', 'cluster', 'extract', 'train', 'deploy'];
const PHASE_WEIGHTS = { init: 0.01, download: 0.08, transcribe: 0.12, cluster: 0.04, extract: 0.02, train: 0.70, deploy: 0.03 };
const PHASE_SCRIPT_PATTERNS = [
    { pattern: /init_job\.py/, phase: 'init' },
    { pattern: /01_download\.py/, phase: 'download' },
    { pattern: /02_transcribe\.py/, phase: 'transcribe' },
    { pattern: /03_cluster\.py/, phase: 'cluster' },
    { pattern: /04_extract\.py/, phase: 'extract' },
    { pattern: /05_train\.py/, phase: 'train' },
    { pattern: /06_deploy\.py/, phase: 'deploy' },
];

function computeProgress(jobId) {
    const p = jobEventsPath(jobId);
    if (!fs.existsSync(p)) return null;
    const meta = loadJob(jobId);
    if (!meta) return null;

    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    let currentPhase = null;
    let completedPhases = new Set();
    let training = null;
    let lastToolContent = '';

    // Last training epoch log-line parser
    // "joe_rogan_test | epoch=183 | step=55266 | time=20:55:07 | training_speed=0:01:10 | lowest_value=22.507 (epoch 133 ...) | ... | smoothed_loss_gen=22.913 | smoothed_loss_disc=4.000"
    const epochRe = /epoch=(\d+)\s*\|\s*step=(\d+).*?training_speed=(\d+):(\d+):(\d+).*?lowest_value=([\d.]+).*?smoothed_loss_gen=([\d.]+)/g;
    // Phase completion signal: "Saved model '....200e_..." indicates final epoch saved; "deploy.done" written

    for (const line of lines) {
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }

        if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
            for (const block of evt.message.content) {
                if (block.type !== 'tool_use') continue;
                const cmd = typeof block.input === 'object' ? JSON.stringify(block.input) : String(block.input || '');
                for (const { pattern, phase } of PHASE_SCRIPT_PATTERNS) {
                    if (pattern.test(cmd)) {
                        currentPhase = phase;
                        // Mark earlier phases complete
                        const idx = PHASE_ORDER.indexOf(phase);
                        for (let i = 0; i < idx; i++) completedPhases.add(PHASE_ORDER[i]);
                    }
                }
            }
        } else if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
            for (const block of evt.message.content) {
                if (block.type !== 'tool_result') continue;
                const content = typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : '';
                lastToolContent = content;

                // Scan for phase .done markers
                for (const phase of PHASE_ORDER) {
                    if (content.includes(`"phase": "${phase}", "status": "complete"`) || content.includes(`${phase}.done`)) {
                        completedPhases.add(phase);
                    }
                }

                // Scan for epoch log lines — take the LAST match
                epochRe.lastIndex = 0;
                let m; let lastMatch = null;
                while ((m = epochRe.exec(content)) !== null) lastMatch = m;
                if (lastMatch) {
                    const [, ep, step, h, mm, ss, lowLoss, currLoss] = lastMatch;
                    const secPerEpoch = (+h * 3600) + (+mm * 60) + (+ss);
                    training = {
                        current_epoch: parseInt(ep, 10),
                        current_step: parseInt(step, 10),
                        sec_per_epoch: secPerEpoch,
                        lowest_loss: parseFloat(lowLoss),
                        current_loss: parseFloat(currLoss),
                    };
                }
            }
        }
    }

    // Fill in training totals from input
    const totalEpochs = meta.input && meta.input.total_epoch ? meta.input.total_epoch : 200;
    if (training) {
        training.total_epochs = totalEpochs;
        training.eta_seconds = Math.max(0, (totalEpochs - training.current_epoch) * training.sec_per_epoch);
    }

    // Derive overall percentage: sum of completed phase weights + sub-progress within current phase
    let overallPct = 0;
    for (const phase of PHASE_ORDER) {
        if (completedPhases.has(phase)) overallPct += (PHASE_WEIGHTS[phase] || 0);
    }
    if (currentPhase && !completedPhases.has(currentPhase)) {
        let subProgress = 0;
        if (currentPhase === 'train' && training) {
            subProgress = Math.min(1, training.current_epoch / totalEpochs);
        } else {
            // Assume 50% into the phase if we see it started but no more signal
            subProgress = 0.5;
        }
        overallPct += (PHASE_WEIGHTS[currentPhase] || 0) * subProgress;
    }
    overallPct = Math.min(0.99, overallPct);  // never claim 100% until completed

    // Overall ETA — mostly dominated by training
    let overallEta = null;
    if (meta.status === 'running') {
        if (currentPhase === 'train' && training && training.eta_seconds > 0) {
            overallEta = training.eta_seconds + 60;  // ~1 min for deploy
        } else if (meta.status === 'running' && currentPhase && currentPhase !== 'train') {
            // Rough: remaining non-training phases ~15–30 min, training ~3–4 hr
            overallEta = 4 * 3600;
        }
    }

    if (meta.status === 'completed') {
        overallPct = 1;
        overallEta = 0;
        // Mark all phases done
        PHASE_ORDER.forEach(p => completedPhases.add(p));
    } else if (meta.status === 'failed' || meta.status === 'cancelled' || meta.status === 'unknown_exit') {
        overallEta = null;
    }

    return {
        current_phase: currentPhase,
        phase_index: currentPhase ? PHASE_ORDER.indexOf(currentPhase) : null,
        completed_phases: Array.from(completedPhases).sort((a, b) => PHASE_ORDER.indexOf(a) - PHASE_ORDER.indexOf(b)),
        training,
        overall_percentage: Math.round(overallPct * 100),
        overall_eta_seconds: overallEta,
    };
}

module.exports = {
    JOBS_DIR,
    listJobs,
    startJob,
    cancelJob,
    getJobStatus,
    getJobEvents,
    computeProgress,
};
