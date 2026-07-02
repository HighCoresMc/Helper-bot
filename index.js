const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Config
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOGGING_CHANNEL_ID = process.env.LOGGING_CHANNEL_ID;
const TICKETS_FILE = path.join(__dirname, './tickets.js');
const TRANSCRIPTS_FOLDER = path.join(__dirname, './transcripts');
const TICKET_CATEGORY_ID = '1487143174567628840';

// MC Status
const MC_STATUS_CHANNEL_ID = process.env.MC_STATUS_CHANNEL_ID || '1487139736748425236';
const MC_STATUS_MESSAGE_ID = process.env.MC_STATUS_MESSAGE_ID || '1508162784339165376';
const MC_LOGS_CHANNEL_ID = process.env.MC_LOGS_CHANNEL_ID || '1487148944667578368';
const MC_SERVER_IP = process.env.MC_SERVER_IP || '198.186.130.122:25577';

// GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH = 'tickets.js';

// Discord Stats
const DC_STATS_CHANNEL_ID = '1495819247685996844';
const DC_STATS_MESSAGE_ID = process.env.DC_STATS_MESSAGE_ID || 'your_dc_status_msg_id';

// Transcripts Folder
if (!fs.existsSync(TRANSCRIPTS_FOLDER)) {
    fs.mkdirSync(TRANSCRIPTS_FOLDER, { recursive: true });
    console.log('📁 Created transcripts folder');
}

// Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
    ]
});

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GUILD_ID = process.env.GUILD_ID;

// Roles
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '1487195816220430406';

// Online Admins
var _onlineUpdateTimer = null;

function scheduleOnlineUpdate(delay = 5000) {
    clearTimeout(_onlineUpdateTimer);
    _onlineUpdateTimer = setTimeout(updateOnlineAdmins, delay);
}

async function updateOnlineAdmins() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;

        const seen = new Set();
        const onlineStaff = guild.members.cache.filter(member => {
            if (seen.has(member.id)) return false;
            const isStaff = member.roles.cache.has(STAFF_ROLE_ID);
            const isOnline = member.presence && ['online', 'dnd', 'idle'].includes(member.presence.status);
            if (isStaff && isOnline) { seen.add(member.id); return true; }
            return false;
        });

        const count = onlineStaff.size;
        const names = onlineStaff.map(m => m.displayName).join(', ');

        console.log('👥 Online Staff:', count, names ? '(' + names + ')' : '(none)');

        console.log('🔄 Sending to Supabase... URL:', SUPABASE_URL ? 'OK' : 'MISSING', 'KEY:', SUPABASE_KEY ? 'OK' : 'MISSING');
        if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('❌ SUPABASE_URL or SUPABASE_KEY missing!'); return; }

        const valueJson = JSON.stringify({ count, names, updated: new Date().toISOString() });
        const patchPayload = JSON.stringify({ value: valueJson });
        const https2 = require('https');
        const urlObj = new URL(SUPABASE_URL + '/rest/v1/settings');

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + '?key=eq.admin_online',
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Content-Length': Buffer.byteLength(patchPayload)
            }
        };

        await new Promise((resolve, reject) => {
            const req = https2.request(options, res => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        console.error('Supabase error:', res.statusCode, body);
                    } else {
                        console.log('✅ Supabase updated — online:', count);
                    }
                    resolve();
                });
            });
            req.on('error', reject);
            req.write(patchPayload);
            req.end();
        });

    } catch (err) {
        console.error('❌ updateOnlineAdmins error:', err.message);
    }
}

// Tickets — Load
function loadTickets() {
    if (fs.existsSync(TICKETS_FILE)) {
        const data = fs.readFileSync(TICKETS_FILE, 'utf8');
        const match = data.match(/window\.ticketsData\s*=\s*(\[[\s\S]*\]);/);
        if (match) {
            return JSON.parse(match[1]);
        }
    }
    return [];
}

// Tickets — Save
function saveTickets(tickets) {
    const jsContent = `// Tickets Data\nwindow.ticketsData = ${JSON.stringify(tickets, null, 2)};\n`;
    fs.writeFileSync(TICKETS_FILE, jsContent, 'utf8');
    console.log('✅ Saved tickets.js');
    return jsContent;
}

// GitHub — API Request
function githubApiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.github.com',
            path,
            method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'Ticket-Bot',
                'Accept': 'application/vnd.github.v3+json',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// GitHub — Multi-File Commit
async function uploadFilesToGitHub(files, commitMessage) {
    try {
        console.log(`📤 Uploading ${files.length} file(s) to GitHub in one commit...`);

        const base = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

        const refRes = await githubApiRequest('GET', `${base}/git/ref/heads/main`);
        if (refRes.status !== 200) throw new Error('Failed to get ref: ' + JSON.stringify(refRes.body));
        const latestCommitSha = refRes.body.object.sha;

        const commitRes = await githubApiRequest('GET', `${base}/git/commits/${latestCommitSha}`);
        if (commitRes.status !== 200) throw new Error('Failed to get commit: ' + JSON.stringify(commitRes.body));
        const baseTreeSha = commitRes.body.tree.sha;

        const treeItems = [];
        for (const file of files) {
            const blobRes = await githubApiRequest('POST', `${base}/git/blobs`, {
                content: Buffer.from(file.content).toString('base64'),
                encoding: 'base64'
            });
            if (blobRes.status !== 201) throw new Error(`Failed to create blob for ${file.path}: ` + JSON.stringify(blobRes.body));
            treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blobRes.body.sha });
        }

        const newTreeRes = await githubApiRequest('POST', `${base}/git/trees`, { base_tree: baseTreeSha, tree: treeItems });
        if (newTreeRes.status !== 201) throw new Error('Failed to create tree: ' + JSON.stringify(newTreeRes.body));

        const newCommitRes = await githubApiRequest('POST', `${base}/git/commits`, {
            message: commitMessage,
            tree: newTreeRes.body.sha,
            parents: [latestCommitSha]
        });
        if (newCommitRes.status !== 201) throw new Error('Failed to create commit: ' + JSON.stringify(newCommitRes.body));

        const updateRefRes = await githubApiRequest('PATCH', `${base}/git/refs/heads/main`, { sha: newCommitRes.body.sha });
        if (updateRefRes.status !== 200) throw new Error('Failed to update ref: ' + JSON.stringify(updateRefRes.body));

        console.log(`✅ Uploaded ${files.length} file(s) to GitHub successfully!`);
        console.log('🌐 Site will auto-update within a minute!');
        return true;
    } catch (error) {
        console.error('❌ uploadFilesToGitHub error:', error.message);
        return false;
    }
}

// GitHub — Legacy Stub
async function uploadTranscriptToGitHub() { }

// Helpers — Download File
function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const options = url.startsWith('https') ? { rejectUnauthorized: false } : {};

        const file = fs.createWriteStream(filepath);
        protocol.get(url, options, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(filepath);
            });
        }).on('error', (err) => {
            fs.unlink(filepath, () => { });
            reject(err);
        });
    });
}

// Helpers — Fetch HTML
function fetchHtmlFromUrl(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const options = url.startsWith('https') ? { rejectUnauthorized: false } : {};
        protocol.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(data);
                } else {
                    reject(new Error(res.statusCode));
                }
            });
        }).on('error', reject);
    });
}

// Helpers — Extract Ticket Opener ID from first message mention
function extractTicketOpenerId(transcriptContent) {
    const mentionRegex = /<@!?(\d{17,19})>/;
    const match = transcriptContent.match(mentionRegex);
    if (match) return match[1];

    // Fallback: look for mention class
    const spanMatch = transcriptContent.match(/title="[^"]*\(ID:\s*(\d{17,19})\)"/);
    if (spanMatch) return spanMatch[1];

    return null;
}

// Helpers — Extract Handler From Transcript
function extractHandlerFromTranscript(transcriptContent, ticketOwnerUsername) {
    const botNames = ['highcore mc', 'highcoremc', 'high core mc'];
    const seenIds = new Set();
    const handlers = [];

    // Try extracting by data-user-id first (more accurate)
    const idRegex = /data-user-id=['"](\d{17,19})['"][^>]*>([^<]+)</g;
    let m;
    while ((m = idRegex.exec(transcriptContent)) !== null) {
        const id = m[1];
        const name = m[2].trim();

        if (seenIds.has(id)) continue;
        seenIds.add(id);

        if (botNames.some(b => name.toLowerCase().includes(b))) continue;
        if (ticketOwnerUsername && name.toLowerCase() === ticketOwnerUsername.toLowerCase()) continue;

        handlers.push(id); // Prefer returning ID directly
    }

    // Fallback to name if data-user-id not found
    const seenNames = new Set();
    const nameHandlers = [];
    const nameRegex = /class=['"](?:author|uname)['"][^>]*>([^<]+)</g; // Added author for new transcript format
    while ((m = nameRegex.exec(transcriptContent)) !== null) {
        const name = m[1].trim();
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        if (botNames.some(b => name.toLowerCase().includes(b))) continue;
        if (ticketOwnerUsername && name.toLowerCase() === ticketOwnerUsername.toLowerCase()) continue;
        nameHandlers.push(name);
    }

    // Return array of all possible handlers (IDs first, then names)
    return [...handlers, ...nameHandlers];
}

// Helpers — Extract Opened At From Transcript
function extractTicketOpenedAt(transcriptContent) {
    const m = transcriptContent.match(/Opened At<\/div>\s*<div[^>]*>([^<]+)</);
    if (!m) return null;
    const raw = m[1].trim().replace('\u00b7', '').replace(/\s+/g, ' ').trim();
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return null;
    return new Date(parsed.getTime() - 3 * 60 * 60 * 1000).toISOString();
}

// Helpers — Extract Ticket Type From Transcript
function extractTicketType(transcriptContent) {
    if (!transcriptContent) return null;
    const m = transcriptContent.match(/Type<\/div>\s*<div[^>]*>(?:<[^>]+>)*([^<]+)</i);
    if (m && m[1]) {
        const type = m[1].trim().toUpperCase();
        // Ignore if it accidentally matched something super long or weird
        if (type.length > 1 && type.length < 20) return type;
    }
    return null;
}

// Helpers — Extract Opened By Username From Transcript
function extractOpenedByUsername(transcriptContent) {
    const m = transcriptContent.match(/Opened By<\/div>\s*<div[^>]*>([^<]+)</);
    return m ? m[1].trim() : null;
}

// Helpers — Format Response Time
function formatResponseTime(openedAtISO) {
    if (!openedAtISO) return 'N/A';
    const diffMs = Date.now() - new Date(openedAtISO).getTime();
    if (diffMs < 0) return 'N/A';
    const totalMins = Math.floor(diffMs / 60000);
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// Helpers — Resolve Display Name to Discord ID via Guild
async function resolveDisplayNameToDiscordId(displayName) {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return null;
        const clean = displayName.replace(/^@/, '').trim().toLowerCase();
        const member = guild.members.cache.find(m =>
            m.displayName.toLowerCase() === clean ||
            m.user.username.toLowerCase() === clean ||
            m.displayName.toLowerCase().includes(clean) ||
            clean.includes(m.displayName.toLowerCase())
        );
        return member ? member.id : null;
    } catch (e) {
        return null;
    }
}

// Supabase — Lookup Employee
async function lookupEmployee(identifier) {
    const isDiscordId = /^\d{15,22}$/.test(identifier);
    let empPath = isDiscordId
        ? '/rest/v1/employees?discord_id=eq.' + identifier
        : '/rest/v1/employees?name=ilike.' + encodeURIComponent(identifier.replace(/^@/, '').trim());
    const empUrl = new URL(SUPABASE_URL + empPath);
    return new Promise((resolve) => {
        const options = {
            hostname: empUrl.hostname,
            path: empUrl.pathname + empUrl.search,
            method: 'GET',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        };
        const req = https.request(options, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve([]); } });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}

function extractTextFromTranscript(html) {
    // Remove scripts and styles
    let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    clean = clean.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    // Strip HTML tags
    clean = clean.replace(/<[^>]+>/g, '\n');
    // Decode basic entities
    clean = clean.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    // Remove excessive newlines
    clean = clean.replace(/\n\s*\n/g, '\n').trim();
    // Truncate to avoid too large payloads (optional)
    if (clean.length > 30000) clean = clean.substring(0, 30000);
    return clean;
}

// AI Analysis function
async function analyzeTicketWithAI(transcriptHtml, handlerName) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("⚠️ GEMINI_API_KEY is not set in .env. Defaulting to 5 points.");
        return { totalPoints: 5, breakdown: { error: "No API Key" }, reasoning: "API key missing" };
    }

    try {
        const transcriptText = extractTextFromTranscript(transcriptHtml);
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        const prompt = `
You are an expert AI evaluating a Discord admin's performance in a support ticket.
The admin's name is "${handlerName}".
Read the following transcript and calculate their points based ONLY on these rules:

1. Ticket Type (ID 20):
- Claiming the ticket (default) = +2 pts
- Whitelist ticket handled professionally/perfectly = +5 pts
- Support ticket handled professionally = +7 pts
- Team ticket handled professionally & fast = +10 pts
- Complaint ticket handled professionally = +4 pts
(Pick the ONE best fit for the overall ticket type and handling quality)

2. Responses (ID 21):
- Official/formal response = +2 pts
- Helpful and explanatory response = +3 pts
- Trolling or unhelpful response = -4 pts
(Pick the ONE best fit based on their replies)

3. Ticket Level/Speed (ID 22):
- Handled easy ticket in < 10 mins = +4 pts
- Handled hard ticket in < 10 mins = +8 pts
- Handled ticket (general) in < 30 mins = +2 pts
- Handled any ticket > 1 hour = -4 pts
(Pick the ONE best fit. Guess the speed/difficulty based on the conversation if timestamps aren't fully clear).

Return ONLY a JSON object with this exact structure:
{
  "ticket_type_points": 0,
  "responses_points": 0,
  "level_speed_points": 0,
  "total_points": 0,
  "reasoning": "Short explanation of why these points were awarded"
}

Transcript:
${transcriptText.substring(0, 30000)} // Limit length to avoid token issues
`;

        let responseText = null;
        const modelsToTry = [
            "gemini-2.5-flash",
            "gemini-2.5-flash-8b",
            "gemini-1.5-flash"
        ];

        for (const modelName of modelsToTry) {
            try {
                const currentModel = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } });
                const result = await currentModel.generateContent(prompt);
                responseText = result.response.text();
                break; // Success! Break out of the loop
            } catch (e) {
                console.log(`⚠️ Failed with ${modelName}: ${e.message}`);
            }
        }

        if (!responseText) {
            console.log("❌ All Gemini models failed.");
            return { totalPoints: 5, breakdown: { error: "All models failed" }, reasoning: "AI Error: All models failed" };
        }

        // Clean up response if it contains markdown (like ```json ... ```)
        let response = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();

        const json = JSON.parse(response);

        // Sum points safely just in case AI didn't
        const total = (json.ticket_type_points || 0) + (json.responses_points || 0) + (json.level_speed_points || 0);
        json.total_points = total;

        return {
            totalPoints: total || 5, // Fallback to 5 if 0 or error
            breakdown: json,
            reasoning: json.reasoning || "Analyzed successfully"
        };
    } catch (e) {
        console.error("❌ AI Analysis failed:", e.message);
        return { totalPoints: 5, breakdown: { error: e.message }, reasoning: "AI Error: " + e.message };
    }
}

// Supabase — Save Ticket
async function saveTicketToSupabase(ticketData) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        let empId = null;
        let empPoints = 0;
        let empDcPoints = 0;
        let empTickets = 0;
        let empName = 'Unassigned';
        let resolvedClaimedBy = null;
        let emp = null;

        // Collect all possible handlers
        let possibleHandlers = [];
        if (ticketData.handlerUsername) {
            if (Array.isArray(ticketData.handlerUsername)) {
                possibleHandlers.push(...ticketData.handlerUsername);
            } else {
                possibleHandlers.push(ticketData.handlerUsername);
            }
        }
        if (ticketData.claimedBy) {
            possibleHandlers.push(ticketData.claimedBy);
        }

        console.log(`🔍 Checking possible handlers:`, possibleHandlers);

        for (const candidate of possibleHandlers) {
            if (!candidate) continue;
            let currentId = candidate;

            const isDiscordId = /^\d{15,22}$/.test(candidate);
            if (!isDiscordId) {
                const resolvedId = await resolveDisplayNameToDiscordId(candidate);
                if (resolvedId) {
                    console.log(`🔍 Resolved candidate "${candidate}" → discord_id: ${resolvedId}`);
                    currentId = resolvedId;
                } else {
                    continue;
                }
            }

            // Try looking up employee in DB
            let empRes = await lookupEmployee(currentId);
            if (Array.isArray(empRes) && empRes.length > 0) {
                emp = empRes[0];
                resolvedClaimedBy = currentId;
                console.log(`✅ Found employee: ${emp.name} (id: ${emp.id})`);
                break;
            } else if (empRes && empRes.id) {
                emp = empRes;
                resolvedClaimedBy = currentId;
                console.log(`✅ Found employee: ${emp.name} (id: ${emp.id})`);
                break;
            }

            // If not in DB, check if they are actually a staff member (for auto-create)
            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild && typeof STAFF_ROLE_ID !== 'undefined') {
                const member = guild.members.cache.get(currentId);
                if (member && member.roles.cache.has(STAFF_ROLE_ID)) {
                    resolvedClaimedBy = currentId;
                    console.log(`⚠️ Handler is not in DB but is a staff member, queuing for auto-create: ${currentId}`);
                    break;
                }
            }
        }

        if (!emp && resolvedClaimedBy) {
            // Auto-create if it's a discord ID with staff role
            const isDiscordId = /^\d{15,22}$/.test(resolvedClaimedBy);
            if (isDiscordId) {
                try {
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (guild) {
                        const member = await guild.members.fetch(resolvedClaimedBy).catch(() => null);
                        if (member && typeof STAFF_ROLE_ID !== 'undefined' && member.roles.cache.has(STAFF_ROLE_ID)) {
                            const newId = Math.floor(100000000 + Math.random() * 900000000);
                            const displayName = member.displayName;
                            const newEmp = {
                                id: newId,
                                name: displayName,
                                discord_id: resolvedClaimedBy,
                                points: 0,
                                dc_points: 0,
                                mc_points: 0,
                                tickets: 0,
                                role: 'Staff',
                                avatar: displayName.charAt(0).toUpperCase() || 'S',
                                color: '#5C9EFF',
                                section: JSON.stringify({
                                    job_titles: [{ title: 'Staff', is_main: true }],
                                    rank_override: null
                                })
                            };
                            const insertEmpUrl = new URL(SUPABASE_URL + '/rest/v1/employees');
                            const insertPayload = JSON.stringify(newEmp);
                            await new Promise((resolveInsert) => {
                                const options = {
                                    hostname: insertEmpUrl.hostname,
                                    path: insertEmpUrl.pathname,
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'apikey': SUPABASE_KEY,
                                        'Authorization': 'Bearer ' + SUPABASE_KEY,
                                        'Prefer': 'return=minimal',
                                        'Content-Length': Buffer.byteLength(insertPayload)
                                    }
                                };
                                const req = https.request(options, res => {
                                    res.on('data', () => { });
                                    res.on('end', () => resolveInsert());
                                });
                                req.on('error', () => resolveInsert());
                                req.write(insertPayload);
                                req.end();
                            });
                            emp = newEmp;
                            console.log(`✅ Auto-created employee: ${displayName}`);
                        }
                    }
                } catch (e) {
                    console.error('Auto-create employee error:', e.message);
                }
            }
        }

        if (emp) {
            empId = emp.id;
            empPoints = emp.points || 0;
            empDcPoints = emp.dc_points || 0;
            empTickets = emp.tickets || 0;
            empName = emp.name;
        } else {
            console.log(`⚠️ Employee not found for: ${resolvedClaimedBy}`);
        }

        // --- AI Analysis ---
        let ptsToAward = 0;
        let aiReasoning = "Ticket Closed";
        let aiBreakdown = {};

        if (resolvedClaimedBy) {
            console.log(`🤖 Starting AI Transcript Analysis for ${empName}...`);
            const html = await fetchHtmlFromUrl(ticketData.transcriptUrl);
            if (html) {
                const aiResult = await analyzeTicketWithAI(html, empName);
                ptsToAward = aiResult.totalPoints;
                aiReasoning = aiResult.reasoning;
                aiBreakdown = aiResult.breakdown;
                console.log(`✅ AI Analysis complete! Awarded ${ptsToAward} points. Reasoning: ${aiReasoning}`);
            } else {
                console.log(`⚠️ Could not fetch transcript HTML. Defaulting to 5 points.`);
                ptsToAward = 5;
            }
        }

        if (empId && ptsToAward !== 0) {
            const newPoints = empPoints + ptsToAward;
            const newDcPoints = empDcPoints + ptsToAward;
            // if newEmp was created, tickets is 0 + 1 = 1. if existing, tickets_handled or tickets
            let currentTickets = empTickets !== undefined ? empTickets : 0;
            const newTickets = currentTickets + 1;

            const patchPayload = JSON.stringify({ points: newPoints, dc_points: newDcPoints, tickets: newTickets });
            const empPatchUrl = new URL(SUPABASE_URL + '/rest/v1/employees?id=eq.' + empId);
            await new Promise((resolve) => {
                const options = {
                    hostname: empPatchUrl.hostname,
                    path: empPatchUrl.pathname + empPatchUrl.search,
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': SUPABASE_KEY,
                        'Authorization': 'Bearer ' + SUPABASE_KEY,
                        'Content-Length': Buffer.byteLength(patchPayload)
                    }
                };
                const req = https.request(options, res => {
                    res.on('data', () => { });
                    res.on('end', () => resolve());
                });
                req.on('error', () => resolve());
                req.write(patchPayload);
                req.end();
            });

            try {
                const actionVerb = ptsToAward > 0 ? 'added' : (ptsToAward < 0 ? 'deducted' : 'added');
                const preposition = ptsToAward > 0 ? 'to' : (ptsToAward < 0 ? 'from' : 'to');
                
                // Log 1: For 'Recent Activities' (Points category, System as user)
                const logRecent = JSON.stringify({
                    action_type: 'Update Points', 
                    details: `Successfully ${actionVerb} ${Math.abs(ptsToAward)} points ${preposition} ${empName}. Reason: Ticket ${ticketData.ticketName} Evaluation`,
                    category: 'Points',
                    user_name: 'System',
                    created_at: new Date().toISOString()
                });

                const actionVerbFull = ptsToAward > 0 ? 'Awarded' : (ptsToAward < 0 ? 'Deducted' : 'Awarded');
                
                // Log 2: For 'Activity Logs' full table (Tickets category, System as user, detailed breakdown)
                const logFull = JSON.stringify({
                    action_type: 'Closed Ticket',
                    details: `[AI Evaluation] ${actionVerbFull} ${Math.abs(ptsToAward)} PTS ${preposition} ${empName} for handling ticket ${ticketData.ticketName}. Breakdown: Type: ${aiBreakdown.ticket_type_points || 0}, Resp: ${aiBreakdown.responses_points || 0}, Speed: ${aiBreakdown.level_speed_points || 0}. Note: ${aiReasoning}`,
                    category: 'Tickets',
                    user_name: 'System',
                    created_at: new Date().toISOString()
                });

                const logUrl = new URL(SUPABASE_URL + '/rest/v1/activity_log');
                
                const sendLog = (payloadStr) => new Promise((resolveLog) => {
                    const options = {
                        hostname: logUrl.hostname,
                        path: logUrl.pathname,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'apikey': SUPABASE_KEY,
                            'Authorization': 'Bearer ' + SUPABASE_KEY,
                            'Content-Length': Buffer.byteLength(payloadStr)
                        }
                    };
                    const reqLog = https.request(options, res => {
                        res.on('data', () => {});
                        res.on('end', resolveLog);
                    });
                    reqLog.on('error', resolveLog);
                    reqLog.write(payloadStr);
                    reqLog.end();
                });

                await Promise.all([sendLog(logRecent), sendLog(logFull)]);
            } catch (err) {
                console.error('Failed to log activity:', err.message);
            }
        }

        const closedAt = new Date().toISOString();

        const doInsert = (payload) => {
            const payloadStr = JSON.stringify(payload);
            const insertUrl = new URL(SUPABASE_URL + '/rest/v1/tickets?on_conflict=ticket_id');
            return new Promise((resolve) => {
                const options = {
                    hostname: insertUrl.hostname,
                    path: insertUrl.pathname + insertUrl.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': SUPABASE_KEY,
                        'Authorization': 'Bearer ' + SUPABASE_KEY,
                        'Prefer': 'return=minimal, resolution=merge-duplicates',
                        'Content-Length': Buffer.byteLength(payloadStr)
                    }
                };
                const req = https.request(options, res => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => resolve({ status: res.statusCode, body }));
                });
                req.on('error', (e) => { console.error('❌ Supabase INSERT network error:', e.message); resolve({ status: 0, body: '' }); });
                req.write(payloadStr);
                req.end();
            });
        };

        const basePayload = {
            ticket_id: ticketData.ticketName,
            title: ticketData.panelName || 'Support Request',
            emp_id: empId,
            status: 'closed',
            pts: ptsToAward,
            response_time: ticketData.responseTime || 'N/A',
            created_at: ticketData.openedAt || ticketData.timestamp
        };

        // Try with closed_at first; if column missing, retry without it
        let result = await doInsert({ ...basePayload, closed_at: closedAt });
        if (result.status >= 400 && result.body.includes('closed_at')) {
            console.log('⚠️ closed_at column missing — retrying without it (add it in Supabase SQL Editor)');
            result = await doInsert(basePayload);
        }
        if (result.status >= 400) {
            console.error('❌ Supabase tickets INSERT failed:', result.status, result.body);
        } else {
            console.log(`✅ Ticket saved to Supabase — emp: ${empName}, pts: ${ptsToAward}`);
        }
    } catch (err) {
        console.error('❌ saveTicketToSupabase error:', err.message);
    }
}

// Ready
client.once('ready', () => {
    console.log('🤖 Bot is online!');
    console.log(`📝 Bot name: ${client.user.tag}`);
    console.log(`📊 Watching channel: ${LOGGING_CHANNEL_ID}`);
    console.log(`📁 Transcripts folder: ${TRANSCRIPTS_FOLDER}`);
    console.log('⏳ Waiting for transcript messages...');
    console.log('---');
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
        guild.members.fetch().then(() => {
            console.log('✅ Members cached:', guild.members.cache.size);
            updateOnlineAdmins();
        }).catch(e => console.error('fetch members error:', e.message));
    }
    setInterval(updateOnlineAdmins, 60 * 1000);

    fetchMCStatus();
    setInterval(fetchMCStatus, 60 * 1000);

    fetchDiscordStats();
    setInterval(fetchDiscordStats, 16 * 1000);
});

// MC Status
async function fetchMCStatus() {
    try {
        const mcData = {
            serverName: 'WANO MC',
            serverIP: '95.156.225.24:26641',
            playersOnline: '0',
            maxPlayers: '100',
            peakPlayers: '0',
            totalLogins: '0',
            serverStatus: 'Offline',
            serverPing: '--',
            health: '100%',
            uptime: '--',
            availability: '99%',
            uniquePlayers: '0',
            lastUpdated: new Date().toISOString()
        };

        // Channel Topic
        const logsChannel = client.channels.cache.get(MC_LOGS_CHANNEL_ID);
        if (logsChannel && logsChannel.topic) {
            const topic = logsChannel.topic;
            console.log('📋 MC Logs Topic:', topic);

            const playersMatch = topic.match(/(\d+)\/(\d+)\s*players?\s*online/i);
            if (playersMatch) {
                mcData.playersOnline = playersMatch[1];
                mcData.maxPlayers = playersMatch[2];
                mcData.serverStatus = parseInt(playersMatch[1]) >= 0 ? 'Online' : 'Offline';
            }

            const uniqueMatch = topic.match(/(\d+)\s*unique\s*players?/i);
            if (uniqueMatch) {
                mcData.uniquePlayers = uniqueMatch[1];
                mcData.totalLogins = uniqueMatch[1];
            }

            const uptimeMatch = topic.match(/online\s*for\s*(\d+)\s*minutes?/i);
            if (uptimeMatch) {
                const mins = parseInt(uptimeMatch[1]);
                const hours = Math.floor(mins / 60);
                const remainMins = mins % 60;
                mcData.uptime = hours + 'h ' + remainMins + 'm';
                mcData.serverStatus = 'Online';
            }
        }

        // Direct MC Server API Query — primary source (fixes Components V2 embed unreadability)
        await new Promise((resolveApi) => {
            let apiTarget = MC_SERVER_IP;
            // The API expects 'ip' or 'ip:port'. Standard Minecraft port is 25565.
            // If the port is something else (like 25577), we should include it.
            https.get(`https://api.mcsrvstat.us/3/${apiTarget}`, { rejectUnauthorized: false }, (res) => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => {
                    try {
                        // Prevent JSON parse error if blocked by cloudflare (starts with < or Y)
                        if (!raw.startsWith('{')) throw new Error(raw.substring(0, 50));
                        
                        const json = JSON.parse(raw);
                        if (json.online) {
                            mcData.serverStatus = 'Online';
                            mcData.playersOnline = String(json.players?.online ?? 0);
                            mcData.maxPlayers = String(json.players?.max ?? 100);
                            if (json.debug?.ping != null) mcData.serverPing = json.debug.ping + 'ms';
                        } else {
                            mcData.serverStatus = 'Offline';
                        }
                        console.log(`🌐 MC API: ${mcData.serverStatus} | Players: ${mcData.playersOnline}/${mcData.maxPlayers} | Ping: ${mcData.serverPing}`);
                    } catch (e) {
                        console.log('⚠️ MC API parse error:', e.message);
                    }
                    resolveApi();
                });
            }).on('error', (e) => {
                console.log('⚠️ MC API fetch error:', e.message);
                resolveApi();
            });
        });

        // Status Embed
        try {
            let statusChannel = client.channels.cache.get(MC_STATUS_CHANNEL_ID);

            if (!statusChannel) {
                statusChannel = await client.channels.fetch(MC_STATUS_CHANNEL_ID);
            }

            if (statusChannel) {
                const message = await statusChannel.messages.fetch(MC_STATUS_MESSAGE_ID);
                console.log('📨 Embed found, fields:', message.embeds[0]?.fields?.length || 0, '| desc preview:', message.embeds[0]?.description?.substring(0, 120)?.replace(/\n/g, ' ') || 'none');

                if (message && message.embeds && message.embeds.length > 0) {
                    const embed = message.embeds[0];

                    if (embed.description) {
                        const desc = embed.description;

                        // Status detection from description text/emoji
                        if (desc.includes('🟢') || /open|players can join/i.test(desc)) {
                            mcData.serverStatus = 'Online';
                        }
                        if (desc.includes('🔴') || /server is offline|server is down/i.test(desc)) {
                            mcData.serverStatus = 'Offline';
                        }

                        const pingMatch = desc.match(/(?:Server\s+)?Ping[^\d]*(\d+)/i);
                        if (pingMatch) mcData.serverPing = pingMatch[1] + 'ms';

                        const healthMatch = desc.match(/Health[^\d]*([\d.]+)/i);
                        if (healthMatch) mcData.health = healthMatch[1] + '%';

                        const peakMatch = desc.match(/Peak\s+Players[^\d]*(\d+)/i);
                        if (peakMatch) mcData.peakPlayers = peakMatch[1];

                        const loginsMatch = desc.match(/Total\s+Logins[^\d]*(\d+)/i);
                        if (loginsMatch) mcData.totalLogins = loginsMatch[1];

                        const availMatch = desc.match(/Availability[^\d]*([\d.]+)/i);
                        if (availMatch) mcData.availability = availMatch[1] + '%';

                        const ipMatch = desc.match(/(?:Java\s+)?IP[^\d]*([\d.:]+)/i);
                        if (ipMatch) mcData.serverIP = ipMatch[1];

                        // Players from description
                        const playersDesc = desc.match(/Players\s+Online[^\d]*(\d+)\s*[\/|]\s*(\d+)/i);
                        if (playersDesc) {
                            mcData.playersOnline = playersDesc[1];
                            mcData.maxPlayers = playersDesc[2];
                        }

                        // Uptime from description
                        const uptimeDesc = desc.match(/Uptime[:\s]*(\d+h\s*\d+m(?:\s*\d+s)?|\d+m(?:\s*\d+s)?)/i);
                        if (uptimeDesc) mcData.uptime = uptimeDesc[1].trim();
                    }

                    if (embed.fields && embed.fields.length > 0) {
                        embed.fields.forEach(field => {
                            const name = field.name.toLowerCase();
                            const value = field.value.replace(/`/g, '').trim();

                            if (name.includes('ping')) {
                                const pingVal = value.match(/\d+/);
                                if (pingVal) mcData.serverPing = pingVal[0] + 'ms';
                            }
                            else if (name.includes('health')) {
                                const healthVal = value.match(/[\d.]+/);
                                if (healthVal) mcData.health = healthVal[0] + '%';
                            }
                            else if (name.includes('availability')) {
                                const availVal = value.match(/[\d.]+/);
                                if (availVal) mcData.availability = availVal[0] + '%';
                            }
                            else if (name.includes('peak')) {
                                const peakVal = value.match(/\d+/);
                                if (peakVal) mcData.peakPlayers = peakVal[0];
                            }
                            else if (name.includes('logins')) {
                                const loginsVal = value.match(/\d+/);
                                if (loginsVal) mcData.totalLogins = loginsVal[0];
                            }
                            else if (name.includes('server ip') || name.includes('ip')) {
                                mcData.serverIP = value.split('\n')[0].trim();
                            }
                        });
                    }
                }
            } else {
                console.log('⚠️ Could not find status channel');
            }
        } catch (embedErr) {
            console.log('⚠️ Could not fetch embed:', embedErr.message);
        }

        await saveToSupabase('mc_status', mcData);
        console.log('✅ MC Status:', mcData.playersOnline + '/' + mcData.maxPlayers, '|', mcData.serverStatus, '| Ping:', mcData.serverPing, '| Uptime:', mcData.uptime);

    } catch (err) {
        console.error('❌ fetchMCStatus error:', err.message);
    }
}

// Discord Stats
async function fetchDiscordStats() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;

        const onlineMembers = guild.members.cache.filter(m =>
            m.presence && ['online', 'dnd', 'idle'].includes(m.presence.status)
        ).size;

        const ticketCategory = guild.channels.cache.get(TICKET_CATEGORY_ID);
        let openTickets = 0;
        if (ticketCategory && ticketCategory.children) {
            openTickets = Math.max(0, ticketCategory.children.cache.size - 2);
        }

        let closedTickets = 0;

        try {
            const ticketsUrl = new URL(SUPABASE_URL + '/rest/v1/tickets?select=status');
            const ticketsResponse = await new Promise((resolve, reject) => {
                const options = {
                    hostname: ticketsUrl.hostname,
                    path: ticketsUrl.pathname + ticketsUrl.search,
                    method: 'GET',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': 'Bearer ' + SUPABASE_KEY
                    }
                };

                const req = https.request(options, res => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            resolve([]);
                        }
                    });
                });
                req.on('error', () => resolve([]));
                req.end();
            });

            if (Array.isArray(ticketsResponse)) {
                ticketsResponse.forEach(t => {
                    if (t.status === 'open' || t.status === 'Open' || t.status === 'pending') {
                        openTickets++;
                    } else {
                        closedTickets++;
                    }
                });
            }
        } catch (e) {
            console.log('Could not fetch tickets count:', e.message);
        }

        const dcData = {
            totalMembers: guild.memberCount,
            onlineMembers: onlineMembers,
            totalChannels: guild.channels.cache.size,
            totalRoles: guild.roles.cache.size,
            boostLevel: guild.premiumTier,
            boostCount: guild.premiumSubscriptionCount || 0,
            openTickets: openTickets,
            closedTickets: closedTickets,
            onlineStaff: guild.members.cache.filter(m => m.roles.cache.has(STAFF_ROLE_ID) && m.presence && ['online', 'dnd', 'idle'].includes(m.presence.status)).size,
            lastUpdated: new Date().toISOString()
        };

        await saveToSupabase('dc_status', dcData);

        await updateDiscordStatsEmbed(guild, dcData);

        console.log('✅ DC Status updated:', onlineMembers + '/' + guild.memberCount, 'online |', openTickets, 'open tickets');

    } catch (err) {
        console.error('❌ fetchDiscordStats error:', err.message);
    }
}

// Discord Stats Embed
async function updateDiscordStatsEmbed(guild, data) {
    try {
        const channel = client.channels.cache.get(DC_STATS_CHANNEL_ID) || await client.channels.fetch(DC_STATS_CHANNEL_ID);
        if (!channel) return;

        const embed = {
            author: { name: 'OPEX DISCORD SERVER MONITOR', icon_url: guild.iconURL() },
            title: '`[ SERVER LIVE STATUS ]`',
            color: 0x6366F1,
            description: 'Current real-time information about Opex server.',
            fields: [
                { name: '👥 Members', value: `> **Total Members:** \`${data.totalMembers}\` \n> **Online Now:** \`${data.onlineMembers}\``, inline: false },
                { name: '🛡️ Staff Team', value: `> **Online Staff:** \`${data.onlineStaff}\``, inline: false },
                { name: '🎟️ Support Tickets', value: `> **Open Tickets:** \`${data.openTickets}\` \n> **Finished Tickets:** \`${data.closedTickets}\``, inline: false },
                { name: '📡 Server Info', value: `> **Total Channels:** \`${data.totalChannels}\` \n> **Boost Level:** \`Level ${data.boostLevel}\` (\`${data.boostCount}\` boosts)`, inline: false }
            ],
            footer: { text: 'Last Update • ' + new Date().toLocaleTimeString('en-GB') }
        };

        await channel.send({ embeds: [embed] });

    } catch (e) {
        console.warn('⚠️ Log Sync Error:', e.message);
    }
}

// Supabase — Save Settings
async function saveToSupabase(key, data) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('❌ SUPABASE credentials missing!');
        return;
    }

    const valueJson = JSON.stringify(data);
    const patchPayload = JSON.stringify({ value: valueJson });
    const urlObj = new URL(SUPABASE_URL + '/rest/v1/settings');

    const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + '?key=eq.' + key,
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Length': Buffer.byteLength(patchPayload)
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    insertToSupabase(key, data).then(resolve).catch(reject);
                } else {
                    resolve();
                }
            });
        });
        req.on('error', reject);
        req.write(patchPayload);
        req.end();
    });
}

// Supabase — Insert Settings
async function insertToSupabase(key, data) {
    const valueJson = JSON.stringify(data);
    const payload = JSON.stringify({ key: key, value: valueJson });
    const urlObj = new URL(SUPABASE_URL + '/rest/v1/settings');

    const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Prefer': 'return=minimal',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// Presence Update
client.on('presenceUpdate', () => {
    scheduleOnlineUpdate(120000);
});

// Helpers — Extract Ticket Name
function extractTicketName(fullText, transcriptUrl) {
    let match = fullText.match(/Case\s*#(\d+)/i) || fullText.match(/case-(\d+)/i);
    if (match) return `case-${match[1]}`;

    match = fullText.match(/ticket-(\d+)/i) || fullText.match(/Ticket\s*#(\d+)/i);
    if (match) return `ticket-${match[1]}`;

    if (transcriptUrl) {
        const parts = transcriptUrl.split('/');
        const lastPart = parts[parts.length - 1];
        const numMatch = lastPart.match(/\d+/);
        if (numMatch) return `case-${numMatch[0]}`;
        return lastPart.replace('.html', '');
    }

    return 'ticket';
}

// Helpers — Extract Ticket Owner
function extractTicketOwner(fullText) {
    let match = fullText.match(/(?:Ticket Owner|Owner|User|Created by)[^\d<]*<@!?(\d+)>/i);
    if (match) return match[1];

    match = fullText.match(/(?:Ticket Owner|Owner|User|Created by)[^\d]*(\d{15,22})/i);
    if (match) return match[1];

    return null;
}

// Helpers — Extract Claimed By
function extractClaimedBy(fullText) {
    let match = fullText.match(/(?:Closed|Claimed|Handled)\s*[Bb]y[\s:*]*<@!?(\d+)>/i);
    if (match) return match[1];

    match = fullText.match(/(?:Closed|Claimed|Handled)\s*[Bb]y[\s:*]*(\d{15,22})/i);
    if (match) return match[1];

    match = fullText.match(/(?:Closed|Claimed|Handled)\s*[Bb]y\s*[:\s]+([^\n\r<@\d(][^\n\r(]{2,})/i);
    if (match) {
        const name = match[1].trim().split('\n')[0].trim();
        if (name && name.length > 2 && !name.toLowerCase().includes('unknown') && !name.toLowerCase().includes('ticket')) {
            return name;
        }
    }

    return null;
}

// Message Handler
client.on('messageCreate', async (message) => {
    // Broadcast Command
    if (message.content.startsWith('!bc')) {
        if (message.author.id !== '1350531070222794804') return;

        const args = message.content.split(' ');
        let targetGuild;
        let bcContent;

        if (args.length >= 3 && /^\d{17,20}$/.test(args[1])) {
            targetGuild = client.guilds.cache.get(args[1]) || await client.guilds.fetch(args[1]).catch(() => null);
            const firstTwoWordsLength = args[0].length + 1 + args[1].length + 1;
            bcContent = message.content.substring(firstTwoWordsLength).trim();
        } else {
            targetGuild = message.guild;
            bcContent = message.content.substring(3).trim();
        }

        const attachments = Array.from(message.attachments.values()).map(att => att.url);

        if (targetGuild && (bcContent || attachments.length > 0)) {
            try {
                await message.channel.send(`⏳ Broadcasting to: ${targetGuild.name}...`);
                const members = await targetGuild.members.fetch();
                for (const [memberId, member] of members) {
                    if (!member.user.bot) {
                        const sendOptions = {};
                        if (bcContent) {
                            sendOptions.content = `${member.toString()}\n\n${bcContent}`;
                        } else {
                            sendOptions.content = `${member.toString()}`;
                        }
                        if (attachments.length > 0) {
                            sendOptions.files = attachments;
                        }
                        try {
                            await member.send(sendOptions);
                            console.log(`✅ Sent to: ${member.user.username}`);
                        } catch (err) {
                            console.error(`❌ Failed to send to: ${member.user.username}`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                await message.channel.send(`Broadcast to ${targetGuild.name} done ✅`);
            } catch (err) {
                console.error(err);
                await message.channel.send(`❌ Broadcast error: ${err.message}`);
            }
        } else {
            await message.channel.send("❌ Error: server not found or message is empty.");
        }
        return;
    }

    if (message.channel.id === LOGGING_CHANNEL_ID && message.author.bot) {
        console.log('📬 New bot message in Logging channel!');
        console.log('📝 Bot name:', message.author.username);

        let fullText = message.content || '';
        let transcriptUrl = null;

        if (message.components && message.components.length > 0) {
            for (const row of message.components) {
                if (row.components) {
                    for (const comp of row.components) {
                        if (comp.url) {
                            transcriptUrl = comp.url;
                        }
                    }
                }
            }
        }

        if (message.embeds && message.embeds.length > 0) {
            const embed = message.embeds[0];
            fullText += '\n' + (embed.title || '') + '\n' + (embed.description || '');
            if (embed.url) {
                transcriptUrl = transcriptUrl || embed.url;
            }
            if (embed.fields) {
                embed.fields.forEach(f => {
                    fullText += '\n' + (f.name || '') + '\n' + (f.value || '');
                });
            }
        }

        let attachmentUrl = null;
        let cleanFileName = null;
        if (message.attachments && message.attachments.size > 0) {
            const htmlAttachment = message.attachments.find(att =>
                att.name && att.name.endsWith('.html')
            );
            if (htmlAttachment) {
                attachmentUrl = htmlAttachment.url;
                cleanFileName = htmlAttachment.name.replace(/[^a-zA-Z0-9.-]/g, '_');
                transcriptUrl = transcriptUrl || htmlAttachment.url;
            }
        }

        if (!transcriptUrl) {
            const urlMatch = fullText.match(/https?:\/\/[^\s)\]]+/);
            if (urlMatch) {
                transcriptUrl = urlMatch[0];
            }
        }

        if (transcriptUrl || attachmentUrl) {
            console.log(`📎 Transcript found: ${transcriptUrl || attachmentUrl}`);

            let transcriptContent = '';
            let transcriptFileName = null;
            try {
                if (attachmentUrl && cleanFileName) {
                    const filePath = path.join(TRANSCRIPTS_FOLDER, cleanFileName);
                    await downloadFile(attachmentUrl, filePath);
                    transcriptContent = fs.readFileSync(filePath, 'utf8');
                    transcriptFileName = cleanFileName;
                } else if (transcriptUrl && (transcriptUrl.includes('https://') || transcriptUrl.includes('http://'))) {
                    transcriptContent = await fetchHtmlFromUrl(transcriptUrl);
                    const parsedName = extractTicketName(fullText, transcriptUrl);
                    transcriptFileName = `${parsedName}.html`.replace(/[^a-zA-Z0-9.-]/g, '_');
                    const filePath = path.join(TRANSCRIPTS_FOLDER, transcriptFileName);
                    fs.writeFileSync(filePath, transcriptContent, 'utf8');
                }
            } catch (err) {
                console.error('Error fetching/processing transcript:', err.message);
            }

            const ticketName = extractTicketName(fullText, transcriptUrl);
            const ticketOwnerId = extractTicketOwner(fullText);
            const claimedBy = extractClaimedBy(fullText);

            // Transcript-based data extraction
            let openedAt = transcriptContent ? extractTicketOpenedAt(transcriptContent) : null;
            if (!openedAt) openedAt = new Date().toISOString();

            const openedByUsername = transcriptContent ? extractOpenedByUsername(transcriptContent) : null;

            // Extract channel name from HTML title to find the handler
            let handlerUsername = null;
            if (transcriptContent) {
                const titleMatch = transcriptContent.match(/<title>([^<]+)<\/title>/i);
                if (titleMatch) {
                    let title = titleMatch[1].toLowerCase().trim();
                    if (title.includes(' - ')) title = title.split(' - ').pop().trim();

                    // Ticket Tool sometimes prepends "transcript " to the title
                    title = title.replace(/^transcript\s*[-:]?\s*/i, '').trim();

                    let handlerStr = title.replace(/^(support|ticket|case|closed)(-\d+)?-?/i, '').trim();

                    // Remove suffixes like -c, -closed
                    handlerStr = handlerStr.replace(/-c$/i, '').replace(/-closed$/i, '').trim();

                    // Remove special characters (like ༃) so exact matching works
                    handlerStr = handlerStr.replace(/[^\w\s-]/g, '').trim();

                    if (handlerStr.length > 2 && !handlerStr.match(/^#?\d+$/)) {
                        handlerUsername = handlerStr;
                    }
                }
            }

            // Fallback to extracting from messages
            if (!handlerUsername && transcriptContent) {
                handlerUsername = extractHandlerFromTranscript(transcriptContent, openedByUsername);
            }

            const responseTime = formatResponseTime(openedAt);

            if (handlerUsername) console.log(`🔍 Handler from transcript: "${handlerUsername}"`);
            if (openedAt) console.log(`⏰ Opened at (UTC): ${openedAt}, response time: ${responseTime}`);

            let panelName = 'Ticket';
            const transcriptType = transcriptContent ? extractTicketType(transcriptContent) : null;
            if (transcriptType) {
                panelName = transcriptType;
            } else if (ticketName && ticketName.includes('-')) {
                const firstPart = ticketName.split('-')[0];
                panelName = firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
            }

            const userMatches = fullText.match(/<@!?\d+>/g);
            const users = userMatches ? [...new Set(userMatches)] : [];

            let finalTranscriptPath = null;
            if (transcriptFileName) {
                finalTranscriptPath = `transcripts/${transcriptFileName}`;
            } else {
                finalTranscriptPath = `transcripts/${ticketName.replace(/[^a-zA-Z0-9.-]/g, '_')}.html`;
            }

            const ticketData = {
                timestamp: new Date().toISOString(),
                openedAt: openedAt || new Date().toISOString(),
                ticketOwner: ticketOwnerId ? `<@${ticketOwnerId}>` : null,
                ticketOwnerId: ticketOwnerId,
                ticketName: ticketName,
                panelName: panelName,
                transcriptFile: finalTranscriptPath,
                transcriptUrl: transcriptUrl || null,
                claimedBy: claimedBy,
                handlerUsername: handlerUsername,
                users: users,
                responseTime: responseTime
            };

            if (ticketOwnerId) {
                try {
                    const member = message.guild.members.cache.get(ticketOwnerId);
                    if (member) {
                        ticketData.ticketOwnerName = member.user.username;
                        ticketData.ticketOwnerDisplay = member.displayName;
                    }
                } catch (E) { }
            }

            const allTickets = loadTickets();
            allTickets.unshift(ticketData);
            const jsContent = saveTickets(allTickets);

            // GitHub — Single Commit Upload
            const filesToUpload = [{ path: GITHUB_FILE_PATH, content: jsContent }];
            if (transcriptFileName && transcriptContent) {
                filesToUpload.push({ path: `transcripts/${transcriptFileName}`, content: transcriptContent });
            }
            await uploadFilesToGitHub(filesToUpload, `Ticket closed: ${ticketName}`);

            await saveTicketToSupabase(ticketData);

            console.log(`✅ Ticket saved: ${ticketName}`);
            console.log('---\n');
        } else {
            console.log('⚠️ No transcript link or file found in message.');
        }
    }
});

// Login
console.log('🔄 Logging in...');
client.login(DISCORD_TOKEN).catch(err => {
    console.error('❌ Login error:', err.message);
    process.exit(1);
});
