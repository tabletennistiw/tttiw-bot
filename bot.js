// Force stdout → stderr so Render doesn't buffer/drop logs
process.stdout.write = process.stderr.write.bind(process.stderr);

// TTTIW Discord Bot
//
// Match reporting (first player always wins):
//   inoo ath  /  inoo ath 10-8  /  inoo ath 10 8  /  inoo 10 ath 8
//   Add 15 or 21 at the end for format: inoo ath 10-8 15  /  inoo ath 21
//   Default format is ft11.
//
// Commands (prefix: ttt):
//   ttt help
//   ttt stats [player]
//   ttt history [player]
//   ttt rank [player]
//   ttt rd [player]
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
const CHANNEL_ID          = process.env.CHANNEL_ID ? process.env.CHANNEL_ID.split(',').map(s => s.trim()) : null;
const INTAKE_CHANNEL_ID   = process.env.INTAKE_CHANNEL_ID ?? null; // private webhook-only channel
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

// ── DECAY CONFIG (loaded from Firestore, updated via snapshot) ────────────────
let DECAY_SCALE_MULTIPLIER   = 0;
let DECAY_GENERAL_MULTIPLIER = 1;

db.doc('config/decay').onSnapshot(snap => {
  if (!snap.exists) return;
  const d = snap.data();
  if (d.decayScaleMult   != null) DECAY_SCALE_MULTIPLIER   = d.decayScaleMult;
  if (d.decayGeneralMult != null) DECAY_GENERAL_MULTIPLIER = d.decayGeneralMult > 0 ? d.decayGeneralMult : 1;
  console.log(`🔄 Decay config updated: g=${DECAY_GENERAL_MULTIPLIER} m=${DECAY_SCALE_MULTIPLIER}`);
});

// ── GLICKO-2 (matches index.html exactly — no sigma/volatility) ───────────────
const SCALE  = 173.7178;
const RD_MAX = 200;

function toG2(r, rd)      { return { mu: (r - 1500) / SCALE, phi: rd / SCALE }; }
function fromG2(mu, phi)  { return { r: mu * SCALE + 1500, rd: phi * SCALE }; }
function gPhi(phi)        { return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI)); }
function E(mu, muj, phij) { return 1 / (1 + Math.exp(-gPhi(phij) * (mu - muj))); }

function g2Update(player, opps) {
  const { mu, phi } = toG2(player.rating, player.rd);
  if (!opps.length) return { rating: player.rating, rd: player.rd };
  let vInv = 0, deltaSum = 0;
  for (const o of opps) {
    const { mu: muj, phi: phij } = toG2(o.rating, o.rd);
    const gj = gPhi(phij), ej = E(mu, muj, phij);
    vInv    += gj * gj * ej * (1 - ej);
    deltaSum += gj * (o.s - ej);
  }
  const v      = 1 / vInv;
  const phiNew = 1 / Math.sqrt(1 / (phi * phi) + 1 / v);
  const muNew  = mu + phiNew * phiNew * deltaSum;
  const r      = fromG2(muNew, phiNew);
  return { rating: r.r, rd: Math.min(r.rd, RD_MAX) };
}

// ── FORMAT MULTIPLIER (mirrors _ftMult in index.html exactly) ────────────────
// Scales rating gain/loss by format length relative to ft11 baseline.
function _ftMult(pWin, ftN) {
  if (ftN === 11) return 1;
  // Expected score from ft11 perspective, then calibrate for ftN
  const p11 = pWin; // already ft11 win probability
  if (p11 <= 0 || p11 >= 1) return 1;
  // P(win ftN) using normal approximation on points won
  const mu = ftN * (p11 - 0.5);
  const sig = Math.sqrt(ftN * p11 * (1 - p11));
  if (sig <= 0) return 1;
  // Φ(mu/sig) — standard normal CDF approximation
  const z = mu / sig;
  const pN = 0.5 * (1 + Math.sign(z) * (1 - Math.exp(-0.7978845608 * Math.abs(z) * (1 + 0.0433 * z * z))));
  if (pN <= 0 || pN >= 1) return 1;
  // multiplier = log(pN) / log(p11)  (same ratio of log-probabilities as site)
  return Math.log(pN) / Math.log(p11);
}

function winProb(a, b) {
  const { mu, phi }            = toG2(a.rating, a.rd);
  const { mu: muj, phi: phij } = toG2(b.rating, b.rd);
  return (E(mu, muj, Math.sqrt(phi * phi + phij * phij)) * 100).toFixed(1);
}

// ── RD ANCHOR SYSTEM (integer-second, mirrors index.html exactly) ─────────────
const _RD_NUMERATOR       = 30240000;
const _RD_ASYMPTOTE_SHIFT = 336000;
const _RD_ASYMPTOTE       = 120;
const _RD_MIN             = 30;
const _RD_MAX_NEW         = 120;

function _rdClamp(rd) { return Math.min(_RD_MAX_NEW, Math.max(_RD_MIN, rd == null ? 120 : rd)); }

function _rdRatingScale(rating) {
  const m = DECAY_SCALE_MULTIPLIER;
  const g = DECAY_GENERAL_MULTIPLIER > 0 ? DECAY_GENERAL_MULTIPLIER : 1;
  const rs = (!m || m <= 0) ? 1 : Math.pow(1500 / Math.max(1, rating || 1500), m);
  return g * rs;
}

function _rdToX(rd) {
  if (rd >= _RD_ASYMPTOTE) return Infinity;
  return -_RD_NUMERATOR / (rd - _RD_ASYMPTOTE) - _RD_ASYMPTOTE_SHIFT;
}

function _rdFromX(x) {
  return _rdClamp(-_RD_NUMERATOR / (x + _RD_ASYMPTOTE_SHIFT) + _RD_ASYMPTOTE);
}

function _rdAfterSec(anchorRD, rating, elapsedWholeSec) {
  const clamped = _rdClamp(anchorRD);
  const x0 = _rdToX(clamped);
  if (!isFinite(x0)) return _RD_MAX_NEW;
  return _rdFromX(x0 + Math.max(0, Math.floor(elapsedWholeSec)) * _rdRatingScale(rating || 1500));
}

function _rdGetAnchor(p) {
  if (p.rdAnchorSec != null) {
    return { rd: _rdClamp(p.rdAnchorRD ?? p.rd ?? 120), sec: p.rdAnchorSec };
  }
  let ms = Date.now();
  const t = p.rdBaseTime;
  if (t != null) {
    if (typeof t === 'number')                ms = t > 2e10 ? t : t * 1000;
    else if (typeof t.toMillis === 'function') ms = t.toMillis();
    else if (typeof t.toDate   === 'function') ms = t.toDate().getTime();
    else ms = Number(t) || Date.now();
  }
  return { rd: _rdClamp(p.rd ?? 120), sec: Math.round(ms / 1000) };
}

function _rdNewAnchor(rd, nowMs) {
  return { rdAnchorRD: _rdClamp(rd), rdAnchorSec: Math.round((nowMs || Date.now()) / 1000) };
}

function computeRDLive(p) {
  if (p.decayImmune) return _rdClamp(p.rdAnchorRD ?? p.rd ?? 120);
  const { rd: anchorRD, sec: anchorSec } = _rdGetAnchor(p);
  const nowSec = Math.floor(Date.now() / 1000);
  return _rdAfterSec(anchorRD, p.rating || 1500, nowSec - anchorSec);
}

function _secsToPurge(p) {
  const lrd = computeRDLive(p);
  if (lrd >= 100) return 0;
  const { rd: anchorRD, sec: anchorSec } = _rdGetAnchor(p);
  const nowSec     = Math.floor(Date.now() / 1000);
  const elapsedNow = nowSec - anchorSec;
  const x0         = _rdToX(_rdClamp(anchorRD));
  const x100       = _rdToX(100);
  const scale      = _rdRatingScale(p.rating || 1500);
  if (!isFinite(x0) || scale <= 0) return Infinity;
  return Math.max(0, Math.ceil((x100 - x0) / scale) - elapsedNow);
}

// ── MATCH PARSER ──────────────────────────────────────────────────────────────
// Valid formats appended at the end: 15 or 21 (anything else → ft11)
const VALID_FORMATS = new Set([15, 21]);

function parseFormat(token) {
  const n = parseInt(token, 10);
  return VALID_FORMATS.has(n) ? n : 11;
}

function parseMatchMessage(content) {
  const t = content.trim().split(/\s+/);

  // [winner] 10 [loser] 8 [format?]
  if (t.length >= 4 && /^\d+$/.test(t[1]) && /^\d+$/.test(t[3])) {
    const format = t.length >= 5 ? parseFormat(t[4]) : 11;
    return { winnerStr: t[0], loserStr: t[2], s1: t[1], s2: t[3], format };
  }
  // [winner] [loser] 10-8 [format?]
  if (t.length >= 3 && /^\d+-\d+$/.test(t[2])) {
    const [s1, s2] = t[2].split('-');
    const format = t.length >= 4 ? parseFormat(t[3]) : 11;
    return { winnerStr: t[0], loserStr: t[1], s1, s2, format };
  }
  // [winner] [loser] 10 8 [format?]
  if (t.length >= 4 && /^\d+$/.test(t[2]) && /^\d+$/.test(t[3])) {
    const format = t.length >= 5 ? parseFormat(t[4]) : 11;
    return { winnerStr: t[0], loserStr: t[1], s1: t[2], s2: t[3], format };
  }
  // [winner] [loser] [format?]  — no score
  if (t.length >= 2 && !/^\d+$/.test(t[1])) {
    const format = t.length >= 3 ? parseFormat(t[2]) : 11;
    return { winnerStr: t[0], loserStr: t[1], s1: null, s2: null, format };
  }
  return null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function r2(n)     { return Math.round(n * 10) / 10; }
function signed(n) { return (n >= 0 ? '+' : '') + r2(n); }
function pct(w, t) { return t === 0 ? 'N/A' : (w / t * 100).toFixed(1) + '%'; }
function footer()  { return { text: 'TTTIW · Table Tennis Texas InventionWorks' }; }
function rat(p)    { return `${r2(p.rating)} ±${r2(computeRDLive(p))}`; }

function fmtLabel(format) {
  return format && format !== 11 ? ` · ft${format}` : '';
}

function rankEmoji(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  const m = Math.floor((ms % 36e5)  / 6e4);
  const s = Math.floor((ms % 6e4)   / 1e3);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ── FIRESTORE HELPERS ─────────────────────────────────────────────────────────
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
  const players  = await getAllPlayers();
  return players.find(p =>
    p.name?.toLowerCase() === stripped.toLowerCase() ||
    p.discordId === stripped
  ) || null;
}

async function getLeaderboard() {
  const players = await getAllPlayers();
  return players.filter(p => computeRDLive(p) <= 100).sort((a, b) => b.rating - a.rating);
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
async function submitMatch(winner, loser, scoreStr, format) {
  return await db.runTransaction(async tx => {
    const [ws, ls] = await Promise.all([
      tx.get(db.collection('players').doc(winner.id)),
      tx.get(db.collection('players').doc(loser.id)),
    ]);
    if (!ws.exists || !ls.exists) throw new Error('Player not found in Firestore');

    const w = ws.data(), l = ls.data();
    const wLiveRd = computeRDLive({ ...w, id: winner.id });
    const lLiveRd = computeRDLive({ ...l, id: loser.id });

    // Base Glicko-2 update
    const uwRaw = g2Update({ rating: w.rating, rd: wLiveRd }, [{ rating: l.rating, rd: lLiveRd, s: 1 }]);
    const ulRaw = g2Update({ rating: l.rating, rd: lLiveRd }, [{ rating: w.rating, rd: wLiveRd, s: 0 }]);

    // Apply format multiplier (ft15/ft21 scale rating gain/loss)
    const ftN = format || 11;
    const { mu: wMu, phi: wPhi } = toG2(w.rating, wLiveRd);
    const { mu: lMu, phi: lPhi } = toG2(l.rating, lLiveRd);
    const pWin = E(wMu, lMu, lPhi); // winner's ft11 win probability
    const wMult = _ftMult(pWin, ftN);
    const lMult = _ftMult(1 - pWin, ftN);

    const uw = { rating: w.rating + (uwRaw.rating - w.rating) * wMult, rd: uwRaw.rd };
    const ul = { rating: l.rating + (ulRaw.rating - l.rating) * lMult, rd: ulRaw.rd };

    const now    = Date.now();
    const wAnchor = _rdNewAnchor(uw.rd, now);
    const lAnchor = _rdNewAnchor(ul.rd, now);

    // #1 tracking
    const allSnap  = await db.collection('players').get();
    const allP     = allSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ranked   = p => computeRDLive(p) <= 100;
    const topBefore = allP.filter(ranked).sort((a, b) => b.rating - a.rating)[0];
    const simP     = allP.map(p => {
      if (p.id === winner.id) return { ...p, rating: uw.rating, rd: uw.rd, rdAnchorRD: wAnchor.rdAnchorRD, rdAnchorSec: wAnchor.rdAnchorSec };
      if (p.id === loser.id)  return { ...p, rating: ul.rating, rd: ul.rd, rdAnchorRD: lAnchor.rdAnchorRD, rdAnchorSec: lAnchor.rdAnchorSec };
      return p;
    });
    const topAfter = simP.filter(ranked).sort((a, b) => b.rating - a.rating)[0];

    const wUpdate = {
      rating: uw.rating, rd: uw.rd,
      rdAnchorRD: wAnchor.rdAnchorRD, rdAnchorSec: wAnchor.rdAnchorSec,
      wins: (w.wins || 0) + 1,
    };
    const lUpdate = {
      rating: ul.rating, rd: ul.rd,
      rdAnchorRD: lAnchor.rdAnchorRD, rdAnchorSec: lAnchor.rdAnchorSec,
      losses: (l.losses || 0) + 1,
    };

    if (topBefore?.id !== topAfter?.id) {
      if (topBefore) {
        const oldTop = allP.find(p => p.id === topBefore.id);
        if (oldTop?.no1Since) {
          const dur = now - (oldTop.no1Since || now);
          const upd = { no1Since: null };
          if (dur > (oldTop.longestNo1Ms || 0)) upd.longestNo1Ms = dur;
          if (oldTop.id === winner.id)      Object.assign(wUpdate, upd);
          else if (oldTop.id === loser.id)  Object.assign(lUpdate, upd);
          else await tx.update(db.collection('players').doc(oldTop.id), upd);
        }
      }
      if (topAfter) {
        const newTopData = allP.find(p => p.id === topAfter.id);
        const no1Since = newTopData?.no1Since || now;
        if (topAfter.id === winner.id)     wUpdate.no1Since = no1Since;
        else if (topAfter.id === loser.id) lUpdate.no1Since = no1Since;
        else await tx.update(db.collection('players').doc(topAfter.id), { no1Since });
      }
    }

    tx.update(db.collection('players').doc(winner.id), wUpdate);
    tx.update(db.collection('players').doc(loser.id),  lUpdate);

    const matchRef = db.collection('matches').doc();
    tx.set(matchRef, {
      winnerId: winner.id, loserId: loser.id,
      winnerName: w.name,  loserName: l.name,
      p1id: winner.id, p2id: loser.id,
      p1name: w.name,  p2name: l.name,
      score: 1,
      matchScore: scoreStr || null,
      format: ftN,
      p1delta: Math.round((uw.rating - w.rating) * 10) / 10,
      p2delta: Math.round((ul.rating - l.rating) * 10) / 10,
      p1oldRD: wLiveRd, p2oldRD: lLiveRd,
      p1newRD: uw.rd,   p2newRD: ul.rd,
      p1oldRating: w.rating, p1newRating: uw.rating,
      p2oldRating: l.rating, p2newRating: ul.rating,
      source: 'discord',
      date: FieldValue.serverTimestamp(),
    });

    return { w, l, uw, ul, wLiveRd, lLiveRd, topBefore, topAfter, no1Change: topBefore?.id !== topAfter?.id, format: ftN };
  });
}

// ── MATCH RESULT EMBED ────────────────────────────────────────────────────────
async function buildResultEmbed(winnerData, loserData, result, scoreStr) {
  const { w, l, uw, ul, wLiveRd, lLiveRd, no1Change, topAfter, format } = result;
  const wDelta = Math.round((uw.rating - w.rating) * 10) / 10;
  const lDelta = Math.round((ul.rating - l.rating) * 10) / 10;

  const lb    = await getLeaderboard();
  const wRank = lb.findIndex(p => p.id === winnerData.id) + 1;
  const lRank = lb.findIndex(p => p.id === loserData.id) + 1;

  const top5 = lb.slice(0, 5).map((p, i) => {
    const tag = p.id === winnerData.id ? ' ← W' : p.id === loserData.id ? ' ← L' : '';
    return `${rankEmoji(i + 1)} **${p.name}** — ${rat(p)}${tag}`;
  }).join('\n');

  const rdLine = (liveRd, newRd) => {
    const delta = Math.round((newRd - liveRd) * 10) / 10;
    return `RD: ±${r2(liveRd)} → ±${r2(newRd)} (${signed(delta)})`;
  };

  const formatTag = format && format !== 11 ? ` [ft${format}]` : '';
  const title = `⚡ ${w.name} def. ${l.name}${scoreStr ? `  ${scoreStr}` : ''}${formatTag}`;

  const embed = new EmbedBuilder()
    .setColor(0xE5B25D)
    .setTitle(title)
    .addFields(
      {
        name: `🏆 ${w.name}`,
        value: [
          `${r2(w.rating)} → **${r2(uw.rating)}** (${signed(wDelta)})`,
          rdLine(wLiveRd, uw.rd),
          `Record: ${(w.wins || 0) + 1}W – ${w.losses || 0}L`,
          wRank ? `Rank: ${rankEmoji(wRank)}` : '_Unranked_',
        ].join('\n'),
        inline: true,
      },
      {
        name: `😔 ${l.name}`,
        value: [
          `${r2(l.rating)} → **${r2(ul.rating)}** (${signed(lDelta)})`,
          rdLine(lLiveRd, ul.rd),
          `Record: ${l.wins || 0}W – ${(l.losses || 0) + 1}L`,
          lRank ? `Rank: ${rankEmoji(lRank)}` : '_Unranked_',
        ].join('\n'),
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
          '`[winner] [loser]` — no score, ft11',
          '`[winner] [loser] 10-8` — with score, ft11',
          '`[winner] [loser] 10 8` — space-separated score',
          '`[winner] 10 [loser] 8` — interleaved',
          '`[winner] [loser] 10-8 15` — ft15 format',
          '`[winner] [loser] 10-8 21` — ft21 format',
          '_First player is always the winner. Default format is ft11._',
        ].join('\n'),
      },
      {
        name: '👤 Player Info',
        value: [
          '`ttt stats [player]` — full profile',
          '`ttt history [player]` — last 5 matches',
          '`ttt rank [player]` — current rank & rating',
          '`ttt rd [player]` — live RD & time until purge',
        ].join('\n'),
        inline: true,
      },
      {
        name: '🏆 Leaderboard',
        value: '`ttt top` — full leaderboard with rank changes',
        inline: true,
      },
      {
        name: '➕ Management',
        value: '`ttt add [name]` — add a new player',
        inline: true,
      },
      {
        name: '📊 Match Tools',
        value: [
          '`ttt predict [p1] [p2]` — win odds + rating outcomes',
          '`ttt vs [p1] [p2]` — head-to-head record',
          '`ttt rating farm [player]` — best targets for rating gain',
        ].join('\n'),
      },
      {
        name: '🎲 Fun Stats',
        value: [
          '`ttt streak` — longest current win streaks',
          '`ttt nemesis [player]` — who beats them the most',
          '`ttt rivals` — most played matchups',
          '`ttt hot` — most rating gained this week',
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

  const matches   = await getAllMatches();
  const myMatches = matches.filter(m => m.winnerId === player.id || m.loserId === player.id);
  const wins      = myMatches.filter(m => m.winnerId === player.id).length;
  const losses    = myMatches.filter(m => m.loserId  === player.id).length;
  const streak    = calcStreak(player.id, myMatches);
  const liveRd    = computeRDLive(player);

  const lb   = await getLeaderboard();
  const rank = lb.findIndex(p => p.id === player.id) + 1;

  const secsToPurge = _secsToPurge(player);
  const rdStatus = liveRd > 100
    ? '⚠️ Hidden (RD > 100)'
    : secsToPurge < 3600
      ? `⚠️ Purge in ${fmtDuration(secsToPurge * 1000)}`
      : `✅ Active (purge in ${fmtDuration(secsToPurge * 1000)})`;

  const embed = new EmbedBuilder()
    .setColor(0xE5B25D)
    .setTitle(`👤 ${player.name}`)
    .addFields(
      { name: 'Rating',    value: `**${r2(player.rating)}**`,              inline: true },
      { name: 'RD',        value: `**±${r2(liveRd)}**`,                   inline: true },
      { name: 'Rank',      value: rank ? rankEmoji(rank) : '_Unranked_',   inline: true },
      { name: 'Record',    value: `${wins}W – ${losses}L`,                 inline: true },
      { name: 'Win Rate',  value: pct(wins, wins + losses),                inline: true },
      { name: 'Streak',    value: streak > 0 ? `🔥 ${streak} wins` : '—', inline: true },
      { name: 'RD Status', value: rdStatus },
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

  const matches   = await getAllMatches();
  const myMatches = matches
    .filter(m => m.winnerId === player.id || m.loserId === player.id)
    .slice(0, 5);

  if (!myMatches.length) return message.reply(`No matches found for **${player.name}**.`);

  const lines = myMatches.map(m => {
    const won   = m.winnerId === player.id;
    const opp   = won ? m.loserName : m.winnerName;
    const delta = won ? m.p1delta : m.p2delta;
    const score = m.matchScore ? ` ${m.matchScore}` : '';
    const fmt   = m.format && m.format !== 11 ? ` ft${m.format}` : '';
    const ts    = m.date?.toDate ? m.date.toDate() : new Date(m.date);
    const date  = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${won ? '✅' : '❌'} **${won ? 'W' : 'L'}** vs ${opp}${score}${fmt}  (${signed(delta)})  · ${date}`;
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

  const liveRd = computeRDLive(player);
  const lb     = await getLeaderboard();
  const rank   = lb.findIndex(p => p.id === player.id) + 1;

  if (!rank) return message.reply(`**${player.name}** is currently unranked (RD ±${r2(liveRd)} > 100 — play more games!).`);
  await message.reply(`${rankEmoji(rank)} **${player.name}** is ranked **#${rank}** · ${r2(player.rating)} ±${r2(liveRd)} RD`);
}

// ── COMMAND: ttt rd [player] ──────────────────────────────────────────────────
async function cmdRD(message, args) {
  if (!args.length) return message.reply('Usage: `ttt rd [player]`');
  const player = await findPlayer(args[0]);
  if (!player) return message.reply(`❌ Player not found: **${args[0]}**`);

  const liveRd      = computeRDLive(player);
  const { sec: anchorSec } = _rdGetAnchor(player);
  const nowSec      = Math.floor(Date.now() / 1000);
  const elapsedSec  = nowSec - anchorSec;
  const secsToPurge = _secsToPurge(player);

  let statusLine;
  if (player.decayImmune) {
    statusLine = '🛡️ Decay immune — RD frozen';
  } else if (liveRd > 100) {
    statusLine = '⚠️ Currently **hidden** from leaderboard (RD > 100) — play a match to get back on!';
  } else {
    statusLine = secsToPurge < 3600
      ? `⚠️ **Purge in ${fmtDuration(secsToPurge * 1000)}** — play a match to reset!`
      : `✅ On leaderboard · purge in **${fmtDuration(secsToPurge * 1000)}**`;
  }

  const g = DECAY_GENERAL_MULTIPLIER > 0 ? DECAY_GENERAL_MULTIPLIER : 1;
  const m = DECAY_SCALE_MULTIPLIER;
  const currentRate = (g * ((!m || m <= 0) ? 1 : Math.pow(1500 / Math.max(1, player.rating || 1500), m))).toFixed(3);

  const embed = new EmbedBuilder()
    .setColor(liveRd > 100 ? 0xd9534f : liveRd > 80 ? 0xE5B25D : 0x7ec8a0)
    .setTitle(`📡 RD Status — ${player.name}`)
    .addFields(
      { name: 'Live RD',    value: `**±${r2(liveRd)}**`,                    inline: true },
      { name: 'Rating',     value: `**${r2(player.rating)}**`,              inline: true },
      { name: 'Decay Rate', value: `**${currentRate}×** (g=${g}, m=${m})`, inline: true },
      { name: 'Anchor Age', value: fmtDuration(elapsedSec * 1000),         inline: true },
      { name: 'Status',     value: statusLine },
    )
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt top ──────────────────────────────────────────────────────────
async function cmdTop(message) {
  const [lb, allMatches] = await Promise.all([getLeaderboard(), getAllMatches()]);
  if (!lb.length) return message.reply('No ranked players yet.');

  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const oldRatingMap = {};
  for (const p of lb) {
    const recentMatches = allMatches.filter(m => {
      const ts = m.date?.toDate ? m.date.toDate().getTime() : new Date(m.date).getTime();
      return ts >= cutoff && (m.winnerId === p.id || m.loserId === p.id);
    });
    if (!recentMatches.length) { oldRatingMap[p.id] = p.rating; continue; }
    const earliest = recentMatches[recentMatches.length - 1];
    oldRatingMap[p.id] = earliest.winnerId === p.id
      ? (earliest.p1oldRating ?? p.rating)
      : (earliest.p2oldRating ?? p.rating);
  }

  const oldLb = lb
    .map(p => ({ ...p, rating: oldRatingMap[p.id] ?? p.rating }))
    .filter(p => computeRDLive(p) <= 100)
    .sort((a, b) => b.rating - a.rating);
  const oldRankMap = {};
  oldLb.forEach((p, i) => { oldRankMap[p.id] = i + 1; });

  const lines = lb.map((p, i) => {
    const currentRank = i + 1;
    const oldRank     = oldRankMap[p.id];
    let change = '';
    if (oldRank && oldRank !== currentRank) {
      const diff = oldRank - currentRank;
      change = diff > 0 ? ` ↑${diff}` : ` ↓${Math.abs(diff)}`;
    }
    return `${rankEmoji(currentRank)} **${p.name}** — ${rat(p)}${change}  _(${p.wins || 0}W–${p.losses || 0}L)_`;
  });

  const chunks = [];
  for (let i = 0; i < lines.length; i += 20) chunks.push(lines.slice(i, i + 20));

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setColor(0xE5B25D)
      .setTitle(i === 0 ? '🏆 TTTIW Leaderboard' : '🏆 TTTIW Leaderboard (cont.)')
      .setDescription(chunks[i].join('\n'))
      .setFooter({ text: 'TTTIW · Table Tennis Texas InventionWorks  ·  ↑↓ = rank change in last 3 days' })
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

  const p1rd = computeRDLive(p1), p2rd = computeRDLive(p2);
  const p1Live = { ...p1, rd: p1rd }, p2Live = { ...p2, rd: p2rd };

  const p1WinPct = winProb(p1Live, p2Live);
  const p2WinPct = (100 - parseFloat(p1WinPct)).toFixed(1);

  const ifP1Wins_p1 = g2Update({ rating: p1.rating, rd: p1rd }, [{ rating: p2.rating, rd: p2rd, s: 1 }]);
  const ifP1Wins_p2 = g2Update({ rating: p2.rating, rd: p2rd }, [{ rating: p1.rating, rd: p1rd, s: 0 }]);
  const ifP2Wins_p2 = g2Update({ rating: p2.rating, rd: p2rd }, [{ rating: p1.rating, rd: p1rd, s: 1 }]);
  const ifP2Wins_p1 = g2Update({ rating: p1.rating, rd: p1rd }, [{ rating: p2.rating, rd: p2rd, s: 0 }]);

  const embed = new EmbedBuilder()
    .setColor(0xc9a0dc)
    .setTitle(`🔮 ${p1.name} vs ${p2.name}`)
    .addFields(
      {
        name: 'Current Ratings',
        value: `**${p1.name}**: ${r2(p1.rating)} ±${r2(p1rd)}\n**${p2.name}**: ${r2(p2.rating)} ±${r2(p2rd)}`,
      },
      {
        name: 'Win Probability',
        value: `**${p1.name}**: ${p1WinPct}%\n**${p2.name}**: ${p2WinPct}%`,
        inline: true,
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

  const p1rd = computeRDLive(p1), p2rd = computeRDLive(p2);
  const p1Live = { ...p1, rd: p1rd }, p2Live = { ...p2, rd: p2rd };

  const matches = await getAllMatches();
  const h2h   = matches.filter(m =>
    (m.winnerId === p1.id && m.loserId === p2.id) ||
    (m.winnerId === p2.id && m.loserId === p1.id)
  );
  const p1w   = h2h.filter(m => m.winnerId === p1.id).length;
  const p2w   = h2h.filter(m => m.winnerId === p2.id).length;
  const total = h2h.length;

  // Recent form (last 5 h2h)
  const recentLines = h2h.slice(0, 5).map(m => {
    const winner = m.winnerId === p1.id ? p1.name : p2.name;
    const score  = m.matchScore ? ` ${m.matchScore}` : '';
    const fmt    = m.format && m.format !== 11 ? ` ft${m.format}` : '';
    const ts     = m.date?.toDate ? m.date.toDate() : new Date(m.date);
    const date   = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `**${winner}**${score}${fmt} · ${date}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xc9a0dc)
    .setTitle(`🏓 ${p1.name} vs ${p2.name}`)
    .addFields(
      {
        name: p1.name,
        value: [`Rating: **${rat(p1Live)}**`, `H2H wins: **${p1w}**`, `Win prob: **${winProb(p1Live, p2Live)}%**`].join('\n'),
        inline: true,
      },
      {
        name: p2.name,
        value: [`Rating: **${rat(p2Live)}**`, `H2H wins: **${p2w}**`, `Win prob: **${winProb(p2Live, p1Live)}%**`].join('\n'),
        inline: true,
      },
      {
        name: 'Head-to-Head Record',
        value: total > 0
          ? `${p1.name} **${p1w}** – **${p2w}** ${p2.name}  _(${total} match${total !== 1 ? 'es' : ''})_`
          : '_No matches played yet_',
      },
      ...(recentLines ? [{ name: 'Recent Matches', value: recentLines }] : [])
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
  const playerRd   = computeRDLive(player);

  const gains = allPlayers
    .filter(p => p.id !== player.id)
    .map(opp => {
      const oppRd   = computeRDLive(opp);
      const result  = g2Update({ rating: player.rating, rd: playerRd }, [{ rating: opp.rating, rd: oppRd, s: 1 }]);
      const gain    = Math.round((result.rating - player.rating) * 10) / 10;
      const prob    = parseFloat(winProb({ ...player, rd: playerRd }, { ...opp, rd: oppRd }));
      const expected = Math.round(gain * (prob / 100) * 10) / 10;
      return { opp, oppRd, gain, prob: prob.toFixed(1), expected };
    })
    .sort((a, b) => b.expected - a.expected)
    .slice(0, 3);

  if (!gains.length) return message.reply('No other players found.');

  const medals = ['🥇', '🥈', '🥉'];
  const lines  = gains.map((g, i) =>
    `${medals[i]} **${g.opp.name}** — **+${g.gain} pts** if you win  _(${g.prob}% chance)_\n\u3000Expected gain: **+${g.expected}** · ${r2(g.opp.rating)} ±${r2(g.oppRd)} RD`
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
  const losses  = matches.filter(m => m.loserId === player.id);
  if (!losses.length) return message.reply(`**${player.name}** has never lost a match. Unbeatable! 🐐`);

  const beatCount = {};
  for (const m of losses) beatCount[m.winnerName] = (beatCount[m.winnerName] || 0) + 1;

  const sorted = Object.entries(beatCount).sort((a, b) => b[1] - a[1]);
  const lines  = sorted.slice(0, 5).map(([name, count], i) =>
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
  const matches   = await getAllMatches();
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
  const cutoff  = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const recent = matches.filter(m => {
    const ts = m.date?.toDate ? m.date.toDate().getTime() : new Date(m.date).getTime();
    return ts >= cutoff;
  });

  if (!recent.length) return message.reply('No matches in the last 7 days.');

  const gains = {};
  for (const m of recent) {
    if (m.p1name) gains[m.p1name] = (gains[m.p1name] || 0) + (m.p1delta || 0);
    if (m.p2name) gains[m.p2name] = (gains[m.p2name] || 0) + (m.p2delta || 0);
  }

  const sorted = Object.entries(gains).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const lines  = sorted.map(([name, delta], i) =>
    `${rankEmoji(i + 1)} **${name}** — ${signed(Math.round(delta * 10) / 10)} pts this week`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x7ec8a0)
    .setTitle('📈 Hottest Players This Week')
    .setDescription(lines)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── COMMAND: ttt add [player] ─────────────────────────────────────────────────
async function cmdAddPlayer(message, args) {
  if (!args.length) return message.reply('Usage: `ttt add [name]`');
  const name = args.join(' ').trim();

  const existing = await findPlayer(name);
  if (existing) return message.reply(`❌ **${existing.name}** already exists on the leaderboard.`);

  const anchor = _rdNewAnchor(120, Date.now());
  await db.collection('players').add({
    name,
    rating:      1500,
    rd:          120,
    rdAnchorRD:  anchor.rdAnchorRD,
    rdAnchorSec: anchor.rdAnchorSec,
    wins:        0,
    losses:      0,
    createdAt:   FieldValue.serverTimestamp(),
  });

  const embed = new EmbedBuilder()
    .setColor(0x7ec8a0)
    .setTitle('✅ Player Added')
    .setDescription(`**${name}** has joined the leaderboard with a starting rating of **1500**.`)
    .setFooter(footer())
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ── DISCORD CLIENT ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', async () => {
  console.log(`✅ TTTIW bot ready as ${client.user.tag}`);
  if (CHANNEL_ID) console.log(`📌 Watching channels: ${CHANNEL_ID.join(', ')}`);
  else console.log('📌 Watching all channels');
  if (INTAKE_CHANNEL_ID) {
    const ch = await client.channels.fetch(INTAKE_CHANNEL_ID).catch(e => { console.log('INTAKE FETCH ERROR:', e.message); return null; });
    console.log('INTAKE CHANNEL:', ch?.name, ch?.type, ch?.guildId);
  }
});

client.on('messageCreate', async message => {
  console.log(`[msg] channel=${message.channelId} webhook=${message.webhookId ?? 'none'} content=${message.content}`);
  const intakeChannelId = CHANNEL_ID?.[1] ?? INTAKE_CHANNEL_ID ?? null;
  const isIntake = intakeChannelId && message.channelId === intakeChannelId;

  // Intake channel: only allow webhook messages, parse as match and repost to main channel
  if (isIntake) {
    if (!message.webhookId) return; // ignore anything that isn't the Arduino webhook
    const content = message.content.trim();
    const parsed  = parseMatchMessage(content);
    if (!parsed) return;

    const { winnerStr, loserStr, s1, s2, format } = parsed;
    const scoreStr = s1 != null ? `${s1}-${s2}` : null;

    const outputChannelId = CHANNEL_ID?.[0];
    if (!outputChannelId) return;
    const outputChannel = await client.channels.fetch(outputChannelId).catch(() => null);
    if (!outputChannel) return;

    const [winner, loser] = await Promise.all([findPlayer(winnerStr), findPlayer(loserStr)]);
    if (!winner || !loser || winner.id === loser.id) return;

    try {
      const result = await submitMatch(winner, loser, scoreStr, format);
      const embed  = await buildResultEmbed(winner, loser, result, scoreStr);
      await outputChannel.send({ embeds: [embed] });
    } catch (err) {
      console.error('Intake match submission error:', err);
    }
    return;
  }

  if (message.author.bot) return;
  if (CHANNEL_ID && !CHANNEL_ID.includes(message.channelId)) return;

  const content = message.content.trim();

  // ── PREFIX COMMANDS ──
  if (content.toLowerCase().startsWith(PREFIX + ' ') || content.toLowerCase() === PREFIX) {
    const rest  = content.slice(PREFIX.length).trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const cmd   = parts[0]?.toLowerCase();
    const sub   = parts[1]?.toLowerCase();

    await message.channel.sendTyping();
    try {
      if (!cmd || cmd === 'help')             return await cmdHelp(message);
      if (cmd === 'stats')                    return await cmdStats(message, parts.slice(1));
      if (cmd === 'history')                  return await cmdHistory(message, parts.slice(1));
      if (cmd === 'rank')                     return await cmdRank(message, parts.slice(1));
      if (cmd === 'rd')                       return await cmdRD(message, parts.slice(1));
      if (cmd === 'top')                      return await cmdTop(message);
      if (cmd === 'predict')                  return await cmdPredict(message, parts.slice(1));
      if (cmd === 'vs')                       return await cmdVs(message, parts.slice(1));
      if (cmd === 'rating' && sub === 'farm') return await cmdRatingFarm(message, parts.slice(2));
      if (cmd === 'streak')                   return await cmdStreak(message);
      if (cmd === 'nemesis')                  return await cmdNemesis(message, parts.slice(1));
      if (cmd === 'rivals')                   return await cmdRivals(message);
      if (cmd === 'hot')                      return await cmdHot(message);
      if (cmd === 'add')                      return await cmdAddPlayer(message, parts.slice(1));
    } catch (err) {
      console.error('Command error:', err);
      return message.reply(`❌ Error: ${err.message}`);
    }
    return;
  }

  // ── MATCH REPORTING ──
  const parsed = parseMatchMessage(content);
  if (!parsed) return;

  const { winnerStr, loserStr, s1, s2, format } = parsed;
  const scoreStr = s1 != null ? `${s1}-${s2}` : null;

  if (s1 != null && parseInt(s1) <= parseInt(s2)) {
    return message.reply(
      `❌ First player is the winner — their score (${s1}) should be higher than the loser's (${s2}). ` +
      `Did you mean \`${loserStr} ${winnerStr} ${s2}-${s1}\`?`
    );
  }

  await message.channel.sendTyping();
  const [winner, loser] = await Promise.all([findPlayer(winnerStr), findPlayer(loserStr)]);
  if (!winner) return message.reply(`❌ Player not found: **${winnerStr}** — check spelling matches the leaderboard.`);
  if (!loser)  return message.reply(`❌ Player not found: **${loserStr}** — check spelling matches the leaderboard.`);
  if (winner.id === loser.id) return message.reply(`❌ A player can't play themselves!`);

  try {
    const result = await submitMatch(winner, loser, scoreStr, format);
    const embed  = await buildResultEmbed(winner, loser, result, scoreStr);
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('Match submission error:', err);
    await message.reply(`❌ Error submitting match: ${err.message}`);
  }
});

// ── WEBSITE MATCH WATCHER ─────────────────────────────────────────────────────
let _watcherReady = false;

client.once('ready', () => {
  const channelId = CHANNEL_ID?.[0];
  if (!channelId) { console.log('⚠️  No CHANNEL_ID set — website match watcher disabled.'); return; }

  const startedAt = new Date();

  db.collection('matches')
    .where('date', '>', startedAt)
    .orderBy('date', 'asc')
    .onSnapshot(async snap => {
      if (!_watcherReady) { _watcherReady = true; return; }
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const m = { id: change.doc.id, ...change.doc.data() };
        if (m.source === 'discord') continue;
        try {
          const channel = await client.channels.fetch(channelId);
          if (!channel) continue;

          const formatTag = m.format && m.format !== 11 ? ` [ft${m.format}]` : '';
          const scoreStr  = m.matchScore || null;
          const wDelta    = m.p1delta ?? 0;
          const lDelta    = m.p2delta ?? 0;
          const rdLine    = (oldRd, newRd) => {
            if (oldRd == null || newRd == null) return '';
            const d = Math.round((newRd - oldRd) * 10) / 10;
            return `RD: ±${r2(oldRd)} → ±${r2(newRd)} (${signed(d)})`;
          };

          const lb    = await getLeaderboard();
          const wRank = lb.findIndex(p => p.id === m.p1id) + 1;
          const lRank = lb.findIndex(p => p.id === m.p2id) + 1;
          const top5  = lb.slice(0, 5).map((p, i) => {
            const tag = p.id === m.p1id ? ' ← W' : p.id === m.p2id ? ' ← L' : '';
            return `${rankEmoji(i + 1)} **${p.name}** — ${rat(p)}${tag}`;
          }).join('\n');

          const embed = new EmbedBuilder()
            .setColor(0xE5B25D)
            .setTitle(`⚡ ${m.p1name} def. ${m.p2name}${scoreStr ? `  ${scoreStr}` : ''}${formatTag}`)
            .addFields(
              {
                name: `🏆 ${m.p1name}`,
                value: [
                  `${r2(m.p1oldRating)} → **${r2(m.p1newRating)}** (${signed(wDelta)})`,
                  rdLine(m.p1oldRD, m.p1newRD),
                  wRank ? `Rank: ${rankEmoji(wRank)}` : '_Unranked_',
                ].filter(Boolean).join('\n'),
                inline: true,
              },
              {
                name: `😔 ${m.p2name}`,
                value: [
                  `${r2(m.p2oldRating)} → **${r2(m.p2newRating)}** (${signed(lDelta)})`,
                  rdLine(m.p2oldRD, m.p2newRD),
                  lRank ? `Rank: ${rankEmoji(lRank)}` : '_Unranked_',
                ].filter(Boolean).join('\n'),
                inline: true,
              },
              { name: '📊 Top 5 Standings', value: top5 || '_No ranked players yet_' }
            )
            .setFooter({ text: 'TTTIW · Table Tennis Texas InventionWorks · via website' })
            .setTimestamp();

          await channel.send({ embeds: [embed] });
        } catch (err) {
          console.error('Website match watcher error:', err);
        }
      }
    }, err => console.error('Firestore match watcher error:', err));

  console.log(`👁️  Watching Firestore for website matches → channel ${channelId}`);
});

import http from 'http';
http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000);

client.login(DISCORD_TOKEN);