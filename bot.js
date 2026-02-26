// TTTIW Discord Bot
// Listens for match results in the format: [winner] [loser] ##-##
// e.g. "John Jane 3-1" or "John Jane 11-9"
// Then updates Firestore ratings and posts a full match summary.
//
// Setup:
//   npm install discord.js firebase-admin
//   node bot.js

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;         // your bot token
const CHANNEL_ID    = process.env.CHANNEL_ID || null;    // restrict to one channel, or null for all
const FIREBASE_PROJECT_ID = 'tttiw-6d44e';

// ── FIREBASE ADMIN INIT ───────────────────────────────────────────────────────
// Requires GOOGLE_APPLICATION_CREDENTIALS env var pointing to your service account JSON
// OR set FIREBASE_SERVICE_ACCOUNT to the JSON string directly
let firebaseCredential;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  firebaseCredential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
} else {
  firebaseCredential = cert(process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

initializeApp({ credential: firebaseCredential, projectId: FIREBASE_PROJECT_ID });
const db = getFirestore();

// ── GLICKO-2 CONSTANTS (must match index.html) ────────────────────────────────
const SCALE         = 173.7178;
const SIGMA_DEFAULT = 0.06;
const SIGMA_MAX     = 0.30;
const TAU           = 1.2;
const EPSILON       = 0.000001;
const RD_MAX        = 200;

function toG2(r, rd)      { return { mu: (r - 1500) / SCALE, phi: rd / SCALE }; }
function fromG2(mu, phi)  { return { r: mu * SCALE + 1500, rd: phi * SCALE }; }
function gPhi(phi)        { return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI)); }
function E(mu, muj, phij) { return 1 / (1 + Math.exp(-gPhi(phij) * (mu - muj))); }

function computeNewSigma(sigma, phi, v, delta) {
  const a = Math.log(sigma * sigma);
  const tau2 = TAU * TAU, phi2 = phi * phi, delta2 = delta * delta;
  const f = x => {
    const ex = Math.exp(x), d2 = phi2 + v + ex;
    return (ex * (delta2 - phi2 - v - ex)) / (2 * d2 * d2) - (x - a) / tau2;
  };
  let A = a, B = delta2 > phi2 + v ? Math.log(delta2 - phi2 - v) : (() => {
    let k = 1; while (f(a - k * TAU) < 0) k++; return a - k * TAU;
  })();
  let fA = f(A), fB = f(B), iterations = 0;
  while (Math.abs(B - A) > EPSILON && iterations < 500) {
    const C = A + (A - B) * fA / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
    B = C; fB = fC; iterations++;
  }
  return Math.exp(A / 2);
}

function g2Update(player, opps) {
  const { mu, phi } = toG2(player.rating, player.rd);
  const sigma = player.sigma || SIGMA_DEFAULT;
  if (!opps.length) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    const r = fromG2(mu, Math.min(phiStar, RD_MAX / SCALE));
    return { rating: Math.round(r.r * 10) / 10, rd: Math.round(r.rd * 10) / 10, sigma };
  }
  let vInv = 0, deltaSum = 0;
  for (const o of opps) {
    const { mu: muj, phi: phij } = toG2(o.rating, o.rd);
    const gj = gPhi(phij), ej = E(mu, muj, phij);
    vInv += gj * gj * ej * (1 - ej);
    deltaSum += gj * (o.s - ej);
  }
  const v = 1 / vInv, delta = v * deltaSum;
  const newSigma = computeNewSigma(sigma, phi, v, delta);
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  const r = fromG2(muNew, phiNew);
  return {
    rating: Math.round(r.r * 10) / 10,
    rd:     Math.round(Math.min(r.rd, RD_MAX) * 10) / 10,
    sigma:  Math.round(Math.min(newSigma, SIGMA_MAX) * 100000) / 100000,
  };
}

// ── MATCH REGEX ───────────────────────────────────────────────────────────────
// Matches: "PlayerOne PlayerTwo 11-9"  or  "@mention @mention 3-1"
// First name = winner, second name = loser
const MATCH_RE = /^([^\s]+)\s+([^\s]+)\s+(\d{1,2})-(\d{1,2})$/i;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function r2(n) { return Math.round(n * 10) / 10; }
function signed(n) { return (n >= 0 ? '+' : '') + r2(n); }

async function findPlayer(nameOrMention) {
  // Strip Discord mention formatting <@123456>
  const stripped = nameOrMention.replace(/^<@!?(\d+)>$/, '$1');
  const snap = await db.collection('players').get();
  // Try exact name match (case-insensitive), then Discord ID match (if stored)
  for (const d of snap.docs) {
    const data = d.data();
    if (data.name?.toLowerCase() === stripped.toLowerCase()) return { id: d.id, ...data };
    if (data.discordId === stripped) return { id: d.id, ...data };
  }
  return null;
}

async function getLeaderboard() {
  const snap = await db.collection('players').get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.rd <= 100)
    .sort((a, b) => b.rating - a.rating);
}

function rankEmoji(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

// ── CORE MATCH SUBMISSION ─────────────────────────────────────────────────────
async function submitMatch(winner, loser, scoreStr) {
  return await db.runTransaction(async tx => {
    const [ws, ls] = await Promise.all([
      tx.get(db.collection('players').doc(winner.id)),
      tx.get(db.collection('players').doc(loser.id)),
    ]);
    if (!ws.exists || !ls.exists) throw new Error('Player not found in Firestore');

    const w = ws.data(), l = ls.data();

    const uw = g2Update(
      { rating: w.rating, rd: w.rd, sigma: w.sigma || SIGMA_DEFAULT },
      [{ rating: l.rating, rd: l.rd, sigma: l.sigma || SIGMA_DEFAULT, s: 1 }]
    );
    const ul = g2Update(
      { rating: l.rating, rd: l.rd, sigma: l.sigma || SIGMA_DEFAULT },
      [{ rating: w.rating, rd: w.rd, sigma: w.sigma || SIGMA_DEFAULT, s: 0 }]
    );

    const now = Date.now();

    // Check for #1 change
    const allSnap = await db.collection('players').get();
    const allP = allSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ranked = p => p.rd <= 100;
    const topBefore = allP.filter(ranked).sort((a, b) => b.rating - a.rating)[0];
    const simP = allP.map(p => {
      if (p.id === winner.id) return { ...p, rating: uw.rating, rd: uw.rd };
      if (p.id === loser.id)  return { ...p, rating: ul.rating, rd: ul.rd };
      return p;
    });
    const topAfter = simP.filter(ranked).sort((a, b) => b.rating - a.rating)[0];

    const wUpdate = { rating: uw.rating, rd: uw.rd, sigma: uw.sigma, wins: (w.wins || 0) + 1, lastMatchAt: now };
    const lUpdate = { rating: ul.rating, rd: ul.rd, sigma: ul.sigma, losses: (l.losses || 0) + 1, lastMatchAt: now };

    if (topBefore?.id !== topAfter?.id) {
      if (topBefore) {
        const oldTop = allP.find(p => p.id === topBefore.id);
        if (oldTop?.no1Since) {
          const dur = now - (oldTop.no1Since || now);
          const prev = oldTop.longestNo1Ms || 0;
          const upd = { no1Since: null };
          if (dur > prev) upd.longestNo1Ms = dur;
          if (oldTop.id === winner.id) Object.assign(wUpdate, upd);
          else if (oldTop.id === loser.id) Object.assign(lUpdate, upd);
          else await tx.update(db.collection('players').doc(oldTop.id), upd);
        }
      }
      if (topAfter) {
        const newTopData = allP.find(p => p.id === topAfter.id);
        const no1Since = newTopData?.no1Since || now;
        if (topAfter.id === winner.id) wUpdate.no1Since = no1Since;
        else if (topAfter.id === loser.id) lUpdate.no1Since = no1Since;
        else await tx.update(db.collection('players').doc(topAfter.id), { no1Since });
      }
    }

    tx.update(db.collection('players').doc(winner.id), wUpdate);
    tx.update(db.collection('players').doc(loser.id), lUpdate);

    const matchRef = db.collection('matches').doc();
    tx.set(matchRef, {
      winnerId: winner.id, loserId: loser.id,
      winnerName: w.name, loserName: l.name,
      p1id: winner.id, p2id: loser.id,
      p1name: w.name, p2name: l.name,
      score: 1,
      matchScore: scoreStr || null,
      p1delta: Math.round((uw.rating - w.rating) * 10) / 10,
      p2delta: Math.round((ul.rating - l.rating) * 10) / 10,
      p1newRD: uw.rd, p2newRD: ul.rd,
      p1newSigma: uw.sigma, p2newSigma: ul.sigma,
      p1oldRating: w.rating, p1newRating: uw.rating,
      p2oldRating: l.rating, p2newRating: ul.rating,
      source: 'discord',
      date: FieldValue.serverTimestamp(),
    });

    return { w, l, uw, ul, topBefore, topAfter, no1Change: topBefore?.id !== topAfter?.id };
  });
}

// ── BUILD DISCORD EMBED ───────────────────────────────────────────────────────
async function buildResultEmbed(winnerData, loserData, result, scoreStr) {
  const { w, l, uw, ul, no1Change, topAfter } = result;

  const wDelta = Math.round((uw.rating - w.rating) * 10) / 10;
  const lDelta = Math.round((ul.rating - l.rating) * 10) / 10;

  // Get updated leaderboard for standings
  const lb = await getLeaderboard();
  const wRank = lb.findIndex(p => p.id === winnerData.id) + 1;
  const lRank = lb.findIndex(p => p.id === loserData.id) + 1;

  // Top 5 standings
  const top5 = lb.slice(0, 5).map((p, i) => {
    const isWinner = p.id === winnerData.id;
    const isLoser  = p.id === loserData.id;
    const tag = isWinner ? ' ← W' : isLoser ? ' ← L' : '';
    return `${rankEmoji(i + 1)} **${p.name}** — ${r2(p.rating)}${tag}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xE5B25D)
    .setTitle(`⚡ ${w.name} def. ${l.name}${scoreStr ? `  ${scoreStr}` : ''}`)
    .addFields(
      {
        name: `🏆 ${w.name}`,
        value: [
          `${r2(w.rating)} → **${r2(uw.rating)}** (${signed(wDelta)})`,
          `RD: ${r2(w.rd)} → ${r2(uw.rd)}`,
          `Record: ${(w.wins || 0) + 1}W – ${w.losses || 0}L`,
          wRank ? `Rank: ${rankEmoji(wRank)}` : '',
        ].filter(Boolean).join('\n'),
        inline: true,
      },
      {
        name: `😔 ${l.name}`,
        value: [
          `${r2(l.rating)} → **${r2(ul.rating)}** (${signed(lDelta)})`,
          `RD: ${r2(l.rd)} → ${r2(ul.rd)}`,
          `Record: ${w.wins || 0}W – ${(l.losses || 0) + 1}L`,
          lRank ? `Rank: ${rankEmoji(lRank)}` : '',
        ].filter(Boolean).join('\n'),
        inline: true,
      },
      {
        name: '📊 Top 5 Standings',
        value: top5 || '_No ranked players yet_',
      }
    )
    .setFooter({ text: 'TTTIW · Table Tennis Texas InventionWorks' })
    .setTimestamp();

  if (no1Change && topAfter) {
    embed.setDescription(`👑 **New #1: ${topAfter.name}!**`);
  }

  return embed;
}

// ── DISCORD CLIENT ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`✅ TTTIW bot ready as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (CHANNEL_ID && message.channelId !== CHANNEL_ID) return;

  const content = message.content.trim();
  const match = content.match(MATCH_RE);
  if (!match) return;

  const [, winnerStr, loserStr, s1, s2] = match;
  const scoreStr = `${s1}-${s2}`;

  // Validate score — winner's score must be higher
  if (parseInt(s1) <= parseInt(s2)) {
    return message.reply(`❌ The first player is the winner — their score (${s1}) should be higher than the loser's (${s2}). Did you mean \`${loserStr} ${winnerStr} ${s2}-${s1}\`?`);
  }

  await message.channel.sendTyping();

  // Look up players
  const [winner, loser] = await Promise.all([findPlayer(winnerStr), findPlayer(loserStr)]);

  if (!winner) return message.reply(`❌ Couldn't find a player named **${winnerStr}**. Check the spelling matches their name on the leaderboard.`);
  if (!loser)  return message.reply(`❌ Couldn't find a player named **${loserStr}**. Check the spelling matches their name on the leaderboard.`);
  if (winner.id === loser.id) return message.reply(`❌ A player can't play themselves!`);

  try {
    const result = await submitMatch(winner, loser, scoreStr);
    const embed = await buildResultEmbed(winner, loser, result, scoreStr);
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Match submission error:', err);
    await message.reply(`❌ Error submitting match: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
