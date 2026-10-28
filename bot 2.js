// Telegram front-end for the requester agent. All hiring/verification logic lives in hire.js.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { Telegraf, Markup } from 'telegraf';
import { ethers } from 'ethers';
import { env, rpc, escrowAt, ERC20, preflight } from './lib.js';

await preflight('bot');
import { hire, link } from './hire.js';
import { registerActions, actionsPreflight } from './actions.js';

const bot = new Telegraf(env.BOT_TOKEN);
bot.catch((e) => console.error('bot error', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e?.message || e)); // one failed Telegram reply or bad update must not kill the bot
// Independent judge: users cannot approve/reject. Only this key can settle.
const verifierWallet = new ethers.Wallet(env.VERIFIER_KEY, rpc);
const key = crypto.scryptSync(env.WALLET_SECRET, 'metis-research', 32);
const DB = env.WALLET_DB || 'wallets.json'; // point to a persistent volume in production
try { fs.accessSync(path.dirname(path.resolve(DB)), fs.constants.W_OK); } catch { console.error('WALLET_DB folder is not writable: ' + DB + ' (on Railway, add a Volume mounted at /data)'); process.exit(1); }
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : {};
const enc = (pk) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const d = Buffer.concat([c.update(pk, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map((b) => b.toString('hex')).join('.'); };
const dec = (s) => { const [iv, tag, d] = s.split('.').map((h) => Buffer.from(h, 'hex'));
  const c = crypto.createDecipheriv('aes-256-gcm', key, iv); c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8'); };
const addrToUid = new Map();
for (const [uid, e] of Object.entries(db)) { try { addrToUid.set(new ethers.Wallet(dec(e)).address.toLowerCase(), Number(uid)); } catch { /* skip unreadable */ } }
const uidFor = (addr) => addrToUid.get(String(addr).toLowerCase());
const walletFor = (id) => {
  if (!db[id]) { const nw = ethers.Wallet.createRandom(); addrToUid.set(nw.address.toLowerCase(), Number(id)); db[id] = enc(nw.privateKey); fs.writeFileSync(DB + '.tmp', JSON.stringify(db)); fs.renameSync(DB + '.tmp', DB); }
  return new ethers.Wallet(dec(db[id]), rpc);
};
const err = (e) => 'Failed: ' + (e.shortMessage || e.message);

bot.start((ctx) => ctx.reply('Metis Agent 🌿\n\nDO THINGS ON-CHAIN (you pay only gas; capped at ~10 USD per action):\n/wallet - your address and balances\n/swap metis 0.5 or /swap usdc 2 - Netswap\n/supply 2 and /withdraw 2 - Aave V3\n/position - your balances and Aave deposit\nEvery action is dry-run first and needs your Confirm tap.\n\nHIRE THE ANALYST AGENT (1 USDC):\n/check <0xaddress> - paid on-chain due-diligence report, facts re-verified against the chain by an independent verifier\n/refund <id> - if the provider never delivered\n\n/exportkey - take your wallet private key (the wallet is held by this bot: keep small amounts)'));

bot.command('exportkey', (ctx) => ctx.chat.type !== 'private' ? ctx.reply('Send /exportkey to me in a private chat, never in a group.') : ctx.reply('This shows your wallet private key in this chat. Anyone who sees it controls your funds. Delete the message after you save it. Continue?',
  Markup.inlineKeyboard([Markup.button.callback('Show my key', 'xk:' + ctx.from.id), Markup.button.callback('Cancel', 'xn')])));
bot.action('xn', async (ctx) => { await ctx.answerCbQuery('Cancelled').catch(() => {}); await ctx.editMessageReplyMarkup().catch(() => {}); });
bot.action(/^xk:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {}); await ctx.editMessageReplyMarkup().catch(() => {});
  if (String(ctx.from.id) !== ctx.match[1] || ctx.chat?.type !== 'private') return;
  walletFor(ctx.from.id);
  const m = await ctx.reply('Private key (delete this message after saving it; I will also delete it in 60 seconds):\n' + dec(db[ctx.from.id]), { protect_content: true });
  setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 60000);
});

bot.command('wallet', async (ctx) => {
  try {
    const w = walletFor(ctx.from.id), t = new ethers.Contract(env.TOKEN, ERC20, rpc);
    const [m, u] = await Promise.all([rpc.getBalance(w.address), t.balanceOf(w.address)]);
    await ctx.reply(`Address:\n${w.address}\nMETIS: ${ethers.formatEther(m)}\nUSDC: ${ethers.formatUnits(u, 6)}\n\nFund it yourself: you need METIS for gas + USDC (each report costs ~${env.PRICE_USDC || 1} USDC).`);
  } catch (e) { console.error('wallet error', e); await ctx.reply(err(e)).catch(() => {}); }
});

const active = new Set(), last = new Map();
async function runCheck(ctx, addr) {
  const uid = ctx.from.id;
  try {
    const w = walletFor(uid);
    const [gas, usdc] = [await rpc.getBalance(w.address), await new ethers.Contract(env.TOKEN, ERC20, rpc).balanceOf(w.address)];
    if (gas < ethers.parseEther('0.002') || usdc < ethers.parseUnits(env.PRICE_USDC || '1', 6))
      return ctx.reply(`Your wallet needs funds first. Send METIS (gas, ~0.01) and at least ${env.PRICE_USDC || 1} USDC on Metis Andromeda to:\n${w.address}\n\nThen send /check again. (/wallet shows your balance)`);
    const r = await hire({ wallet: w, verifierWallet, question: `On-chain due diligence report for ${addr}`, log: (m) => ctx.reply(m) });
    if (r.paid) await ctx.reply(`✅ Facts re-verified on-chain, provider paid.\n${link(r.tx)}\n\n${r.answer}`);
    else await ctx.reply(`❌ Verifier rejected: ${r.reason}. Payment blocked, you were refunded. Reason is recorded on-chain.\n${link(r.tx)}`);
  } catch (e) {
    await ctx.reply(err(e) + (e.taskId ? `\nTask #${e.taskId} is still escrowed. If never delivered: /refund ${e.taskId} after 1h. If delivered, the verifier settles it, or it auto-pays the provider after 24h.` : '')).catch(() => {});
  } finally { active.delete(uid); }
}

bot.command('check', (ctx) => {
  const addr = ctx.message.text.split(' ')[1], uid = ctx.from.id;
  if (!addr || !ethers.isAddress(addr)) return ctx.reply('Usage: /check 0xTokenOrWalletAddress (on Metis Andromeda)');
  if (active.has(uid)) return ctx.reply('Your previous request is still running, please wait.');
  if (Date.now() - (last.get(uid) || 0) < 15000) return ctx.reply('Please wait a few seconds between requests.');
  active.add(uid); last.set(uid, Date.now());
  runCheck(ctx, addr); // not awaited: a request takes ~1 min and must not block other users
});

bot.command('refund', async (ctx) => {
  const id = ctx.message.text.split(' ')[1]; if (!id) return ctx.reply('Usage: /refund <id>');
  try { const r = await (await escrowAt(walletFor(ctx.from.id)).refundExpired(id)).wait(); ctx.reply(`✅ Refunded #${id}\n${link(r.hash)}`); }
  catch (e) { ctx.reply(err(e)); }
});

const actionProblems = await actionsPreflight();
if (actionProblems.length) {
  console.error('⚠️ Action mode disabled:', actionProblems.join('; '));
  for (const c of ['swap', 'supply', 'withdraw', 'position']) bot.command(c, (ctx) => ctx.reply('Action mode is temporarily unavailable.'));
} else { registerActions(bot, { walletFor, link }); console.log('✅ action mode checks passed'); }
bot.launch(); console.log('Due diligence task agent bot running');
