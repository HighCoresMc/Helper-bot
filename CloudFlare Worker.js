const REDIRECT_URI = 'https://admin.highcores.co/';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const CLIENT_ID = env.DISCORD_CLIENT_ID;
    const CLIENT_SECRET = env.DISCORD_CLIENT_SECRET;
    const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
    const GUILD_ID = env.DISCORD_GUILD_ID;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/discord/callback' && request.method === 'POST') {
      try {
        const { code } = await request.json();
        if (!code) return jsonResp({ error: 'No code provided' }, 400);

        const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
          }),
        });

        const tokenData = await tokenRes.json();

        if (!tokenRes.ok || tokenData.error) {
          return jsonResp({
            error: tokenData.error_description || tokenData.error || 'Token exchange failed',
            details: tokenData,
          }, 400);
        }

        const userRes = await fetch('https://discord.com/api/v10/users/@me', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        });

        const user = await userRes.json();

        let guildMember = null;
        let guildRoles = [];

        const memberRes = await fetch(
          `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${user.id}`,
          {
            headers: {
              Authorization: `Bot ${BOT_TOKEN}`,
            },
          }
        );

        if (memberRes.ok) {
          guildMember = await memberRes.json();

          const rolesRes = await fetch(
            `https://discord.com/api/v10/guilds/${GUILD_ID}/roles`,
            {
              headers: {
                Authorization: `Bot ${BOT_TOKEN}`,
              },
            }
          );

          if (rolesRes.ok) {
            const allRoles = await rolesRes.json();

            guildRoles = allRoles
              .filter(role => guildMember.roles.includes(role.id))
              .map(role => ({
                id: role.id,
                name: role.name,
                color: role.color
                  ? '#' + role.color.toString(16).padStart(6, '0')
                  : null,
                position: role.position,
              }))
              .sort((a, b) => b.position - a.position);
          }
        }

        const avatar = user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/0.png`;

        return jsonResp({
          success: true,
          user: {
            id: user.id,
            username: user.username,
            globalName: user.global_name || user.username,
            avatar,
            discriminator: user.discriminator,
          },
          guild: {
            nickname: guildMember?.nick || null,
            roles: guildRoles,
            joinedAt: guildMember?.joined_at || null,
          },
        });

      } catch (e) {
        return jsonResp({ error: e.message }, 500);
      }
    }

    return jsonResp({
      status: 'Discord OAuth Worker active',
      endpoints: ['/discord/callback'],
    });
  },
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
  });
}