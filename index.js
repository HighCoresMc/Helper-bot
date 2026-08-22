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
const DC_STATS_MESSAGE_ID = process.env.DC_STATS_MESSAGE_ID || '1508162784339165376';

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

// Prisma
const { prisma } = require('./prisma');
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

        const valueJson = JSON.stringify({ count, names, updated: new Date().toISOString() });
        const existing = await prisma.settings.findFirst({ where: { key: 'admin_online' } });
        if (existing) {
            await prisma.settings.update({ where: { id: existing.id }, data: { value: valueJson } });
        } else {
            await prisma.settings.create({ data: { key: 'admin_online', value: valueJson } });
        }
        console.log('✅ DB updated — online:', count);
    } catch (e) {
        console.error('❌ updateOnlineAdmins Error:', e);
    }
}

function githubApiRequest(method, endpoint, payload = null) {
    return new Promise((resolve, reject) => {
        payload = payload ? JSON.stringify(payload) : null;
        const options = {
            hostname: 'api.github.com',
            path: endpoint,
            method: method,
            headers: {
                'User-Agent': 'HighCore-Bot',
                'Authorization': `token ${GITHUB_TOKEN}`,
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
    try {
        const isDiscordId = /^\d{15,22}$/.test(identifier);
        let emp;
        if (isDiscordId) {
            // Prisma stores discord_id as BigInt, we need to convert identifier string to BigInt
            emp = await prisma.employees.findMany({ where: { discord_id: BigInt(identifier) } });
        } else {
            const searchName = identifier.replace(/^@/, '').trim();
            emp = await prisma.employees.findMany({ where: { name: { contains: searchName, mode: 'insensitive' } } });
        }

        // Convert BigInt to String for JSON compatibility (simulating original REST API response)
        const serialized = JSON.parse(JSON.stringify(emp, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));

        return serialized;
    } catch (e) {
        console.error('lookupEmployee error:', e);
        return [];
    }
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

Return ONLY a JSON object with this exact structure (do not use markdown formatting, just raw JSON):
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

        const modelsToTry = ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
        let responseText = null;

        for (const modelName of modelsToTry) {
            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    })
                });

                const data = await response.json();

                if (data.error) {
                    throw new Error(data.error.message);
                }

                if (data.candidates && data.candidates.length > 0 && data.candidates[0].content.parts.length > 0) {
                    responseText = data.candidates[0].content.parts[0].text;
                    break; // Success!
                } else {
                    throw new Error("Empty response from API");
                }
            } catch (e) {
                console.log(`⚠️ Failed with ${modelName}: ${e.message}`);
            }
        }

        if (!responseText) {
            console.log("❌ All Gemini models failed via direct API.");
            return { totalPoints: 0, breakdown: { error: "Failed" }, reasoning: "AI Error: All models failed" };
        }

        let cleanJson = responseText.replace(/\s*```json/gi, '').replace(/```/g, '').trim();
        const json = JSON.parse(cleanJson);

        // Calculate total manually to be safe
        const calculatedTotal = (json.ticket_type_points || 0) + (json.responses_points || 0) + (json.level_speed_points || 0);
        const finalPoints = json.total_points !== undefined ? json.total_points : calculatedTotal;

        console.log(`✅ AI Analysis complete! Awarded ${finalPoints} points. Reasoning: ${json.reasoning}`);
        return {
            totalPoints: finalPoints,
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
    try {
        let empId = null;
        let empPoints = 0;
        let empDcPoints = 0;
        let empTickets = 0;
        let empName = 'Unassigned';
        let resolvedClaimedBy = null;
        let emp = null;

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
            const isDiscordId = /^\d{15,22}$/.test(resolvedClaimedBy);
            if (isDiscordId) {
                try {
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (guild) {
                        const member = await guild.members.fetch(resolvedClaimedBy).catch(() => null);
                        if (member && typeof STAFF_ROLE_ID !== 'undefined' && member.roles.cache.has(STAFF_ROLE_ID)) {
                            const displayName = member.displayName;
                            const newEmpData = {
                                name: displayName,
                                discord_id: BigInt(resolvedClaimedBy),
                                points: 0,
                                dc_points: 0,
                                mc_points: 0,
                                tickets: 0,
                                role: 'Staff',
                                avatar: displayName.charAt(0).toUpperCase() || 'S',
                                color: '#5C9EFF',
                                section: {
                                    job_titles: [{ title: 'Staff', is_main: true }],
                                    rank_override: null
                                }
                            };
                            const createdEmp = await prisma.employees.create({ data: newEmpData });
                            // Convert BigInt to string for compatibility
                            emp = JSON.parse(JSON.stringify(createdEmp, (key, value) => typeof value === 'bigint' ? value.toString() : value));
                            console.log(`✅ Auto-created employee: ${displayName}`);
                        }
                    }
                } catch (e) {
                    console.error('Auto-create employee error:', e.message);
                }
            }
        }

        if (emp) {
            empId = BigInt(emp.id);
            empPoints = emp.points || 0;
            empDcPoints = emp.dc_points || 0;
            empTickets = emp.tickets || 0;
            empName = emp.name;
        } else {
            console.log(`⚠️ Employee not found for: ${resolvedClaimedBy}`);
        }

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
            let currentTickets = empTickets !== undefined ? empTickets : 0;
            const newTickets = currentTickets + 1;

            await prisma.employees.update({
                where: { id: Number(empId) },
                data: { points: newPoints, dc_points: newDcPoints, tickets: newTickets }
            });

            try {
                const actionVerb = ptsToAward > 0 ? 'added' : (ptsToAward < 0 ? 'deducted' : 'added');
                const preposition = ptsToAward > 0 ? 'to' : (ptsToAward < 0 ? 'from' : 'to');
                const actionVerbFull = ptsToAward > 0 ? 'Awarded' : (ptsToAward < 0 ? 'Deducted' : 'Awarded');

                await prisma.activity_log.createMany({
                    data: [
                        {
                            action_type: 'Update Points',
                            details: `Successfully ${actionVerb} ${Math.abs(ptsToAward)} points ${preposition} ${empName}. Reason: Ticket ${ticketData.ticketName} Evaluation`,
                            category: 'Points',
                            user_name: 'System',
                            created_at: new Date()
                        },
                        {
                            action_type: 'Closed Ticket',
                            details: `[AI Evaluation] ${actionVerbFull} ${Math.abs(ptsToAward)} PTS ${preposition} ${empName} for handling ticket ${ticketData.ticketName}. Breakdown: Type: ${aiBreakdown.ticket_type_points || 0}, Resp: ${aiBreakdown.responses_points || 0}, Speed: ${aiBreakdown.level_speed_points || 0}. Note: ${aiReasoning}`,
                            category: 'Tickets',
                            user_name: 'System',
                            created_at: new Date()
                        }
                    ]
                });
            } catch (err) {
                console.error('Failed to log activity:', err.message);
            }
        }

        const closedAt = new Date().toISOString();

        const basePayload = {
            ticket_id: ticketData.ticketName,
            title: ticketData.panelName || 'Support Request',
            emp_id: empId,
            status: 'closed',
            pts: ptsToAward,
            response_time: ticketData.responseTime || 'N/A',
            created_at: ticketData.openedAt ? new Date(ticketData.openedAt) : new Date(ticketData.timestamp),
            closed_at: closedAt
        };

        const existingTicket = await prisma.tickets.findFirst({ where: { ticket_id: ticketData.ticketName } });
        if (existingTicket) {
            await prisma.tickets.update({ where: { id: existingTicket.id }, data: basePayload });
        } else {
            await prisma.tickets.create({ data: basePayload });
        }

        console.log(`✅ Ticket saved to DB — emp: ${empName}, pts: ${ptsToAward}`);
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

        // Direct MC Server API Query
        await new Promise((resolveApi) => {
            let apiTarget = MC_SERVER_IP;
            const options = {
                rejectUnauthorized: false,
                headers: { 'User-Agent': 'HighCoreMC-Discord-Bot/1.0' }
            };
            https.get(`https://api.mcsrvstat.us/3/${apiTarget}`, options, (res) => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => {
                    // Use regex on raw string to detect online status safely
                    if (/\{.*"online":\s*true/.test(raw)) {
                        mcData.serverStatus = 'Online';
                        const pMatch = raw.match(/"online":\s*(\d+)/);
                        const mMatch = raw.match(/"max":\s*(\d+)/);
                        const pingMatch = raw.match(/"ping":\s*(\d+)/);
                        if (pMatch) mcData.playersOnline = pMatch[1];
                        if (mMatch) mcData.maxPlayers = mMatch[1];
                        if (pingMatch) mcData.serverPing = pingMatch[1] + 'ms';
                    } else {
                        mcData.serverStatus = 'Offline';
                    }
                    console.log(`🌐 MC API: ${mcData.serverStatus} | Players: ${mcData.playersOnline}/${mcData.maxPlayers}`);
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

                if (message) {
                    let fullText = message.content || "";

                    if (message.embeds && message.embeds.length > 0) {
                        fullText += "\n" + message.embeds.map(e => {
                            let text = (e.title || "") + " " + (e.description || "") + "\n";
                            if (e.fields) {
                                text += e.fields.map(f => f.name + " " + f.value).join("\n");
                            }
                            return text;
                        }).join("\n\n");
                    }

                    // Use toJSON() to get raw API data, avoiding discord.js stripping unknown component fields
                    try { fullText += "\n" + JSON.stringify(message.toJSON()); } catch (e) {}
                    try { fullText += "\n" + JSON.stringify(message.components); } catch (e) {}

                    const desc = fullText;

                    // Status detection from description text/emoji
                    if (desc.includes('🟢') || /open|players can join/i.test(desc)) {
                        mcData.serverStatus = 'Online';
                    }
                    if (desc.includes('🔴') || /server is offline|server is down/i.test(desc)) {
                        mcData.serverStatus = 'Offline';
                    }

                    const nameMatch = desc.match(/Server\s*Name[^\w`]*`([^`]+)`/i);
                    if (nameMatch) mcData.serverName = nameMatch[1];
                    else mcData.serverName = 'HighCoresMc';

                    const pingMatch = desc.match(/Server\s*Ping[^\d]*(\d+)/i);
                    if (pingMatch) mcData.serverPing = pingMatch[1] + 'ms';

                    const healthMatch = desc.match(/Health[^\d]*([\d.]+)/i);
                    if (healthMatch) mcData.health = healthMatch[1] + '%';

                    const peakMatch = desc.match(/Peak\s*Players[^\d]*(\d+)/i);
                    if (peakMatch) mcData.peakPlayers = peakMatch[1];

                    const loginsMatch = desc.match(/Total\s*Logins[^\d]*(\d+)/i);
                    if (loginsMatch) mcData.totalLogins = loginsMatch[1];

                    const availMatch = desc.match(/Availability[^\d]*([\d.]+)/i);
                    if (availMatch) mcData.availability = availMatch[1] + '%';

                    const ipMatch = desc.match(/Java\s*IP[^\w`]*`?([\d.:a-zA-Z]+)`?/i);
                    const portMatch = desc.match(/Java\s*Port[^\w`]*`?(\d+)`?/i);
                    if (ipMatch && portMatch) {
                        mcData.serverIP = ipMatch[1] + ':' + portMatch[1];
                    } else if (ipMatch) {
                        mcData.serverIP = ipMatch[1];
                    }

                    const playersDesc = desc.match(/Players\s*Online[^\d]*(\d+)\s*[\/|]\s*(\d+)/i);
                    if (playersDesc) {
                        mcData.playersOnline = playersDesc[1];
                        mcData.maxPlayers = playersDesc[2];
                    }

                    // Uptime could be "Uptime:** `5m 39s`" -> we want to capture "5m 39s"
                    const uptimeDesc = desc.match(/Uptime[^\w`]*`?(\d+h\s*\d+m(?:\s*\d+s)?|\d+m(?:\s*\d+s)?|\d+h|\d+s)`?/i);
                    if (uptimeDesc) mcData.uptime = uptimeDesc[1].trim();
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
            closedTickets = await prisma.tickets.count();
        } catch (e) {
            console.error('Prisma Error fetching tickets count:', e.message);
        }

        const onlineStaff = guild.members.cache.filter(m =>
            m.roles.cache.has(STAFF_ROLE_ID) &&
            m.presence && ['online', 'dnd', 'idle'].includes(m.presence.status)
        ).size;

        const dcData = {
            totalMembers: guild.memberCount,
            onlineMembers: onlineMembers,
            totalChannels: guild.channels.cache.size,
            boostLevel: guild.premiumTier,
            boostCount: guild.premiumSubscriptionCount || 0,
            openTickets: openTickets,
            closedTickets: closedTickets,
            onlineStaff: onlineStaff
        };

        // await saveToSupabase('dc_status', dcData); // Note: It's saveToSupabase, which is already Prisma now!
        await saveToSupabase('dc_status', dcData);
        await updateDiscordStatsEmbed(guild, dcData);

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

// Prisma Settings
async function saveToSupabase(key, data) {
    try {
        const valueJson = JSON.stringify(data);
        const existing = await prisma.settings.findFirst({ where: { key } });
        if (existing) {
            await prisma.settings.update({ where: { id: existing.id }, data: { value: valueJson } });
        } else {
            await prisma.settings.create({ data: { key, value: valueJson } });
        }
    } catch (e) {
        console.error('❌ saveToSupabase Error:', e);
    }
}

async function insertToSupabase(key, data) {
    return saveToSupabase(key, data);
}
client.login(DISCORD_TOKEN).catch(err => {
    console.error('❌ Login error:', err.message);
    process.exit(1);
});

client.on('messageCreate', async (message) => {
    if (message.channel.id === LOGGING_CHANNEL_ID && message.author.bot) {
        console.log('📬 رسالة جديدة في روم اللوقات!');
        
        let fullText = message.content || "";
        try { fullText += " " + JSON.stringify(message.toJSON ? message.toJSON() : message); } catch(e) {}
        
        console.log('🔍 البحث في المكونات (JSON preview):', fullText.substring(0, 150));

        if (fullText.includes('Archive — Case') || fullText.includes('View Transcript') || fullText.includes('TRANSCRIPT')) {
            console.log('\n📩 تم اكتشاف تكت جديد من البوت (مكونات V2)!');
            
            const ticketData = {
                timestamp: new Date().toISOString(),
                ticketOwnerId: null,
                ticketName: null,
                panelName: 'Archive',
                transcriptUrl: null,
                claimedBy: null,
                users: []
            };

            const caseMatch = fullText.match(/Case\s*#?(\w+)/i);
            if (caseMatch) ticketData.ticketName = "ticket-" + caseMatch[1];
            else ticketData.ticketName = "ticket-unknown";

            const ownerMatch = fullText.match(/\*\*User:\*\*.*?<@!?(\d+)>/);
            if (ownerMatch) ticketData.ticketOwnerId = ownerMatch[1];

            const claimMatch = fullText.match(/\*\*Claimed By:\*\*.*?<@!?(\d+)>/);
            if (claimMatch) ticketData.claimedBy = claimMatch[1];

            const linkMatch = fullText.match(/\[View Transcript\]\((https?:\/\/[^\)]+)\)/i);
            if (linkMatch) ticketData.transcriptUrl = linkMatch[1];

            if (ticketData.ticketName && ticketData.transcriptUrl) {
                console.log(`✅ تم استخراج البيانات لتكت: ${ticketData.ticketName}`);
                console.log(`🔗 الرابط: ${ticketData.transcriptUrl}`);
                
                await saveTicketToSupabase(ticketData);
            } else {
                console.log('⚠️ لم يتم العثور على رابط الترانسكربت أو اسم التكت في الرسالة.');
            }
        } else {
            console.log('الرسالة لا تحتوي على بيانات تكت.');
        }
    }
});
