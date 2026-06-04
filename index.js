const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

// إعدادات البوت من متغيرات البيئة
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOGGING_CHANNEL_ID = process.env.LOGGING_CHANNEL_ID;
const TICKETS_FILE = path.join(__dirname, './tickets.js');
const TRANSCRIPTS_FOLDER = path.join(__dirname, './transcripts');
const TICKET_CATEGORY_ID = '1487143174567628840';

// إعدادات MC Server Status
const MC_STATUS_CHANNEL_ID = process.env.MC_STATUS_CHANNEL_ID || '1487139736748425236';
const MC_STATUS_MESSAGE_ID = process.env.MC_STATUS_MESSAGE_ID || '1508162784339165376';
const MC_LOGS_CHANNEL_ID = process.env.MC_LOGS_CHANNEL_ID || '1487148944667578368';

// إعدادات GitHub من متغيرات البيئة
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH = 'tickets.js';

// Discord Stats Channel
const DC_STATS_CHANNEL_ID = '1495819247685996844';
const DC_STATS_MESSAGE_ID = process.env.DC_STATS_MESSAGE_ID || 'your_dc_status_msg_id';

// إنشاء مجلد الترانسكربتات إذا ما كان موجود
if (!fs.existsSync(TRANSCRIPTS_FOLDER)) {
    fs.mkdirSync(TRANSCRIPTS_FOLDER, { recursive: true });
    console.log('📁 تم إنشاء مجلد transcripts');
}

// إنشاء البوت
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
    ]
});

// إعدادات Supabase
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const GUILD_ID      = process.env.GUILD_ID;

// Discord Role ID للستاف
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '1487195816220430406';

// تحديث Supabase بعدد الأدمن الأونلاين (من الكاش فقط — بدون fetch)
var _onlineUpdateTimer = null;

function scheduleOnlineUpdate(delay = 5000) {
    clearTimeout(_onlineUpdateTimer);
    _onlineUpdateTimer = setTimeout(updateOnlineAdmins, delay);
}

async function updateOnlineAdmins() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;

        // استخدم الكاش فقط — بدون fetch لتجنب rate limit
        // فلتر الستاف الأونلاين مع إزالة التكرار بالـ ID
        const seen = new Set();
        const onlineStaff = guild.members.cache.filter(member => {
            if (seen.has(member.id)) return false;
            const isStaff  = member.roles.cache.has(STAFF_ROLE_ID);
            const isOnline = member.presence && ['online','dnd','idle'].includes(member.presence.status);
            if (isStaff && isOnline) { seen.add(member.id); return true; }
            return false;
        });

        const count = onlineStaff.size;
        const names = onlineStaff.map(m => m.displayName).join(', ');
        
        console.log('👥 أدمن أونلاين:', count, names ? '(' + names + ')' : '(لا أحد)');

        console.log('🔄 جاري الإرسال لـ Supabase... URL:', SUPABASE_URL ? 'موجود' : 'ناقص', 'KEY:', SUPABASE_KEY ? 'موجود' : 'ناقص');
        if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('❌ SUPABASE_URL أو SUPABASE_KEY ناقص!'); return; }

        const valueJson = JSON.stringify({ count, names, updated: new Date().toISOString() });
        const payload = JSON.stringify({ key: 'admin_online', value: valueJson });
        
        const https2 = require('https');
        const urlObj = new URL(SUPABASE_URL + '/rest/v1/settings');

        // Use upsert (POST with Prefer: resolution=merge-duplicates)
        // PATCH على الصف الموجود مباشرة
        const patchPayload = JSON.stringify({ value: valueJson });
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
        console.error('❌ خطأ في تحديث الأدمن الأونلاين:', err.message);
    }
}

// قراءة ملف التكتات
function loadTickets() {
    if (fs.existsSync(TICKETS_FILE)) {
        const data = fs.readFileSync(TICKETS_FILE, 'utf8');
        // استخراج البيانات من window.ticketsData
        const match = data.match(/window\.ticketsData\s*=\s*(\[[\s\S]*\]);/);
        if (match) {
            return JSON.parse(match[1]);
        }
    }
    return [];
}

// حفظ التكتات
function saveTickets(tickets) {
    const jsContent = `// بيانات التكتات\nwindow.ticketsData = ${JSON.stringify(tickets, null, 2)};\n`;
    fs.writeFileSync(TICKETS_FILE, jsContent, 'utf8');
    console.log('✅ تم حفظ التكت في tickets.js');
    
    // رفع على GitHub
    uploadToGitHub(jsContent);
}

// رفع الملف على GitHub
async function uploadToGitHub(content) {
    try {
        console.log('📤 جاري رفع tickets.js على GitHub...');
        
        // جلب SHA الحالي للملف
        const getCurrentSHA = () => {
            return new Promise((resolve, reject) => {
                const options = {
                    hostname: 'api.github.com',
                    path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`,
                    method: 'GET',
                    headers: {
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'User-Agent': 'Ticket-Bot',
                        'Accept': 'application/vnd.github.v3+json'
                    }
                };
                
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            const json = JSON.parse(data);
                            resolve(json.sha);
                        } else {
                            resolve(null);
                        }
                    });
                });
                
                req.on('error', reject);
                req.end();
            });
        };
        
        const sha = await getCurrentSHA();
        
        // رفع الملف
        const uploadFile = (sha) => {
            return new Promise((resolve, reject) => {
                const base64Content = Buffer.from(content).toString('base64');
                const payload = JSON.stringify({
                    message: 'Update tickets.js - New ticket added',
                    content: base64Content,
                    sha: sha
                });
                
                const options = {
                    hostname: 'api.github.com',
                    path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`,
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'User-Agent': 'Ticket-Bot',
                        'Content-Type': 'application/json',
                        'Accept': 'application/vnd.github.v3+json'
                    }
                };
                
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200 || res.statusCode === 201) {
                            resolve(true);
                        } else {
                            reject(new Error(`GitHub API Error: ${res.statusCode} - ${data}`));
                        }
                    });
                });
                
                req.on('error', reject);
                req.write(payload);
                req.end();
            });
        };
        
        await uploadFile(sha);
        console.log('✅ تم رفع tickets.js على GitHub بنجاح!');
        console.log('🌐 الموقع سيتحدث تلقائياً خلال دقيقة!');
        
    } catch (error) {
        console.error('❌ خطأ في رفع الملف على GitHub:', error.message);
    }
}

// رفع الترانسكربت على GitHub
async function uploadTranscriptToGitHub(fileName, content) {
    try {
        console.log(`📤 جاري رفع الترانسكربت ${fileName} على GitHub...`);
        
        const transcriptPath = `transcripts/${fileName}`;
        
        // جلب SHA الحالي للملف (إذا كان موجود)
        const getCurrentSHA = () => {
            return new Promise((resolve, reject) => {
                const options = {
                    hostname: 'api.github.com',
                    path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${transcriptPath}`,
                    method: 'GET',
                    headers: {
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'User-Agent': 'Ticket-Bot',
                        'Accept': 'application/vnd.github.v3+json'
                    }
                };
                
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            const json = JSON.parse(data);
                            resolve(json.sha);
                        } else {
                            resolve(null);
                        }
                    });
                });
                
                req.on('error', reject);
                req.end();
            });
        };
        
        const sha = await getCurrentSHA();
        
        // رفع الملف
        const uploadFile = (sha) => {
            return new Promise((resolve, reject) => {
                const base64Content = Buffer.from(content).toString('base64');
                const payload = JSON.stringify({
                    message: `Add transcript: ${fileName}`,
                    content: base64Content,
                    sha: sha
                });
                
                const options = {
                    hostname: 'api.github.com',
                    path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${transcriptPath}`,
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'User-Agent': 'Ticket-Bot',
                        'Content-Type': 'application/json',
                        'Accept': 'application/vnd.github.v3+json'
                    }
                };
                
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200 || res.statusCode === 201) {
                            resolve(true);
                        } else {
                            reject(new Error(`GitHub API Error: ${res.statusCode} - ${data}`));
                        }
                    });
                });
                
                req.on('error', reject);
                req.write(payload);
                req.end();
            });
        };
        
        await uploadFile(sha);
        console.log(`✅ تم رفع الترانسكربت ${fileName} على GitHub بنجاح!`);
        
    } catch (error) {
        console.error(`❌ خطأ في رفع الترانسكربت على GitHub: ${error.message}`);
    }
}

// تحميل ملف من رابط
function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const file = fs.createWriteStream(filepath);
        protocol.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(filepath);
            });
        }).on('error', (err) => {
            fs.unlink(filepath, () => {});
            reject(err);
        });
    });
}

function fetchHtmlFromUrl(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
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

async function saveTicketToSupabase(ticketData) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return;
    }
    try {
        let empId = null;
        let empPoints = 0;
        let empDcPoints = 0;
        let empTickets = 0;
        let empName = 'Unassigned';
        const ptsToAward = ticketData.claimedBy ? 5 : 0;

        if (ticketData.claimedBy) {
            const isDiscordId = /^\d{15,22}$/.test(ticketData.claimedBy);
            let empPath = '/rest/v1/employees?discord_id=eq.' + ticketData.claimedBy;
            if (!isDiscordId) {
                const cleanName = ticketData.claimedBy.replace(/^@/, '').trim();
                empPath = '/rest/v1/employees?name=ilike.' + encodeURIComponent(cleanName);
            }
            const empUrl = new URL(SUPABASE_URL + empPath);

            const empRes = await new Promise((resolve) => {
                const options = {
                    hostname: empUrl.hostname,
                    path: empUrl.pathname + empUrl.search,
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
                        try { resolve(JSON.parse(body)); } catch(e) { resolve([]); }
                    });
                });
                req.on('error', () => resolve([]));
                req.end();
            });

            let emp = null;
            if (Array.isArray(empRes) && empRes.length > 0) {
                emp = empRes[0];
            } else if (isDiscordId) {
                try {
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (guild) {
                        const member = await guild.members.fetch(ticketData.claimedBy);
                        if (member) {
                            const hasStaffRole = member.roles.cache.has(STAFF_ROLE_ID);
                            if (hasStaffRole) {
                                const newId = Math.floor(100000000 + Math.random() * 900000000);
                                const displayName = member.displayName;
                                const newEmp = {
                                    id: newId,
                                    name: displayName,
                                    discord_id: ticketData.claimedBy,
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
                                        res.on('data', () => {});
                                        res.on('end', () => resolveInsert());
                                    });
                                    req.on('error', () => resolveInsert());
                                    req.write(insertPayload);
                                    req.end();
                                });
                                emp = newEmp;
                            }
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }

            if (emp) {
                empId = emp.id;
                empPoints = emp.points || 0;
                empDcPoints = emp.dc_points || 0;
                empTickets = emp.tickets || 0;
                empName = emp.name;
            }
        }

        if (empId && ptsToAward > 0) {
            const newPoints = empPoints + ptsToAward;
            const newDcPoints = empDcPoints + ptsToAward;
            const newTickets = empTickets + 1;
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
                    res.on('data', () => {});
                    res.on('end', () => resolve());
                });
                req.on('error', () => resolve());
                req.write(patchPayload);
                req.end();
            });

            try {
                const logPayload = JSON.stringify({
                    action_type: 'Ticket Closed',
                    details: `Handled ticket ${ticketData.ticketName} (+${ptsToAward} PTS)`,
                    category: 'Tickets',
                    user_name: empName,
                    created_at: new Date().toISOString()
                });
                const logUrl = new URL(SUPABASE_URL + '/rest/v1/activity_log');
                await new Promise((resolve) => {
                    const options = {
                        hostname: logUrl.hostname,
                        path: logUrl.pathname,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'apikey': SUPABASE_KEY,
                            'Authorization': 'Bearer ' + SUPABASE_KEY,
                            'Prefer': 'return=minimal',
                            'Content-Length': Buffer.byteLength(logPayload)
                        }
                    };
                    const req = https.request(options, () => resolve());
                    req.on('error', () => resolve());
                    req.write(logPayload);
                    req.end();
                });
            } catch (e) {}
        }

        const ticketPayload = JSON.stringify({
            ticket_id: ticketData.ticketName,
            title: ticketData.panelName || 'Support Request',
            emp_id: empId,
            status: 'closed',
            pts: ptsToAward,
            response_time: ticketData.responseTime || 'N/A',
            created_at: ticketData.timestamp
        });
        const insertUrl = new URL(SUPABASE_URL + '/rest/v1/tickets');
        await new Promise((resolve) => {
            const options = {
                hostname: insertUrl.hostname,
                path: insertUrl.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_KEY,
                    'Prefer': 'return=minimal',
                    'Content-Length': Buffer.byteLength(ticketPayload)
                }
            };
            const req = https.request(options, res => {
                res.on('data', () => {});
                res.on('end', () => resolve());
            });
            req.on('error', () => resolve());
            req.write(ticketPayload);
            req.end();
        });
    } catch (err) {}
}

// عند تشغيل البوت
client.once('ready', () => {
    console.log('🤖 البوت شغال!');
    console.log(`📝 اسم البوت: ${client.user.tag}`);
    console.log(`📊 يراقب الروم: ${LOGGING_CHANNEL_ID}`);
    console.log(`📁 مجلد الترانسكربتات: ${TRANSCRIPTS_FOLDER}`);
    console.log('⏳ في انتظار رسائل الترانسكربت...');
    console.log('---');
    // جلب الأعضاء مرة واحدة عند البداية لملء الكاش
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
        guild.members.fetch().then(() => {
            console.log('✅ تم تحميل الأعضاء في الكاش:', guild.members.cache.size);
            updateOnlineAdmins();
        }).catch(e => console.error('fetch members error:', e.message));
    }
    // تحديث كل دقيقة من الكاش (بدون fetch)
    setInterval(updateOnlineAdmins, 60 * 1000);
    
    // جلب MC Status كل دقيقة
    fetchMCStatus();
    setInterval(fetchMCStatus, 60 * 1000);
    
    // جلب Discord Stats كل 16 ثانية
    fetchDiscordStats();
    setInterval(fetchDiscordStats, 16 * 1000);
});

// ==========================================
// جلب MC Server Status من Channel Topic + Embed
// ==========================================
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
        
        // === طريقة 1: قراءة من Channel Topic (mc-logs) ===
        const logsChannel = client.channels.cache.get(MC_LOGS_CHANNEL_ID);
        if (logsChannel && logsChannel.topic) {
            const topic = logsChannel.topic;
            console.log('📋 MC Logs Topic:', topic);
            
            // Players Online: "0/100 players online"
            const playersMatch = topic.match(/(\d+)\/(\d+)\s*players?\s*online/i);
            if (playersMatch) {
                mcData.playersOnline = playersMatch[1];
                mcData.maxPlayers = playersMatch[2];
                mcData.serverStatus = parseInt(playersMatch[1]) >= 0 ? 'Online' : 'Offline';
            }
            
            // Unique Players: "3 unique players ever joined"
            const uniqueMatch = topic.match(/(\d+)\s*unique\s*players?/i);
            if (uniqueMatch) {
                mcData.uniquePlayers = uniqueMatch[1];
                mcData.totalLogins = uniqueMatch[1]; // استخدمه كـ total logins
            }
            
            // Uptime: "Server online for 6470 minutes"
            const uptimeMatch = topic.match(/online\s*for\s*(\d+)\s*minutes?/i);
            if (uptimeMatch) {
                const mins = parseInt(uptimeMatch[1]);
                const hours = Math.floor(mins / 60);
                const remainMins = mins % 60;
                mcData.uptime = hours + 'h ' + remainMins + 'm';
                mcData.serverStatus = 'Online';
            }
        }
        
        // === طريقة 2: قراءة من Embed (server-status) للبيانات الإضافية ===
        try {
            let statusChannel = client.channels.cache.get(MC_STATUS_CHANNEL_ID);
            
            // إذا القناة مو في الكاش، جلبها
            if (!statusChannel) {
                statusChannel = await client.channels.fetch(MC_STATUS_CHANNEL_ID);
            }
            
            if (statusChannel) {
                const message = await statusChannel.messages.fetch(MC_STATUS_MESSAGE_ID);
                console.log('📨 Embed found, fields:', message.embeds[0]?.fields?.length || 0);
                
                if (message && message.embeds && message.embeds.length > 0) {
                    const embed = message.embeds[0];
                    
                    // قراءة من description إذا موجود
                    if (embed.description) {
                        const desc = embed.description;
                        
                        // Server Ping
                        const pingMatch = desc.match(/Server Ping[^\d]*(\d+)/i);
                        if (pingMatch) mcData.serverPing = pingMatch[1] + 'ms';
                        
                        // Health
                        const healthMatch = desc.match(/Health[^\d]*([\d.]+)/i);
                        if (healthMatch) mcData.health = healthMatch[1] + '%';
                        
                        // Peak Players
                        const peakMatch = desc.match(/Peak Players[^\d]*(\d+)/i);
                        if (peakMatch) mcData.peakPlayers = peakMatch[1];
                        
                        // Total Logins
                        const loginsMatch = desc.match(/Total Logins[^\d]*(\d+)/i);
                        if (loginsMatch) mcData.totalLogins = loginsMatch[1];
                        
                        // Availability
                        const availMatch = desc.match(/Availability[^\d]*([\d.]+)/i);
                        if (availMatch) mcData.availability = availMatch[1] + '%';
                        
                        // Server IP
                        const ipMatch = desc.match(/Server IP[^\d]*([\d.:]+)/i);
                        if (ipMatch) mcData.serverIP = ipMatch[1];
                    }
                    
                    // قراءة من fields إذا موجودة
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
        
        // حفظ في Supabase
        await saveToSupabase('mc_status', mcData);
        console.log('✅ MC Status:', mcData.playersOnline + '/' + mcData.maxPlayers, '|', mcData.serverStatus, '| Ping:', mcData.serverPing, '| Uptime:', mcData.uptime);
        
    } catch (err) {
        console.error('❌ خطأ في جلب MC Status:', err.message);
    }
}

// ==========================================
// جلب Discord Stats + Tickets Count
// ==========================================
async function fetchDiscordStats() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;
        
        // عدد الأعضاء الأونلاين
        const onlineMembers = guild.members.cache.filter(m => 
            m.presence && ['online', 'dnd', 'idle'].includes(m.presence.status)
        ).size;
        
        // جلب عدد التكتات المفتوحة من الكيتاغوري (طرح 2 للمستثنى)
        const ticketCategory = guild.channels.cache.get(TICKET_CATEGORY_ID);
        let openTickets = 0;
        if (ticketCategory && ticketCategory.children) {
            openTickets = Math.max(0, ticketCategory.children.cache.size - 2);
        }
        
        // جلب عدد التكتات الكلي من Supabase (اختياري للعرض)
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
                        } catch(e) {
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
        } catch(e) {
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
        
        // تحديث رسالة الدسكورد (English Embed)
        await updateDiscordStatsEmbed(guild, dcData);
        
        console.log('✅ DC Status updated:', onlineMembers + '/' + guild.memberCount, 'online |', openTickets, 'open tickets');
        
    } catch (err) {
        console.error('❌ خطأ في جلب DC Stats:', err.message);
    }
}

async function updateDiscordStatsEmbed(guild, data) {
    try {
        const channel = client.channels.cache.get(DC_STATS_CHANNEL_ID) || await client.channels.fetch(DC_STATS_CHANNEL_ID);
        if (!channel) return;

        // تصميم الـ Embed الشامل والفخم - كلام بشري بسيط
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

        // إرسال رسالة جديدة كل مرة (نظام اللوق المتتابع)
        await channel.send({ embeds: [embed] });

    } catch (e) {
        console.warn('⚠️ Log Sync Error:', e.message);
    }
}

// ==========================================
// حفظ في Supabase (عام)
// ==========================================
async function saveToSupabase(key, data) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('❌ SUPABASE credentials ناقصة!');
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
                    // Try INSERT if PATCH fails (row doesn't exist)
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

// Insert new row to Supabase
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

// عند تغيير حالة عضو — debounce دقيقتين لتجنب الإزعاج
client.on('presenceUpdate', () => {
    scheduleOnlineUpdate(120000);
});

// عند استقبال رسالة
// Helpers
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

function extractTicketOwner(fullText) {
    let match = fullText.match(/(?:Ticket Owner|Owner|User|Created by)[^\d<]*<@!?(\d+)>/i);
    if (match) return match[1];

    match = fullText.match(/(?:Ticket Owner|Owner|User|Created by)[^\d]*(\d{15,22})/i);
    if (match) return match[1];

    return null;
}

function extractClaimedBy(fullText, transcriptContent) {
    let match = fullText.match(/(?:Closed|Claimed|Handled)\s*[Bb]y[^\d<:]*[:\s]*<@!?(\d+)>/i);
    if (match) return match[1];

    match = fullText.match(/(?:Closed|Claimed|Handled)\s*[Bb]y[^\d]*(\d{15,22})/i);
    if (match) return match[1];

    match = fullText.match(/(?:Closed|Claimed|Handled)\s*[Bb]y[^\d<:]*[:\s]*@?([^\n\r(]+)/i);
    if (match) {
        const name = match[1].trim();
        if (name && name.length > 2 && !name.toLowerCase().includes('unknown')) {
            return name;
        }
    }

    if (transcriptContent) {
        match = transcriptContent.match(/[Tt]icket claimed by[^\d]*?(\d{15,20})/);
        if (match) return match[1];

        match = transcriptContent.match(/[Cc]losed by[^\d]*?(\d{15,20})/);
        if (match) return match[1];
    }

    return null;
}

// Handler
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
                await message.channel.send(`⏳ جاري الإرسال لسيرفر: ${targetGuild.name}...`);
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
                            console.log(`✅ أرسلت لـ: ${member.user.username}`);
                        } catch (err) {
                            console.error(`❌ فشل الإرسال لـ: ${member.user.username}`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                await message.channel.send(`تم الانتهاء من البرودكاست لسيرفر ${targetGuild.name} ✅`);
            } catch (err) {
                console.error(err);
                await message.channel.send(`❌ حدث خطأ أثناء إرسال البرودكاست: ${err.message}`);
            }
        } else {
            await message.channel.send("❌ خطأ: لم أجد السيرفر أو الرسالة فارغة.");
        }
        return;
    }

    if (message.channel.id === LOGGING_CHANNEL_ID && message.author.bot) {
        console.log('📬 رسالة جديدة من بوت في روم الـ Logging!');
        console.log('📝 اسم البوت:', message.author.username);

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
                embed.fields.forEach(F => {
                    fullText += '\n' + (F.name || '') + '\n' + (F.value || '');
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
            console.log(`📎 تم العثور على رابط/ملف ترانسكربت: ${transcriptUrl || attachmentUrl}`);

            let transcriptContent = '';
            try {
                if (attachmentUrl && cleanFileName) {
                    const filePath = path.join(TRANSCRIPTS_FOLDER, cleanFileName);
                    await downloadFile(attachmentUrl, filePath);
                    transcriptContent = fs.readFileSync(filePath, 'utf8');
                    await uploadTranscriptToGitHub(cleanFileName, transcriptContent);
                } else if (transcriptUrl && (transcriptUrl.includes('https://') || transcriptUrl.includes('http://'))) {
                    transcriptContent = await fetchHtmlFromUrl(transcriptUrl);
                    const parsedName = extractTicketName(fullText, transcriptUrl);
                    const fileName = `${parsedName}.html`.replace(/[^a-zA-Z0-9.-]/g, '_');
                    const filePath = path.join(TRANSCRIPTS_FOLDER, fileName);
                    fs.writeFileSync(filePath, transcriptContent, 'utf8');
                    await uploadTranscriptToGitHub(fileName, transcriptContent);
                }
            } catch (err) {
                console.error('Error fetching/processing transcript:', err.message);
            }

            const ticketName = extractTicketName(fullText, transcriptUrl);
            const ticketOwnerId = extractTicketOwner(fullText);
            const claimedBy = extractClaimedBy(fullText, transcriptContent);

            let panelName = 'Ticket';
            if (ticketName && ticketName.includes('-')) {
                const firstPart = ticketName.split('-')[0];
                panelName = firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
            }

            const userMatches = fullText.match(/<@!?\d+>/g);
            const users = userMatches ? [...new Set(userMatches)] : [];

            let finalTranscriptPath = null;
            if (cleanFileName) {
                finalTranscriptPath = `transcripts/${cleanFileName}`;
            } else {
                finalTranscriptPath = `transcripts/${ticketName.replace(/[^a-zA-Z0-9.-]/g, '_')}.html`;
            }

            const ticketData = {
                timestamp: new Date().toISOString(),
                ticketOwner: ticketOwnerId ? `<@${ticketOwnerId}>` : null,
                ticketOwnerId: ticketOwnerId,
                ticketName: ticketName,
                panelName: panelName,
                transcriptFile: finalTranscriptPath,
                claimedBy: claimedBy,
                users: users,
                responseTime: 'N/A'
            };

            const respMatch = fullText.match(/(?:Response Time|Response)[^\n\r`]*`?([^`\n\r]+)/i);
            if (respMatch) {
                ticketData.responseTime = respMatch[1].trim();
            }

            if (ticketOwnerId) {
                try {
                    const member = message.guild.members.cache.get(ticketOwnerId);
                    if (member) {
                        ticketData.ticketOwnerName = member.user.username;
                        ticketData.ticketOwnerDisplay = member.displayName;
                    }
                } catch(E) {}
            }

            const tickets = loadTickets();
            tickets.unshift(ticketData);
            saveTickets(tickets);

            await saveTicketToSupabase(ticketData);

            console.log(`✅ تم حفظ التكت بنجاح: ${ticketName}`);
            console.log('---\n');
        } else {
            console.log('⚠️ لم يتم العثور على رابط أو ملف ترانسكربت في الرسالة.');
        }
    }
});

// تسجيل الدخول
console.log('🔄 جاري تسجيل الدخول...');
client.login(DISCORD_TOKEN).catch(err => {
    console.error('❌ خطأ في تسجيل الدخول:', err.message);
    process.exit(1);
});
