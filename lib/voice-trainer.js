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
const { execSync: _execSync } = require('child_process');

// Kill any pipeline / Applio training processes on CT 110 and restart TTS
// after a cancel. Best-effort; logs errors but does not throw.
function cleanupRemoteAndRestartTts() {
    try {
        _execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${TTS_HOST} 'pkill -TERM -f "rvc_pipeline" 2>/dev/null; pkill -TERM -f "core.py train" 2>/dev/null; sleep 2; pkill -KILL -f "rvc_pipeline" 2>/dev/null; pkill -KILL -f "core.py train" 2>/dev/null; systemctl start gptsovits.service tts-server.service'`, { stdio: 'ignore', timeout: 30000 });
    } catch (e) {
        console.error('[voice-trainer] remote cleanup failed:', e.message);
    }
}

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

    // Optional schedule: if run_after is set and in the future, the job stays
    // queued until the scheduler tick picks it up. Undefined / past = run now.
    let runAfter = Date.now();
    if (input.run_after != null) {
        const rawN = typeof input.run_after === 'number' ? input.run_after : Date.parse(input.run_after);
        if (Number.isFinite(rawN)) runAfter = Math.max(Date.now(), rawN);
    }

    const meta = {
        id: jobId,
        input: cleanInput,
        status: 'queued',        // scheduler picks this up
        pid: null,
        created_at: Date.now(),
        run_after: runAfter,
        started_at: null,
        finished_at: null,
        exit_code: null,
    };
    saveJob(meta);
    // Kick the scheduler so an immediately-runnable job starts without waiting for the tick.
    setImmediate(tickScheduler);
    return meta;
}

// Spawn the Claude subprocess for a queued job. Called by the scheduler when
// the job is due and no other job is running.
function _spawnQueuedJob(meta, resumePrompt) {
    const jobId = meta.id;
    const dir = path.join(JOBS_DIR, jobId);
    ensureDir(dir);

    const agentMdPath = jobAgentMdPath();
    if (!fs.existsSync(agentMdPath)) throw Object.assign(new Error('Agent definition missing: ' + agentMdPath), { status: 500 });
    const systemPrompt = fs.readFileSync(agentMdPath, 'utf8');

    const prompt = resumePrompt || buildPrompt(meta.input);
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

    // Wire Claude's stdout/stderr DIRECTLY to file descriptors (not through a
    // parent pipe). Previously stdio: ['ignore', 'pipe', logFd] meant the parent
    // owned the stdout pipe — when the soundboard restarted (e.g. via update.sh),
    // the pipe closed and Claude got SIGPIPE on its next write, killing the
    // training mid-run. With direct fds, the kernel keeps the file open as long
    // as the (orphaned) child holds a ref, so deploys are safe.
    const child = spawn(CLAUDE_BIN, args, {
        detached: true,
        stdio: ['ignore', eventsFd, logFd],
        env: { ...process.env },
    });
    // Parent's copies of the fds aren't needed — child has its own dups.
    try { fs.closeSync(eventsFd); } catch {}
    try { fs.closeSync(logFd); } catch {}
    child.on('exit', (code) => {
        const m = loadJob(jobId);
        if (m && m.status === 'running') {
            m.status = code === 0 ? 'completed' : 'failed';
            m.exit_code = code;
            m.finished_at = Date.now();
            saveJob(m);
        }
        // Let the next queued job run
        setImmediate(tickScheduler);
    });
    child.unref();

    meta.status = 'running';
    meta.pid = child.pid;
    meta.started_at = Date.now();
    saveJob(meta);
    return meta;
}

// Scheduler — single global loop. Picks the oldest queued-and-due job and
// starts it when nothing else is running. Only one job ever runs at a time
// (GPU is shared; two training jobs OOM).
function tickScheduler() {
    const jobs = listJobs();
    // remote_only jobs have no local Claude pid — pipeline runs on CT 110 and
    // we tail its train.log via SSH. Don't demote them based on local pid
    // checks; they self-resolve when train.done sentinel appears (handled by
    // the orphan recovery flow).
    const runningIds = jobs.filter(j => j.status === 'running' && (j.remote_only || isPidAlive(j.pid)));
    // Reap orphans — pid gone, meta still says running, NOT remote_only
    for (const j of jobs) {
        if (j.status === 'running' && !j.remote_only && (!j.pid || !isPidAlive(j.pid))) {
            j.status = 'unknown_exit';
            j.finished_at = Date.now();
            saveJob(j);
        }
    }
    if (runningIds.length > 0) return;   // someone's already running; wait

    const now = Date.now();
    const ready = jobs
        .filter(j => j.status === 'queued' && (j.run_after || 0) <= now)
        .sort((a, b) => (a.run_after || 0) - (b.run_after || 0) || a.created_at - b.created_at);
    if (ready.length === 0) return;

    const next = ready[0];
    const resumePrompt = next.resume_prompt || null;
    try {
        _spawnQueuedJob(next, resumePrompt);
    } catch (e) {
        console.error('[voice-trainer] scheduler failed to spawn job', next.id, e.message);
        next.status = 'failed';
        next.exit_code = -2;
        next.finished_at = Date.now();
        saveJob(next);
    }
}

let _schedulerInterval = null;
function startScheduler(intervalMs = 10000) {
    if (_schedulerInterval) return;
    _schedulerInterval = setInterval(tickScheduler, intervalMs);
    setImmediate(tickScheduler);
}

function cancelJob(jobId) {
    const meta = loadJob(jobId);
    if (!meta) throw Object.assign(new Error('Job not found'), { status: 404 });
    const wasRunning = meta.status === 'running';
    if (meta.pid && isPidAlive(meta.pid)) {
        try { process.kill(meta.pid, 'SIGTERM'); } catch {}
    }
    // Only kill remote pipeline + restart TTS if this was actually running
    // (a queued cancel shouldn't touch the GPU container).
    if (wasRunning) cleanupRemoteAndRestartTts();
    meta.status = 'cancelled';
    meta.finished_at = Date.now();
    saveJob(meta);
    setImmediate(tickScheduler);
    return meta;
}

// Re-attach a job whose Claude subprocess died but whose CT 110 pipeline is
// still running (e.g. spawn died on a soundboard restart, training did not).
// Marks meta.remote_only so the scheduler stops trying to demote it; the
// existing SSH train-log tail in computeProgress then drives the UI.
function adoptOrphan(jobId) {
    const meta = loadJob(jobId);
    if (!meta) throw Object.assign(new Error('Job not found'), { status: 404 });
    if (meta.status === 'running' && meta.remote_only) {
        return meta; // already adopted
    }
    if (meta.status === 'running') {
        throw Object.assign(new Error('Job already tracked locally; nothing to adopt'), { status: 409 });
    }
    const remoteDir = meta.pipeline_job_dir || findPipelineJobDir(jobId);
    if (!remoteDir) throw Object.assign(new Error('Could not locate pipeline job_dir for this job'), { status: 409 });
    // Probe CT 110 — must have an active 05_train.py process for this job_dir
    // OR a recently-modified train.log to be worth adopting.
    let alive = false;
    try {
        const out = _execSync(
            `ssh -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new ${TTS_HOST} 'pgrep -f "05_train\\.py.*${remoteDir.replace(/[^a-zA-Z0-9_/]/g, '')}" || stat -c %Y ${remoteDir}/train.log 2>/dev/null'`,
            { stdio: ['ignore', 'pipe', 'ignore'], timeout: 6000 }
        ).toString('utf8').trim();
        if (out) {
            const lastLine = out.split('\n').pop().trim();
            const n = parseInt(lastLine, 10);
            if (Number.isFinite(n)) {
                // train.log mtime — must be within last 5 min to count as live
                alive = (Date.now() / 1000 - n) < 300;
            } else {
                alive = true; // pgrep returned a pid
            }
        }
    } catch (e) {
        throw Object.assign(new Error('Could not reach CT 110: ' + e.message), { status: 502 });
    }
    if (!alive) throw Object.assign(new Error('No live training process or recent log activity on CT 110'), { status: 409 });
    meta.status = 'running';
    meta.remote_only = true;
    meta.pipeline_job_dir = remoteDir;
    meta.adopted_at = Date.now();
    meta.exit_code = null;
    meta.finished_at = null;
    saveJob(meta);
    return meta;
}

// Extract the pipeline job_dir path ("/tmp/voice-train/jobs/<id>/") from
// events.jsonl. The init_job.py tool_result and subsequent phase invocations
// all reference it. Returns null if not found.
function findPipelineJobDir(jobId) {
    const p = jobEventsPath(jobId);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    // Look for the init_job.py tool_result which prints {"job_id": "...", "job_dir": "..."}
    const initRe = /"job_dir":\s*"([^"]+)"/;
    for (const line of lines) {
        let evt; try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type !== 'user' || !evt.message || !Array.isArray(evt.message.content)) continue;
        for (const block of evt.message.content) {
            if (block.type !== 'tool_result') continue;
            const content = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : '';
            const m = initRe.exec(content);
            if (m) return m[1];
        }
    }
    // Fall back: any "/tmp/voice-train/jobs/<voice>_<timestamp>" reference
    const jobDirRe = /\/tmp\/voice-train\/jobs\/[a-z][a-z0-9_]+_\d+\/?/;
    for (const line of lines) {
        const m = jobDirRe.exec(line);
        if (m) return m[0].replace(/\/$/, '');
    }
    return null;
}

function resumeJob(jobId, opts = {}) {
    const prev = loadJob(jobId);
    if (!prev) throw Object.assign(new Error('Original job not found'), { status: 404 });
    if (prev.status === 'running') throw Object.assign(new Error('Job is still running; pause first'), { status: 409 });

    const pipelineJobDir = findPipelineJobDir(jobId);
    if (!pipelineJobDir) throw Object.assign(new Error('Could not locate pipeline job dir in events — resume impossible'), { status: 409 });

    // Optional schedule — same shape as startJob's run_after. Lets admins
    // queue a resume for later (e.g. "restart this one after the 2am batch
    // finishes") instead of firing immediately.
    let runAfter = Date.now();
    if (opts.run_after != null) {
        const rawN = typeof opts.run_after === 'number' ? opts.run_after : Date.parse(opts.run_after);
        if (Number.isFinite(rawN)) runAfter = Math.max(Date.now(), rawN);
    }

    const newJobId = `${prev.input.voice_id}_resume_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(JOBS_DIR, newJobId);
    ensureDir(dir);

    const resumePromptLines = [
        `RESUME voice training job at: \`${pipelineJobDir}\``,
        ``,
        `Voice: **${prev.input.name}** (voice_id: \`${prev.input.voice_id}\`)`,
        `Group: ${prev.input.group}, Gender: ${prev.input.gender}`,
        ``,
        `The pipeline job directory already exists with some phases completed — .done sentinels will cause any re-invocation of completed phases (01_download, 02_transcribe, 03_cluster, 04_extract) to exit immediately as skipped. You do NOT need to call init_job.py; the input.json is already written.`,
        ``,
        `Start by running phase 5 (05_train.py) with the **\`--resume\`** flag to continue from Applio's latest checkpoint:`,
        `    ssh ${TTS_HOST} "/opt/GPT-SoVITS/.venv/bin/python /opt/discord-soundboard/tts-server/tools/rvc_pipeline/phases/05_train.py --job-dir ${pipelineJobDir} --resume"`,
        ``,
        `Then run phase 6 (06_deploy.py --force) to regenerate benchmark audio and deploy.`,
        ``,
        `Report concise status. Do NOT flip skip_rvc — the human gate stays in their hands.`,
    ];

    const meta = {
        id: newJobId,
        input: prev.input,
        status: 'queued',
        pid: null,
        created_at: Date.now(),
        run_after: runAfter,
        started_at: null,
        finished_at: null,
        exit_code: null,
        resumed_from: jobId,
        pipeline_job_dir: pipelineJobDir,
        resume_prompt: resumePromptLines.join('\n'),
    };
    saveJob(meta);
    setImmediate(tickScheduler);
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
    // remote_only jobs (adopted orphans) intentionally have no live local pid;
    // the CT 110 pipeline drives them. Don't demote based on local pid here —
    // the scheduler tick is the only thing that should reap them, and only
    // when the train.done sentinel appears (handled separately).
    if (meta.status === 'running' && !meta.remote_only && meta.pid && !isPidAlive(meta.pid)) {
        // Detect orphaned status — the subprocess died but exit handler didn't fire
        // (e.g. parent process restarted). Mark as finished.
        meta.status = 'unknown_exit';
        meta.finished_at = Date.now();
        saveJob(meta);
    }
    return meta;
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// Cache for remote train.log tails so we don't SSH-poll CT 110 on every UI tick.
// Keyed by jobId → { at, text }. TTL is short — the UI typically polls every few
// seconds, and a 10 s window keeps the live epoch + ETA fresh enough for users
// without hammering the GPU container.
const _trainLogCache = new Map();
const TRAIN_LOG_CACHE_MS = 10_000;

function fetchRemoteTrainLog(jobId, remoteJobDir) {
    if (!remoteJobDir) return '';
    const cached = _trainLogCache.get(jobId);
    const now = Date.now();
    if (cached && (now - cached.at) < TRAIN_LOG_CACHE_MS && cached.dir === remoteJobDir) return cached.text;
    try {
        // Tail of train.log only; the file can be megabytes. Last 8 KB easily
        // contains the most recent `<voice> | epoch=N | ...` line.
        const text = _execSync(
            `ssh -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new ${TTS_HOST} 'tail -c 8192 ${remoteJobDir}/train.log 2>/dev/null'`,
            { stdio: ['ignore', 'pipe', 'ignore'], timeout: 6000, maxBuffer: 16384 }
        ).toString('utf8');
        _trainLogCache.set(jobId, { at: now, dir: remoteJobDir, text });
        return text;
    } catch {
        // Failure (network blip, file missing) is non-fatal — fall back to whatever
        // events-derived data we already have. Cache empty briefly to avoid
        // re-SSHing every tick when the host is unreachable.
        _trainLogCache.set(jobId, { at: now, dir: remoteJobDir, text: '' });
        return '';
    }
}

function computeProgress(jobId) {
    const p = jobEventsPath(jobId);
    if (!fs.existsSync(p)) return null;
    const meta = loadJob(jobId);
    if (!meta) return null;

    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    let currentPhase = null;
    const completedPhases = new Set();
    const phaseDurations = {};            // phase → duration_sec (from our structured status)
    let training = null;
    let trainPhaseStarted = false;        // only trust epoch= log lines after 05_train.py is invoked
    let remoteJobDir = null;              // pipeline job_dir on CT 110 (parsed from --job-dir arg)
    const voiceId = meta.input && meta.input.voice_id;

    // Our pipeline scripts emit structured JSON on stdout, which Bash tool_result content captures.
    // Match lines like: {"phase": "download", "status": "complete", "details": {... "duration_sec": 123.4}}
    const phaseCompleteRe = /\{"phase":\s*"([a-z_]+)",\s*"status":\s*"complete",\s*"details":\s*\{[^{}]*?"duration_sec":\s*([\d.]+)/g;
    // Per-epoch training log-line from Applio's stdout:
    // "<voice> | epoch=N | step=M | time=HH:MM:SS | training_speed=H:MM:SS | lowest_value=X.X (epoch..) | ... | smoothed_loss_gen=X.X | smoothed_loss_disc=X.X"
    // Scope to this job's voice_id prefix to avoid picking up stale data when the sub-agent greps old jobs.
    const voicePrefix = voiceId ? escapeRegex(voiceId) : '[a-z][a-z0-9_]*';
    const epochRe = new RegExp(voicePrefix + '\\s*\\|\\s*epoch=(\\d+)\\s*\\|\\s*step=(\\d+).*?training_speed=(\\d+):(\\d+):(\\d+).*?lowest_value=([\\d.]+).*?smoothed_loss_gen=([\\d.]+)', 'g');

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
                        const idx = PHASE_ORDER.indexOf(phase);
                        for (let i = 0; i < idx; i++) completedPhases.add(PHASE_ORDER[i]);
                        if (phase === 'train') {
                            trainPhaseStarted = true;
                            // Capture the pipeline job_dir so we can SSH-tail
                            // its train.log for live epoch progress when Claude
                            // is still blocked waiting on the train command.
                            const m = cmd.match(/--job-dir\s+(\S+?)(?=["'\s]|\\")/);
                            if (m) remoteJobDir = m[1];
                        }
                    }
                }
            }
        } else if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
            for (const block of evt.message.content) {
                if (block.type !== 'tool_result') continue;
                const content = typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : '';

                // Capture phase completion + duration
                phaseCompleteRe.lastIndex = 0;
                let pm;
                while ((pm = phaseCompleteRe.exec(content)) !== null) {
                    const [, phase, dur] = pm;
                    completedPhases.add(phase);
                    const d = parseFloat(dur);
                    if (Number.isFinite(d)) phaseDurations[phase] = d;
                }
                // Also catch `state/<phase>.done` filename hits as a weaker signal (no duration)
                for (const phase of PHASE_ORDER) {
                    if (content.includes(`${phase}.done`)) completedPhases.add(phase);
                }

                // Latest epoch line — only trust it if 05_train.py has actually been invoked
                // for THIS job (prevents stale values when the sub-agent greps other jobs).
                if (trainPhaseStarted) {
                    epochRe.lastIndex = 0;
                    let m, lastMatch = null;
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
    }

    // For adopted-orphan jobs there's no Claude tool_use in events.jsonl
    // (Claude died), so trainPhaseStarted + remoteJobDir won't be set from
    // event parsing. Fall back to meta.pipeline_job_dir + meta.remote_only.
    if (!remoteJobDir && meta.pipeline_job_dir) remoteJobDir = meta.pipeline_job_dir;
    if (!trainPhaseStarted && meta.remote_only === true) trainPhaseStarted = true;

    // Live tail: when training is running but Claude hasn't echoed an epoch line
    // back through tool_result yet (the bash call is still blocked), SSH to CT
    // 110 and tail train.log directly. This is also useful late in training when
    // the events-derived epoch is older than what's actually on disk.
    if (trainPhaseStarted && remoteJobDir && meta.status === 'running') {
        const tailText = fetchRemoteTrainLog(jobId, remoteJobDir);
        if (tailText) {
            const tailRe = new RegExp(epochRe.source, 'g');
            let m, lastMatch = null;
            while ((m = tailRe.exec(tailText)) !== null) lastMatch = m;
            if (lastMatch) {
                const [, ep, step, h, mm, ss, lowLoss, currLoss] = lastMatch;
                const liveEpoch = parseInt(ep, 10);
                if (!training || liveEpoch > training.current_epoch) {
                    training = {
                        current_epoch: liveEpoch,
                        current_step: parseInt(step, 10),
                        sec_per_epoch: (+h * 3600) + (+mm * 60) + (+ss),
                        lowest_loss: parseFloat(lowLoss),
                        current_loss: parseFloat(currLoss),
                        source: 'remote_tail',
                    };
                }
            }
        }
    }

    const totalEpochs = meta.input && meta.input.total_epoch ? meta.input.total_epoch : 200;
    if (training) {
        training.total_epochs = totalEpochs;
        training.eta_seconds = Math.max(0, (totalEpochs - training.current_epoch) * training.sec_per_epoch);
    }

    // Overall percentage: phase weights for completed + sub-progress for current
    let overallPct = 0;
    for (const phase of PHASE_ORDER) {
        if (completedPhases.has(phase)) overallPct += (PHASE_WEIGHTS[phase] || 0);
    }
    if (currentPhase && !completedPhases.has(currentPhase)) {
        let sub = 0;
        if (currentPhase === 'train' && training) sub = Math.min(1, training.current_epoch / totalEpochs);
        else sub = 0.5;  // mid-phase estimate for non-training (short)
        overallPct += (PHASE_WEIGHTS[currentPhase] || 0) * sub;
    }
    overallPct = Math.min(0.99, overallPct);

    // ETA — ONLY when we have real data (no lazy fallbacks)
    let overallEta = null;
    let etaSource = 'none';
    if (meta.status === 'running') {
        if (currentPhase === 'train' && training && training.sec_per_epoch > 0) {
            overallEta = training.eta_seconds + 60;  // + ~1 min for deploy
            etaSource = 'live_training';
        }
        // If not in training yet, we deliberately leave overallEta = null; UI shows "—"
    } else if (meta.status === 'completed') {
        overallPct = 1;
        overallEta = 0;
        etaSource = 'done';
        PHASE_ORDER.forEach(p => completedPhases.add(p));
    }

    // Elapsed so far (sum of per-phase durations we've captured)
    const elapsedSec = Object.values(phaseDurations).reduce((a, b) => a + b, 0);

    return {
        current_phase: currentPhase,
        phase_index: currentPhase ? PHASE_ORDER.indexOf(currentPhase) : null,
        completed_phases: Array.from(completedPhases).sort((a, b) => PHASE_ORDER.indexOf(a) - PHASE_ORDER.indexOf(b)),
        phase_durations: phaseDurations,            // per-phase seconds, as completed
        elapsed_recorded_sec: Math.round(elapsedSec),
        training,
        overall_percentage: Math.round(overallPct * 100),
        overall_eta_seconds: overallEta,            // null when unknown (no fallback)
        eta_source: etaSource,                      // 'none' | 'live_training' | 'done'
    };
}

module.exports = {
    JOBS_DIR,
    listJobs,
    startJob,
    cancelJob,
    resumeJob,
    adoptOrphan,
    findPipelineJobDir,
    getJobStatus,
    getJobEvents,
    computeProgress,
    startScheduler,
    tickScheduler,
};
