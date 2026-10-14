const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    entersState,
    AudioPlayerStatus,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');


const execFileAsync = promisify(execFile);
const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
const ffmpegPath = path.join(__dirname, 'ffmpeg.exe');
const cookiesPath = path.join(__dirname, 'cookies.txt');

const MAX_QUEUE = 50;

// Pin prism-media to the ffmpeg.exe shipped next to the bot instead of whatever is on PATH
if (fs.existsSync(ffmpegPath)) {
    process.env.FFMPEG_PATH = ffmpegPath;
}

// Load DISCORD_TOKEN from .env so the token is not hardcoded in this file
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
        if (line.trim().startsWith('#')) continue;
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
        if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
}
loadEnv();

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    console.error('No DISCORD_TOKEN found. Put it in a .env file next to bot.js:');
    console.error('   DISCORD_TOKEN=your-token-here');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
        // Windows can hold a lock briefly after the stream closes, so retry once
        setTimeout(() => {
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
        }, 2000);
    }
}

// Match on the trailing dot so temp_5_1 never collides with temp_5_11
function findTempFile(tempId) {
    const name = fs.readdirSync(__dirname).find(f => f.startsWith(`temp_${tempId}.`));
    return name ? path.join(__dirname, name) : null;
}

function cleanupTempId(tempId) {
    for (const file of fs.readdirSync(__dirname)) {
        if (file.startsWith(`temp_${tempId}.`)) safeUnlink(path.join(__dirname, file));
    }
}

function cleanupAllTemp() {
    for (const file of fs.readdirSync(__dirname)) {
        if (file.startsWith('temp_')) safeUnlink(path.join(__dirname, file));
    }
}

// Remove temp files left behind by a previous crash
cleanupAllTemp();

function truncate(text, max = 60) {
    const clean = String(text || '').replace(/`/g, "'");
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

// ---------------------------------------------------------------------------
// yt-dlp: self-updating wrapper with a fallback ladder
//
// YouTube changes constantly and a stale yt-dlp is the single most common cause
// of this bot breaking. So: run it with a JS runtime (Node, which we already
// have), keep it updated automatically, and retry failures along a ladder
// before giving up.
// ---------------------------------------------------------------------------

const UPDATE_STAMP = path.join(__dirname, '.ytdlp-last-update');
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;  // don't hammer GitHub on restart loops
const DAILY_MS = 24 * 60 * 60 * 1000;

// --js-runtimes node: yt-dlp needs a JS runtime to solve YouTube's signature
// challenges. Without one it silently loses most formats and eventually fails.
const BASE_ARGS = [
    '--js-runtimes', 'node',
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--retries', '3',
    '--fragment-retries', '3',
    '--socket-timeout', '20'
];

function cookieArgs(useCookies) {
    return (useCookies && fs.existsSync(cookiesPath)) ? ['--cookies', cookiesPath] : [];
}

function runYtDlp(args, timeoutMs = 240000) {
    return execFileAsync(ytDlpPath, args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
    });
}

// yt-dlp mixes status lines ("[youtube] Extracting URL: ...") into stdout.
// Everything we ask for via --print is a plain line, so drop the bracketed ones.
function lastPrinted(stdout) {
    const lines = (stdout || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .filter(l => !l.startsWith('['));
    return lines.length ? lines[lines.length - 1] : null;
}

function firstLine(error) {
    const msg = (error && (error.stderr || error.message)) || String(error);
    return msg.split('\n').map(l => l.trim()).filter(Boolean)[0] || 'unknown error';
}

// Errors that usually mean "yt-dlp is out of date" rather than "bad video"
const STALE_SIGNS = [
    'requested format is not available',
    'unable to extract',
    'failed to extract',
    'no video formats found',
    'sign in to confirm',
    'please sign in',
    'nsig',
    'player response',
    'unsupported client',
    'precondition check failed'
];

function looksStale(error) {
    const msg = ((error && (error.stderr || error.message)) || '').toLowerCase();
    return STALE_SIGNS.some(sign => msg.includes(sign));
}

function lastUpdateAt() {
    try { return Number(fs.readFileSync(UPDATE_STAMP, 'utf-8').trim()) || 0; } catch { return 0; }
}

let updatePromise = null;

function updateYtDlp(reason, { force = false } = {}) {
    if (updatePromise) return updatePromise;
    if (!force && Date.now() - lastUpdateAt() < UPDATE_INTERVAL_MS) {
        return Promise.resolve(false);
    }

    updatePromise = (async () => {
        console.log(`[yt-dlp] Checking for updates (${reason})...`);
        try {
            const { stdout } = await runYtDlp(['-U'], 240000);
            const summary = (stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
            console.log('[yt-dlp]', summary || 'update check finished');
            try { fs.writeFileSync(UPDATE_STAMP, String(Date.now())); } catch {}
            return true;
        } catch (error) {
            console.error('[yt-dlp] Update failed:', firstLine(error));
            return false;
        }
    })().finally(() => { updatePromise = null; });

    return updatePromise;
}

/**
 * Run yt-dlp along a fallback ladder:
 *   1. with cookies
 *   2. without cookies  (covers an expired/poisoned cookies.txt)
 *   3. force a yt-dlp update, then retry with cookies
 * `buildArgs(useCookies)` returns the full arg list for one attempt.
 */
async function ytDlpWithFallback(buildArgs, { onAttemptFail } = {}) {
    const attempts = [
        { label: 'cookies', useCookies: true, updateFirst: false },
        { label: 'no cookies', useCookies: false, updateFirst: false },
        { label: 'after yt-dlp update', useCookies: true, updateFirst: true }
    ];

    let lastError = null;

    for (const attempt of attempts) {
        if (attempt.updateFirst) {
            // Only burn time on an update if the failure actually smells like staleness
            if (!looksStale(lastError)) break;
            const updated = await updateYtDlp('download failure', { force: true });
            if (!updated) break;
        }

        try {
            const result = await runYtDlp(buildArgs(attempt.useCookies));
            if (attempt.label !== 'cookies') {
                console.warn(`[yt-dlp] Recovered using fallback: ${attempt.label}`);
            }
            return result;
        } catch (error) {
            lastError = error;
            console.warn(`[yt-dlp] Attempt "${attempt.label}" failed: ${firstLine(error)}`);
            if (onAttemptFail) onAttemptFail();
        }
    }

    throw lastError || new Error('yt-dlp failed');
}

async function searchYouTube(query) {
    const { stdout } = await ytDlpWithFallback(useCookies => [
        ...BASE_ARGS,
        ...cookieArgs(useCookies),
        '--print', '%(webpage_url)s|||%(title)s',
        `ytsearch1:${query}`
    ]);

    const line = lastPrinted(stdout);
    if (!line || !line.includes('|||')) return null;

    const sep = line.indexOf('|||');
    return { url: line.slice(0, sep), title: line.slice(sep + 3) };
}

// Downloads the audio and returns { tempPath, title } in a single yt-dlp call.
async function downloadAudio(url, tempId) {
    const outTemplate = path.join(__dirname, `temp_${tempId}.%(ext)s`);

    const { stdout } = await ytDlpWithFallback(
        useCookies => [
            ...BASE_ARGS,
            ...cookieArgs(useCookies),
            // bestaudio/best: when YouTube returns no audio-only stream, fall back to a
            // combined format instead of failing with "Requested format is not available".
            // ffmpeg strips the video track when the resource is played.
            '--format', 'bestaudio/best',
            '--print', 'after_move:%(title)s',
            '-o', outTemplate,
            url
        ],
        { onAttemptFail: () => cleanupTempId(tempId) }
    );

    const tempPath = findTempFile(tempId);
    if (!tempPath) throw new Error('yt-dlp reported success but no file was written');

    return { tempPath, title: lastPrinted(stdout) || 'Unknown title' };
}

function friendlyError(error) {
    const msg = ((error && (error.stderr || error.message)) || '').toLowerCase();
    if (error && error.killed) return '❌ That took too long and timed out. Try again.';
    if (msg.includes('sign in') || msg.includes('confirm you')) {
        return '❌ YouTube is demanding sign-in — `cookies.txt` has likely expired. Re-export your YouTube cookies.';
    }
    if (msg.includes('video unavailable') || msg.includes('private video')) return '❌ That video is unavailable or private.';
    if (msg.includes('format is not available')) return '❌ No playable audio format found for that video.';
    if (msg.includes('did not enter state')) return '❌ Could not connect to the voice channel (timed out). Try again.';
    if (msg.includes('no results')) return '❌ No results found!';
    return '❌ Error playing song! Check console for details.';
}

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const player = createAudioPlayer();

// ---------------------------------------------------------------------------
// Queue
//
// A slot is reserved in `queue` synchronously when the !play command arrives, so
// playback order always matches command order. Downloads then run one at a time
// off `downloadChain` and fill in their reserved slot. The previous version
// decided queue position when the *download finished*, so a short second song
// would overtake a longer first one.
//
// Only pump() ever calls player.play(), and it never awaits between checking the
// player state and playing, so two finished downloads can't both start playback.
// ---------------------------------------------------------------------------

const queue = [];              // reserved slots, in command order; [0] is next up
let nowPlaying = null;         // the entry currently playing
let downloadChain = Promise.resolve();
let entrySeq = 0;
let generation = 0;            // bumped by !stop / !leave to discard in-flight downloads

function discard(entry) {
    if (entry.tempPath) safeUnlink(entry.tempPath);
    else if (entry.tempId) cleanupTempId(entry.tempId);
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
}

function pump() {
    if (player.state.status !== AudioPlayerStatus.Idle) return;

    // Drop anything that failed to download at the head of the queue
    while (queue.length && queue[0].status === 'failed') queue.shift();

    const head = queue[0];
    if (!head) {
        nowPlaying = null;
        return;
    }
    // Head is still downloading - pump() is called again when it lands, which
    // is what keeps a later-but-faster download from jumping the line.
    if (head.status !== 'ready') return;

    queue.shift();
    nowPlaying = head;

    const resource = createAudioResource(head.tempPath);
    player.play(resource);
    head.channel.send(`🎵 Now playing: **${head.title}**`);
    console.log('Playing:', head.title);
}

async function processEntry(entry) {
    if (entry.generation !== generation) return discard(entry);

    try {
        await ensureConnection(entry.voiceChannel);

        let url = entry.query;
        let title = null;

        if (!(url.includes('youtube.com') || url.includes('youtu.be'))) {
            const found = await searchYouTube(entry.query);
            if (!found) throw new Error('No results');
            url = found.url;
            title = found.title;
        }

        console.log('Downloading audio for:', url);

        entry.tempId = `${Date.now()}_${entry.id}`;
        const downloaded = await downloadAudio(url, entry.tempId);

        entry.tempPath = downloaded.tempPath;
        entry.title = title || downloaded.title;
        entry.status = 'ready';

        // Cleared while we were downloading
        if (entry.generation !== generation) return discard(entry);

        // Announce queueing only if it isn't about to start playing right now
        const playsImmediately = player.state.status === AudioPlayerStatus.Idle && queue[0] === entry;
        if (!playsImmediately) {
            const position = queue.indexOf(entry) + 1;
            entry.channel.send(`📋 Added to queue (#${position}): **${entry.title}**`);
        }
    } catch (error) {
        console.error(error);
        entry.status = 'failed';
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        if (entry.tempId) cleanupTempId(entry.tempId);
        entry.channel.send(`${friendlyError(error)} (\`${truncate(entry.query)}\`)`);
    }

    pump();
}

function enqueue(query, message, voiceChannel) {
    const entry = {
        id: ++entrySeq,
        query,
        title: null,
        tempPath: null,
        tempId: null,
        status: 'pending',
        channel: message.channel,
        requestedBy: message.author.username,
        voiceChannel,
        generation
    };

    // Reserving the slot here - synchronously, in command order - is the fix
    queue.push(entry);

    // Serialize downloads so they also complete in order
    downloadChain = downloadChain
        .then(() => processEntry(entry))
        .catch(error => console.error('Download chain error:', error));

    return entry;
}

function clearQueue() {
    generation++;
    for (const entry of queue) {
        if (entry.tempPath) safeUnlink(entry.tempPath);
        else if (entry.tempId) cleanupTempId(entry.tempId);
    }
    queue.length = 0;
}

function attachConnectionHandlers(conn) {
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
        // Could be a move between channels or a real drop, so give it a moment to recover
        try {
            await Promise.race([
                entersState(conn, VoiceConnectionStatus.Signalling, 5000),
                entersState(conn, VoiceConnectionStatus.Connecting, 5000)
            ]);
            console.log('Voice connection is recovering...');
        } catch {
            console.log('Voice connection lost - cleaning up so the next !play can rejoin');
            try { conn.destroy(); } catch {}
        }
    });

    conn.on(VoiceConnectionStatus.Destroyed, () => {
        console.log('Voice connection destroyed');
    });

    conn.on('error', error => {
        console.error('Voice connection error:', error);
    });
}

// Always resolve a live, Ready connection for the requester's channel. The old code
// cached the connection in a variable and only joined `if (!connection)`, so once the
// bot was disconnected it never rejoined until the process was restarted.
async function ensureConnection(channel) {
    let conn = getVoiceConnection(channel.guild.id);

    if (!conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
        conn = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        attachConnectionHandlers(conn);
        conn.subscribe(player);
        console.log('Joining voice channel:', channel.name);
    } else if (conn.joinConfig.channelId !== channel.id) {
        // Follow the requester into their channel instead of silently staying put
        conn.rejoin({ channelId: channel.id, selfDeaf: false, selfMute: false });
        console.log('Moving to voice channel:', channel.name);
    }

    await entersState(conn, VoiceConnectionStatus.Ready, 20000);
    return conn;
}

player.on(AudioPlayerStatus.Idle, () => {
    console.log('Song finished');
    if (nowPlaying) {
        safeUnlink(nowPlaying.tempPath);
        nowPlaying = null;
    }
    pump();
});

player.on(AudioPlayerStatus.Playing, () => {
    console.log('Started playing!');
});

player.on(AudioPlayerStatus.Paused, () => {
    console.log('Paused');
});

player.on('error', error => {
    // Don't let one bad file stall the queue - Idle fires next and pump() moves on
    console.error('Audio player error:', error);
});

client.on('clientReady', () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    console.log(`In ${client.guilds.cache.size} server(s): ${client.guilds.cache.map(g => g.name).join(', ') || 'none'}`);

    // Keep yt-dlp fresh without anyone having to remember to do it
    updateYtDlp('startup');
    setInterval(() => updateYtDlp('daily check'), DAILY_MS);
});

client.on('error', error => console.error('Discord client error:', error));
client.on('shardError', error => console.error('Discord shard error:', error));

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Play command
    if (message.content.startsWith('!play ')) {
        const query = message.content.slice(6).trim();
        if (!query) return message.reply('❌ Give me something to play!');

        const channel = message.member.voice.channel;
        if (!channel) {
            return message.reply('❌ You need to be in a voice channel!');
        }

        const me = await message.guild.members.fetchMe();
        const perms = channel.permissionsFor(me);
        if (!perms.has('Connect') || !perms.has('Speak')) {
            return message.reply(`❌ I don't have permission to connect and speak in **${channel.name}**!`);
        }

        if (queue.length >= MAX_QUEUE) {
            return message.reply(`❌ Queue is full (${MAX_QUEUE} tracks).`);
        }

        const entry = enqueue(query, message, channel);
        const position = queue.indexOf(entry) + 1;

        if (nowPlaying || position > 1) {
            message.reply(`🔍 Loading **${truncate(query)}** — queued at #${position}...`);
        } else {
            message.reply('🔍 Loading...');
        }
    }

    // Now playing command
    if (message.content === '!nowplaying' || message.content === '!np') {
        if (nowPlaying) {
            message.reply(`🎵 Currently playing: **${nowPlaying.title}**`);
        } else {
            message.reply('❌ Nothing is playing right now!');
        }
    }

    // Skip command
    if (message.content === '!skip') {
        if (nowPlaying) {
            message.reply(`⏭️ Skipping: **${nowPlaying.title}**`);
            player.stop(); // triggers Idle → pump()
        } else {
            message.reply('❌ Nothing is playing right now!');
        }
    }

    // Queue command
    if (message.content === '!queue') {
        if (!nowPlaying && queue.length === 0) {
            return message.reply('❌ Queue is empty!');
        }
        let msg = '';
        if (nowPlaying) msg += `🎵 Now playing: **${nowPlaying.title}**\n`;
        if (queue.length > 0) {
            msg += '\n📋 Up next:\n';
            queue.forEach((entry, i) => {
                const label = entry.status === 'ready'
                    ? entry.title
                    : `${truncate(entry.title || entry.query)} _(loading…)_`;
                msg += `${i + 1}. ${label}\n`;
            });
        } else {
            msg += '\nNo songs in queue.';
        }
        message.reply(msg);
    }

    // Stop command
    if (message.content === '!stop') {
        clearQueue();
        player.stop();
        if (nowPlaying) {
            safeUnlink(nowPlaying.tempPath);
            nowPlaying = null;
        }
        message.reply('⏹️ Stopped and cleared queue!');
    }

    // Leave command
    if (message.content === '!leave') {
        const conn = getVoiceConnection(message.guild.id);
        clearQueue();
        player.stop();
        if (nowPlaying) {
            safeUnlink(nowPlaying.tempPath);
            nowPlaying = null;
        }

        if (conn) {
            try { conn.destroy(); } catch {}
            message.reply('👋 Left voice channel!');
        } else {
            message.reply('❌ I am not in a voice channel!');
        }
    }

    // Force a yt-dlp update from Discord, no shell access needed
    if (message.content === '!update') {
        await message.reply('⬇️ Updating yt-dlp...');
        const before = await runYtDlp(['--version'], 30000).then(r => r.stdout.trim()).catch(() => 'unknown');
        await updateYtDlp('manual !update', { force: true });
        const after = await runYtDlp(['--version'], 30000).then(r => r.stdout.trim()).catch(() => 'unknown');
        message.channel.send(before === after
            ? `✅ yt-dlp already up to date (\`${after}\`)`
            : `✅ yt-dlp updated: \`${before}\` → \`${after}\``);
    }

    // Quick health readout
    if (message.content === '!status') {
        const version = await runYtDlp(['--version'], 30000).then(r => r.stdout.trim()).catch(() => 'unavailable');
        const cookieAge = fs.existsSync(cookiesPath)
            ? `${Math.floor((Date.now() - fs.statSync(cookiesPath).mtimeMs) / 86400000)}d old`
            : 'missing';
        const conn = getVoiceConnection(message.guild.id);
        message.reply(
            `**Status**\n` +
            `yt-dlp: \`${version}\`\n` +
            `cookies.txt: \`${cookieAge}\`\n` +
            `voice: \`${conn ? conn.state.status : 'not connected'}\`\n` +
            `queue: \`${queue.length}\` | now playing: \`${nowPlaying ? nowPlaying.title : 'nothing'}\``
        );
    }
});

// ---------------------------------------------------------------------------
// Keep the process alive through unexpected errors, and clean up on exit
// ---------------------------------------------------------------------------

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection (bot stays up):', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception (bot stays up):', error);
});

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down, cleaning up temp files...');
    try {
        clearQueue();
        player.stop();
        if (nowPlaying) safeUnlink(nowPlaying.tempPath);
    } catch {}
    try { cleanupAllTemp(); } catch {}
    client.destroy().catch(() => {});
    setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(TOKEN);
