const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

// إعدادات البوت من متغيرات البيئة
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOGGING_CHANNEL_ID = process.env.LOGGING_CHANNEL_ID;
const TICKETS_FILE = path.join(__dirname, '../tickets.js');
const TRANSCRIPTS_FOLDER = path.join(__dirname, '../transcripts');

// إعدادات MC Server Status
const MC_STATUS_CHANNEL_ID = process.env.MC_STATUS_CHANNEL_ID || '1487139736748425236';
const MC_STATUS_MESSAGE_ID = process.env.MC_STATUS_MESSAGE_ID || 'your_status_message_id_here';
const MC_LOGS_CHANNEL_ID = process.env.MC_LOGS_CHANNEL_ID || '1487148944667578368';

// إعدادات GitHub من متغيرات البيئة
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH = 'tickets.js';

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
    
    // جلب Discord Stats كل 5 دقائق
    fetchDiscordStats();
    setInterval(fetchDiscordStats, 5 * 60 * 1000);
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
        
        // جلب عدد التكتات من Supabase
        let openTickets = 0;
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
            lastUpdated: new Date().toISOString()
        };
        
        await saveToSupabase('dc_status', dcData);
        console.log('✅ DC Status updated:', onlineMembers + '/' + guild.memberCount, 'online |', openTickets, 'open tickets');
        
    } catch (err) {
        console.error('❌ خطأ في جلب DC Stats:', err.message);
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
client.on('messageCreate', async (message) => {
    // قبول رسائل البوتات في روم الـ Logging فقط
    if (message.channel.id === LOGGING_CHANNEL_ID && message.author.bot) {
        console.log('📬 رسالة جديدة من بوت في روم الـ Logging!');
        console.log('📝 اسم البوت:', message.author.username);
            
            // التحقق من وجود Embed
            if (message.embeds && message.embeds.length > 0) {
                const embed = message.embeds[0];
                
                // التحقق من وجود معلومات التكت
                const hasTicketInfo = embed.fields && embed.fields.some(f => 
                    f.name.includes('Ticket Owner') || 
                    f.name.includes('Ticket Name')
                );

                if (hasTicketInfo) {
                    console.log('\n📩 تم اكتشاف تكت جديد!');
                    
                    // استخراج المعلومات
                    const ticketData = {
                        timestamp: new Date().toISOString(),
                        ticketOwner: null,
                        ticketOwnerId: null,
                        ticketName: null,
                        panelName: null,
                        transcriptFile: null,
                        claimedBy: null,
                        users: []
                    };
                    
                    // استخراج المعلومات من Fields
                    embed.fields.forEach(field => {
                        const fieldName = field.name;
                        const fieldValue = field.value;

                        if (fieldName.includes('Ticket Owner')) {
                            const match = fieldValue.match(/<@(\d+)>/);
                            if (match) {
                                ticketData.ticketOwnerId = match[1];
                                ticketData.ticketOwner = fieldValue;
                                // جلب اسم اليوزر من Discord
                                try {
                                    const member = message.guild.members.cache.get(match[1]);
                                    if (member) {
                                        ticketData.ticketOwnerName = member.user.username;
                                        ticketData.ticketOwnerDisplay = member.displayName;
                                    }
                                } catch(e) {}
                            }
                        }

                        if (fieldName.includes('Ticket Name')) {
                            ticketData.ticketName = fieldValue;
                        }

                        if (fieldName.includes('Panel Name')) {
                            ticketData.panelName = fieldValue;
                        }

                        if (fieldName.toLowerCase().includes('claimed') || fieldName.toLowerCase().includes('claim')) {
                            const match = fieldValue.match(/<@!?(\d+)>/);
                            if (match) ticketData.claimedBy = match[1];
                        }

                        if (fieldName.includes('Users in transcript')) {
                            const userMatches = fieldValue.match(/<@!?\d+>/g);
                            if (userMatches) {
                                // حفظ الـ mentions كاملة مع <@> وإزالة التكرار
                                ticketData.users = [...new Set(userMatches)];
                            }
                        }
                    });
                    
                    // البحث عن ملف HTML مرفق
                    if (message.attachments && message.attachments.size > 0) {
                        const htmlAttachment = message.attachments.find(att => 
                            att.name && att.name.endsWith('.html')
                        );
                        
                        if (htmlAttachment) {
                            console.log(`📎 تم العثور على ملف: ${htmlAttachment.name}`);
                            
                            try {
                                // تنظيف اسم الملف
                                const cleanFileName = htmlAttachment.name.replace(/[^a-zA-Z0-9.-]/g, '_');
                                const filePath = path.join(TRANSCRIPTS_FOLDER, cleanFileName);
                                
                                // تحميل الملف
                                console.log('⬇️ جاري تحميل الملف...');
                                await downloadFile(htmlAttachment.url, filePath);
                                console.log(`✅ تم تحميل الملف: ${cleanFileName}`);
                                
                                // رفع الترانسكربت على GitHub
                                const transcriptContent = fs.readFileSync(filePath, 'utf8');
                                await uploadTranscriptToGitHub(cleanFileName, transcriptContent);
                                
                                // حفظ مسار الملف النسبي
                                ticketData.transcriptFile = `transcripts/${cleanFileName}`;

                                // استخراج الكلايمر من محتوى الترانسكربت
                                const claimMatch = transcriptContent.match(/[Tt]icket claimed by[^\d]*?(\d{15,20})/);
                                if (claimMatch) {
                                    ticketData.claimedBy = claimMatch[1];
                                    console.log(`✅ الكلايمر: ${ticketData.claimedBy}`);
                                }
                                
                            } catch (error) {
                                console.error('❌ خطأ في تحميل الملف:', error.message);
                            }
                        }
                    }
                    
                    // التحقق من اكتمال المعلومات
                    if (ticketData.ticketName && ticketData.transcriptFile) {
                        const tickets = loadTickets();
                        tickets.unshift(ticketData);
                        saveTickets(tickets);
                        
                        console.log(`✅ تم حفظ التكت: ${ticketData.ticketName}`);
                        console.log(`📄 الملف: ${ticketData.transcriptFile}`);
                        console.log('---\n');
                    } else {
                        console.log('⚠️ البيانات غير مكتملة - لن يتم الحفظ');
                        if (!ticketData.ticketName) console.log('   - اسم التكت ناقص');
                        if (!ticketData.transcriptFile) console.log('   - ملف الترانسكربت ناقص');
                        console.log('---\n');
                    }
                }
            }
    }
});

// تسجيل الدخول
console.log('🔄 جاري تسجيل الدخول...');
client.login(DISCORD_TOKEN).catch(err => {
    console.error('❌ خطأ في تسجيل الدخول:', err.message);
    process.exit(1);
});
