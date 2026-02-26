// TTTIW Discord Bot
//
// Match reporting (first player always wins):
//   inoo ath  /  inoo ath 10-8  /  inoo ath 10 8  /  inoo 10 ath 8
//
// Commands (prefix: ttt):
//   ttt help
//   ttt stats [player]
//   ttt history [player]
//   ttt rank [player]
//   ttt top
//   ttt predict [p1] [p2]
//   ttt vs [p1] [p2]
//   ttt rating farm [player]
//   ttt streak
//   ttt nemesis [player]
//   ttt rivals
//   ttt hot

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const CHANNEL_ID          = process.env.CHANNEL_ID || null;
const FIREBASE_PROJECT_ID = 'tttiw-6d44e';
const PREFIX              = 'ttt';

// ── FIREBASE ADMIN INIT ───────────────────────────────────────────────────────
let firebaseCredential;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  firebaseCredential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
} else {
  firebaseCredential = cert(process.env.GOOGLE_APPLICATION_CREDENTIALS);
}
initializeApp({ credential: firebaseCredential, projectId: FIREBASE_PROJECT_ID });
const db = getFirestore();

// ── GLICKO-2 (must match index.html) ─────────────────────────────────────────
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
  let fA = f(A), fB = f(B), itr = 0;
  while (Math.abs(B - A) > EPSILON && itr < 500) {
    const C = A + (A - B) * fA / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
    B = C; fB = fC; itr++;
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

function winProb(a, b) {
  const { mu, phi } = toG2(a.rating, a.rd);
  const { mu: muj, phi: phij } = toG2(b.rating, b.rd);
  return (E(mu, muj, phij) * 100).toFixed(1);
}

// ── MATCH PARSER ──────────────────────────────────────────────────────────────
function parseMatchMessage(content) {
  const t = content.trim().split(/\s+/);
  if (t.length === 4 && /^\d+$/.test(t[1]) && /^\d+$/.test(t[3]))
    return { winnerStr: t[0], loserStr: t[2], s1: t[1], s2: t[3] };
  if (t.length === 3 && /^\d+-\d+$/.test(t[2])) {
    const [s1, s2] = t[2].split('-');
    return { winnerStr: t[0], loserStr: t[1], s1, s2 };
  }
  if (t.length === 4 && /^\d+$/.test(t[2]) && /^\d+$/.test(t[3]))
    return { winnerStr: t[0], loserStr: t[1], s1: t[2], s2: t[3] };
  if (t.length === 2)
    return { winnerStr: t[0], loserStr: t[1], s1: null, s2: null };
  return null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function r2(n)     { return Math.round(n * 10) / 10; }
function signed(n) { return (n >= 0 ? '+' : '') + r2(n); }
function pct(w, t) { return t === 0 ? 'N/A' : (w / t * 100).toFixed(1) + '%'; }

function rankEmoji(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function footer() { return { text: 'TTTIW · Table Tennis Texas InventionWorks' }; }

async function getAllPlayers() {
  const snap = await db.collection('players').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getAllMatches() {
  const snap = await db.collection('matches').orderBy('date', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function findPlayer(nameOrMention) {
  const stripped = nameOrMention.replace(/^<@!?(\d+)>$/, '$1');
  const players = await getAllPlayers();
  return players.find(p =>
    p.name?.toLowerCase() === stripped.toLowerCase() ||
    p.discordId === stripped
  ) || null;
}

async function getLeaderboard() {
  const players = await getAllPlayers();
  return players.filter(p => p.rd <= 100).sort((a, b) => b.rating - a.rating);
}

function calcStreak(pid, matchesSortedDesc) {
  let streak = 0;
  for (const m of matchesSortedDesc) {
    if (m.winnerId !== pid && m.loserId !== pid) continue;
    if (m.winnerId === pid) streak++;
    else break;
  }
  return streak;
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
          const upd = { no1Since: null };
          if (dur > (oldTop.longestNo1Ms || 0)) upd.longestNo1Ms = dur;
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
      score: 1, matchScore: scoreStr || null,
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

// ── MATCH RESULT EMBED ────────────────────────────────────────────────────────
async function buildResultEmbed(winnerData, loserData, result, scoreStr) {
  const { w, l, uw, ul, no1Change, topAfter } = result;
  const wDelta = Math.round((uw.rating - w.rating) * 10) / 10;
  const lDelta = Math.round((ul.rating - l.rating) * 10) / 10;

  const lb = await getLeaderboard();
  const wRank = lb.findIndex(p => p.id === winnerData.id) + 1;
  const lRank = lb.findIndex(p => p.id === loserData.id) + 1;

  const top5 = lb.slice(0, 5).map((p, i) => {
    const tag = p.id === winnerData.id ? ' <- W' : p.id === loserData.id ? ' <- L' : '';
    return `${rankEmoji(i + 1)} **${p.name}** -- ${r2(p.rating)}${tag}`;
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
          `Record: ${l.wins || 0}W – ${(l.losses || 0) + 1}L`,
          lRank ? `Rank: ${rankEmoji(lRank)}` : '',
        ].filter(Boolean).join('\n'),
        inline: true,
      },
      { name: '📊 Top 5 Standings', value: top5 || '_No ranked players yet_' }
    )
    .setFooter(footer())
    .setTimestamp();

  if (no1Change && topAfter) embed.setDescription(`👑 **New #1: ${topAfter.name}!**`);
  return embed;
}

// ── COMMAND: ttt help ─────────────────────────────────────────────────────────
async function cmdHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(0xE5B25D)
    .setTitle('🏓 TTTIW Bot Commands')
    .addFields(
      {
        name: '📥 Reporting a Match',
        value: [
          '`[winner] [loser]` — no score',
          '`[winner] [loser] 10-8` — with dash',
          '`[winner] [loser] 10 8` — with space',
          '`[winner] 10 [loser] 8` — interleaved',
          '_First player is always the winner_',
        ].join('\n'),
      },
      {
        name: '👤 Player Info',
        value: [
          '`ttt stats [player]` — full profile',
          '`ttt history [player]` — last 5 matches',
          '`ttt rank [player]` — current rank & rating',
        ].join('\n'),
        inline: true,
      },
      {
        name: '🏆 Leaderboard',
        value: '`ttt top` — full leaderboard',
        inline: true,
      },
      {
        name: '📊 Match Tools',
        value: [
          '`ttt predict [p1] [p2]` — win odds + elo outcomes',
          '`ttt vs [p1] [p2]` — head-to-head record',
          '`ttt rating farm [player]` — best targets for elo gain',
        ].join('\n'),
      },
      {
        name: '🔥 Fun & Social',
        value: [
          '`ttt streak` — longest current win streaks',
          '`ttt nemesis [player]` — who beats them the most',
          '`ttt rivals` — most played matchups',
          '`ttt hot` — most elo gained this week',
        ].join('\n'),
      }
    )
    .setFooter(footer());
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt stats [player] ───────────────────────────────────────────────
async function cmdStats(message, args) {
  if (!args.length) return message.reply('Usage: `ttt stats [player]`');
  const player = await findPlayer(args[0]);
  if (!player) return message.reply(`❌ Player not found: **${args[0]}**`);

  const matches = await getAllMatches();
  const myMatches = matches.filter(m => m.winnerId === player.id || m.loserId === player.id);
  const wins = myMatches.filter(m => m.winnerId === player.id).length;
  const losses = myMatches.filter(m => m.loserId === player.id).length;
  const streak = calcStreak(player.id, myMatches);

  const lb = await getLeaderboard();
  const rank = lb.findIndex(p => p.id === player.id) + 1;

  const embed = new EmbedBuilder()
    .setColor(0xE5B25D)
    .setTitle(`👤 ${player.name}`)
    .addFields(
      { name: 'Rating',   value: `**${r2(player.rating)}** (RD ${r2(player.rd)})`, inline: true },
      { name: 'Rank',     value: rank ? rankEmoji(rank) : '_Unranked_',             inline: true },
      { name: 'Record',   value: `${wins}W – ${losses}L`,                           inline: true },
      { name: 'Win Rate', value: pct(wins, wins + losses),                          inline: true },
      { name: 'Matches',  value: String(wins + losses),                             inline: true },
      { name: 'Streak',   value: streak > 0 ? `🔥 ${streak} wins` : '—',           inline: true },
    )
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt history [player] ─────────────────────────────────────────────
async function cmdHistory(message, args) {
  if (!args.length) return message.reply('Usage: `ttt history [player]`');
  const player = await findPlayer(args[0]);
  if (!player) return message.reply(`❌ Player not found: **${args[0]}**`);

  const matches = await getAllMatches();
  const myMatches = matches
    .filter(m => m.winnerId === player.id || m.loserId === player.id)
    .slice(0, 5);

  if (!myMatches.length) return message.reply(`No matches found for **${player.name}**.`);

  const lines = myMatches.map(m => {
    const won = m.winnerId === player.id;
    const opp = won ? m.loserName : m.winnerName;
    const delta = won ? m.p1delta : m.p2delta;
    const score = m.matchScore ? ` ${m.matchScore}` : '';
    const ts = m.date?.toDate ? m.date.toDate() : new Date(m.date);
    const date = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${won ? '✅' : '❌'} **${won ? 'W' : 'L'}** vs ${opp}${score}  (${signed(delta)})  · ${date}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xE5B25D)
    .setTitle(`📋 Last 5 matches — ${player.name}`)
    .setDescription(lines)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt rank [player] ────────────────────────────────────────────────
async function cmdRank(message, args) {
  if (!args.length) return message.reply('Usage: `ttt rank [player]`');
  const player = await findPlayer(args[0]);
  if (!player) return message.reply(`❌ Player not found: **${args[0]}**`);

  const lb = await getLeaderboard();
  const rank = lb.findIndex(p => p.id === player.id) + 1;

  if (!rank) return message.reply(`**${player.name}** is currently unranked (RD too high).`);
  await message.reply(`${rankEmoji(rank)} **${player.name}** is ranked **#${rank}** with a rating of **${r2(player.rating)}**`);
}

// ── COMMAND: ttt top ──────────────────────────────────────────────────────────
async function cmdTop(message) {
  const lb = await getLeaderboard();
  if (!lb.length) return message.reply('No ranked players yet.');

  const lines = lb.map((p, i) => {
    const wins = p.wins || 0, losses = p.losses || 0;
    return `${rankEmoji(i + 1)} **${p.name}** — ${r2(p.rating)}  _(${wins}W–${losses}L)_`;
  });

  // Chunk into pages of 20 to avoid embed limits
  const chunks = [];
  for (let i = 0; i < lines.length; i += 20) chunks.push(lines.slice(i, i + 20));

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setColor(0xE5B25D)
      .setTitle(i === 0 ? '🏆 TTTIW Leaderboard' : '🏆 TTTIW Leaderboard (cont.)')
      .setDescription(chunks[i].join('\n'))
      .setFooter(footer())
      .setTimestamp();
    await message.reply({ embeds: [embed] });
  }
}

// ── COMMAND: ttt predict [p1] [p2] ───────────────────────────────────────────
async function cmdPredict(message, args) {
  if (args.length < 2) return message.reply('Usage: `ttt predict [player1] [player2]`');
  const [p1, p2] = await Promise.all([findPlayer(args[0]), findPlayer(args[1])]);
  if (!p1) return message.reply(`❌ Player not found: **${args[0]}**`);
  if (!p2) return message.reply(`❌ Player not found: **${args[1]}**`);
  if (p1.id === p2.id) return message.reply(`❌ That's the same person!`);

  const p1WinPct = winProb(p1, p2);
  const p2WinPct = (100 - parseFloat(p1WinPct)).toFixed(1);

  const ifP1Wins_p1 = g2Update({ rating: p1.rating, rd: p1.rd, sigma: p1.sigma || SIGMA_DEFAULT }, [{ rating: p2.rating, rd: p2.rd, sigma: p2.sigma || SIGMA_DEFAULT, s: 1 }]);
  const ifP1Wins_p2 = g2Update({ rating: p2.rating, rd: p2.rd, sigma: p2.sigma || SIGMA_DEFAULT }, [{ rating: p1.rating, rd: p1.rd, sigma: p1.sigma || SIGMA_DEFAULT, s: 0 }]);
  const ifP2Wins_p2 = g2Update({ rating: p2.rating, rd: p2.rd, sigma: p2.sigma || SIGMA_DEFAULT }, [{ rating: p1.rating, rd: p1.rd, sigma: p1.sigma || SIGMA_DEFAULT, s: 1 }]);
  const ifP2Wins_p1 = g2Update({ rating: p1.rating, rd: p1.rd, sigma: p1.sigma || SIGMA_DEFAULT }, [{ rating: p2.rating, rd: p2.rd, sigma: p2.sigma || SIGMA_DEFAULT, s: 0 }]);

  const embed = new EmbedBuilder()
    .setColor(0xc9a0dc)
    .setTitle(`🔮 ${p1.name} vs ${p2.name}`)
    .addFields(
      {
        name: 'Win Probability',
        value: `**${p1.name}**: ${p1WinPct}%\n**${p2.name}**: ${p2WinPct}%`,
      },
      {
        name: `If ${p1.name} wins`,
        value: `${p1.name}: **${signed(Math.round((ifP1Wins_p1.rating - p1.rating) * 10) / 10)}**\n${p2.name}: **${signed(Math.round((ifP1Wins_p2.rating - p2.rating) * 10) / 10)}**`,
        inline: true,
      },
      {
        name: `If ${p2.name} wins`,
        value: `${p2.name}: **${signed(Math.round((ifP2Wins_p2.rating - p2.rating) * 10) / 10)}**\n${p1.name}: **${signed(Math.round((ifP2Wins_p1.rating - p1.rating) * 10) / 10)}**`,
        inline: true,
      }
    )
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt vs [p1] [p2] ────────────────────────────────────────────────
async function cmdVs(message, args) {
  if (args.length < 2) return message.reply('Usage: `ttt vs [player1] [player2]`');
  const [p1, p2] = await Promise.all([findPlayer(args[0]), findPlayer(args[1])]);
  if (!p1) return message.reply(`❌ Player not found: **${args[0]}**`);
  if (!p2) return message.reply(`❌ Player not found: **${args[1]}**`);
  if (p1.id === p2.id) return message.reply(`❌ That's the same person!`);

  const matches = await getAllMatches();
  const h2h = matches.filter(m =>
    (m.winnerId === p1.id && m.loserId === p2.id) ||
    (m.winnerId === p2.id && m.loserId === p1.id)
  );
  const p1w = h2h.filter(m => m.winnerId === p1.id).length;
  const p2w = h2h.filter(m => m.winnerId === p2.id).length;
  const total = h2h.length;

  const embed = new EmbedBuilder()
    .setColor(0xc9a0dc)
    .setTitle(`🏓 ${p1.name} vs ${p2.name}`)
    .addFields(
      {
        name: p1.name,
        value: [`Rating: **${r2(p1.rating)}** (RD ${r2(p1.rd)})`, `H2H wins: **${p1w}**`, `Win prob: **${winProb(p1, p2)}%**`].join('\n'),
        inline: true,
      },
      {
        name: p2.name,
        value: [`Rating: **${r2(p2.rating)}** (RD ${r2(p2.rd)})`, `H2H wins: **${p2w}**`, `Win prob: **${winProb(p2, p1)}%**`].join('\n'),
        inline: true,
      },
      {
        name: 'Head-to-Head Record',
        value: total > 0
          ? `${p1.name} **${p1w}** – **${p2w}** ${p2.name}  _(${total} match${total !== 1 ? 'es' : ''})_`
          : '_No matches played yet_',
      }
    )
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt rating farm [player] ────────────────────────────────────────
async function cmdRatingFarm(message, args) {
  if (!args.length) return message.reply('Usage: `ttt rating farm [player]`');
  const player = await findPlayer(args[0]);
  if (!player) return message.reply(`❌ Player not found: **${args[0]}**`);

  const allPlayers = await getAllPlayers();
  const gains = allPlayers
    .filter(p => p.id !== player.id)
    .map(opp => {
      const result = g2Update(
        { rating: player.rating, rd: player.rd, sigma: player.sigma || SIGMA_DEFAULT },
        [{ rating: opp.rating, rd: opp.rd, sigma: opp.sigma || SIGMA_DEFAULT, s: 1 }]
      );
      const gain = Math.round((result.rating - player.rating) * 10) / 10;
      const prob = parseFloat(winProb(player, opp));
      const expected = Math.round(gain * (prob / 100) * 10) / 10;
      return { opp, gain, prob: prob.toFixed(1), expected };
    })
    .sort((a, b) => b.expected - a.expected)
    .slice(0, 3);

  if (!gains.length) return message.reply('No other players found.');

  const medals = ['🥇', '🥈', '🥉'];
  const lines = gains.map((g, i) =>
    `${medals[i]} **${g.opp.name}** — **+${g.gain} elo** if you win  _(${g.prob}% chance)_\n\u3000Expected gain: **+${g.expected}** · Rating: ${r2(g.opp.rating)} · RD: ${r2(g.opp.rd)}`
  ).join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(0x7ec8a0)
    .setTitle(`📈 Rating farm targets for ${player.name}`)
    .setDescription(lines)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt streak ───────────────────────────────────────────────────────
async function cmdStreak(message) {
  const [players, matches] = await Promise.all([getAllPlayers(), getAllMatches()]);

  const streaks = players
    .map(p => {
      const myMatches = matches.filter(m => m.winnerId === p.id || m.loserId === p.id);
      return { name: p.name, streak: calcStreak(p.id, myMatches) };
    })
    .filter(s => s.streak > 0)
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 10);

  if (!streaks.length) return message.reply('Nobody is on a win streak right now.');

  const lines = streaks.map((s, i) =>
    `${rankEmoji(i + 1)} **${s.name}** — 🔥 ${s.streak} win${s.streak !== 1 ? 's' : ''}`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xff6b35)
    .setTitle('🔥 Current Win Streaks')
    .setDescription(lines)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt nemesis [player] ─────────────────────────────────────────────
async function cmdNemesis(message, args) {
  if (!args.length) return message.reply('Usage: `ttt nemesis [player]`');
  const player = await findPlayer(args[0]);
  if (!player) return message.reply(`❌ Player not found: **${args[0]}**`);

  const matches = await getAllMatches();
  const losses = matches.filter(m => m.loserId === player.id);
  if (!losses.length) return message.reply(`**${player.name}** has never lost a match. Unbeatable! 🐐`);

  const beatCount = {};
  for (const m of losses) beatCount[m.winnerName] = (beatCount[m.winnerName] || 0) + 1;

  const sorted = Object.entries(beatCount).sort((a, b) => b[1] - a[1]);
  const lines = sorted.slice(0, 5).map(([name, count], i) =>
    `${rankEmoji(i + 1)} **${name}** — beaten them **${count}** time${count !== 1 ? 's' : ''}`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xd9534f)
    .setTitle(`😈 ${player.name}'s Nemeses`)
    .setDescription(lines)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt rivals ───────────────────────────────────────────────────────
async function cmdRivals(message) {
  const matches = await getAllMatches();

  const pairCount = {};
  for (const m of matches) {
    if (!m.winnerId || !m.loserId) continue;
    const key = [m.winnerId, m.loserId].sort().join('|');
    if (!pairCount[key]) {
      const names = [m.winnerName, m.loserName];
      if (m.winnerId > m.loserId) names.reverse();
      pairCount[key] = { names, count: 0 };
    }
    pairCount[key].count++;
  }

  const sorted = Object.values(pairCount).sort((a, b) => b.count - a.count).slice(0, 5);
  if (!sorted.length) return message.reply('No matches played yet.');

  const lines = sorted.map((r, i) =>
    `${rankEmoji(i + 1)} **${r.names[0]}** vs **${r.names[1]}** — ${r.count} match${r.count !== 1 ? 'es' : ''}`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xc9a0dc)
    .setTitle('⚔️ Biggest Rivals')
    .setDescription(lines)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt hot ──────────────────────────────────────────────────────────
async function cmdHot(message) {
  const matches = await getAllMatches();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const recent = matches.filter(m => {
    const ts = m.date?.toDate ? m.date.toDate().getTime() : new Date(m.date).getTime();
    return ts >= cutoff;
  });

  if (!recent.length) return message.reply('No matches in the last 7 days.');

  const gains = {};
  for (const m of recent) {
    if (m.winnerName) gains[m.winnerName] = (gains[m.winnerName] || 0) + (m.p1delta || 0);
    if (m.loserName)  gains[m.loserName]  = (gains[m.loserName]  || 0) + (m.p2delta || 0);
  }

  const sorted = Object.entries(gains).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const lines = sorted.map(([name, delta], i) =>
    `${rankEmoji(i + 1)} **${name}** — ${signed(Math.round(delta * 10) / 10)} elo this week`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x7ec8a0)
    .setTitle('📈 Hottest Players This Week')
    .setDescription(lines)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── DISCORD CLIENT ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => console.log(`✅ TTTIW bot ready as ${client.user.tag}`));

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (CHANNEL_ID && message.channelId !== CHANNEL_ID) return;

  const content = message.content.trim();

  // ── PREFIX COMMANDS ──
  if (content.toLowerCase().startsWith(PREFIX + ' ') || content.toLowerCase() === PREFIX) {
    const rest  = content.slice(PREFIX.length).trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const cmd   = parts[0]?.toLowerCase();
    const sub   = parts[1]?.toLowerCase();

    await message.channel.sendTyping();
    try {
      if (!cmd || cmd === 'help')                 return await cmdHelp(message);
      if (cmd === 'stats')                        return await cmdStats(message, parts.slice(1));
      if (cmd === 'history')                      return await cmdHistory(message, parts.slice(1));
      if (cmd === 'rank')                         return await cmdRank(message, parts.slice(1));
      if (cmd === 'top')                          return await cmdTop(message);
      if (cmd === 'predict')                      return await cmdPredict(message, parts.slice(1));
      if (cmd === 'vs')                           return await cmdVs(message, parts.slice(1));
      if (cmd === 'rating' && sub === 'farm')     return await cmdRatingFarm(message, parts.slice(2));
      if (cmd === 'streak')                       return await cmdStreak(message);
      if (cmd === 'nemesis')                      return await cmdNemesis(message, parts.slice(1));
      if (cmd === 'rivals')                       return await cmdRivals(message);
      if (cmd === 'hot')                          return await cmdHot(message);
    } catch (err) {
      console.error('Command error:', err);
      return message.reply(`❌ Error: ${err.message}`);
    }
    return;
  }

  // ── MATCH REPORTING ──
  const parsed = parseMatchMessage(content);
  if (!parsed) return;

  const { winnerStr, loserStr, s1, s2 } = parsed;
  const scoreStr = s1 != null ? `${s1}-${s2}` : null;

  if (s1 != null && parseInt(s1) <= parseInt(s2)) {
    return message.reply(`❌ First player is the winner — their score (${s1}) should be higher than the loser's (${s2}). Did you mean \`${loserStr} ${winnerStr} ${s2}-${s1}\`?`);
  }

  await message.channel.sendTyping();
  const [winner, loser] = await Promise.all([findPlayer(winnerStr), findPlayer(loserStr)]);
  if (!winner) return message.reply(`❌ Player not found: **${winnerStr}** — check spelling matches the leaderboard.`);
  if (!loser)  return message.reply(`❌ Player not found: **${loserStr}** — check spelling matches the leaderboard.`);
  if (winner.id === loser.id) return message.reply(`❌ A player can't play themselves!`);

  try {
    const result = await submitMatch(winner, loser, scoreStr);
    const embed  = await buildResultEmbed(winner, loser, result, scoreStr);
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Match submission error:', err);
    await message.reply(`❌ Error submitting match: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);