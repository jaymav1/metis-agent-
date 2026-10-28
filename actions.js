// "Action mode": real on-chain actions on Metis for the user's own bot wallet (Netswap swap, Aave V3 supply/withdraw).
// Every action: dry-run first, shown with a Confirm button, capped in size, slippage-limited. Users pay only gas.
import crypto from 'crypto';
import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { env, rpc, ERC20 } from './lib.js';

// Addresses verified against the Metis explorer / Aave address book (Oct 2026). Override via env if they change.
const ROUTER = env.NETSWAP_ROUTER || '0x1E876cCe41B7b844FDe09E38Fa1cf00f213bFf56';
const METIS = '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000'; // the router's "Metis" path token
const AAVE_POOL = env.AAVE_POOL || '0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57';
const AUSDC = env.AAVE_ATOKEN || '0x885C8AEC5867571582545F894A5906971dB9bf27'; // Aave V3 Metis aUSDC (aave-address-book)
const USDC = env.TOKEN;
const MAX_USD = Number(env.ACTION_MAX_USDC || 10);   // per-action cap
const SLIPPAGE_BPS = BigInt(env.SLIPPAGE_BPS || 100); // 1%
const GAS_RESERVE = ethers.parseEther('0.02');         // METIS always kept for gas

const ROUTER_ABI = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function swapExactMetisForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForMetis(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])',
];
const POOL_ABI = [
  'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)',
  'function withdraw(address asset,uint256 amount,address to) returns (uint256)',
];
const AT_ABI = ['function UNDERLYING_ASSET_ADDRESS() view returns (address)', 'function balanceOf(address) view returns (uint256)'];

const fmtU = (v) => ethers.formatUnits(v, 6);
const fmtM = (v) => Number(ethers.formatEther(v)).toFixed(4);
const parseAmt = (s, dec) => { try { const v = ethers.parseUnits(String(s), dec); return v > 0n ? v : null; } catch { return null; } };

const aUsdc = async () => AUSDC;

const pending = new Map();   // id -> { uid, steps[], text, expires }
const busy = new Set();      // one running action per user

// Builds the list of transactions for an action. Each step = { label, send(wallet) }.
async function plan(w, kind, arg) {
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, rpc);
  const usdc = new ethers.Contract(USDC, ERC20, rpc);
  const [gas, bal] = [await rpc.getBalance(w.address), await usdc.balanceOf(w.address)];
  if (gas < GAS_RESERVE) throw new Error(`Add METIS for gas first (you have ${fmtM(gas)}, need at least 0.02 kept free).`);
  const deadline = () => Math.floor(Date.now() / 1000) + 600;

  if (kind === 'swap_metis') { // METIS -> USDC
    const amt = parseAmt(arg, 18); if (!amt) throw new Error('Usage: /swap metis 0.5');
    if (amt + GAS_RESERVE > gas) throw new Error('Not enough METIS (0.02 is kept for gas).');
    const out = (await router.getAmountsOut(amt, [METIS, USDC]))[1];
    if (Number(fmtU(out)) > MAX_USD) throw new Error(`Max ${MAX_USD} USD per action while in beta.`);
    const min = out - (out * SLIPPAGE_BPS) / 10000n;
    const r = new ethers.Contract(ROUTER, ROUTER_ABI, w);
    await r.swapExactMetisForTokens.staticCall(min, [METIS, USDC], w.address, deadline(), { value: amt }); // dry run
    return { text: `Swap ${ethers.formatEther(amt)} METIS -> about ${fmtU(out)} USDC (min ${fmtU(min)}, ${SLIPPAGE_BPS / 100n}% slippage) on Netswap.`,
      steps: [{ label: 'swap', send: (x) => new ethers.Contract(ROUTER, ROUTER_ABI, x).swapExactMetisForTokens(min, [METIS, USDC], x.address, deadline(), { value: amt }) }] };
  }
  if (kind === 'swap_usdc') { // USDC -> METIS
    const amt = parseAmt(arg, 6); if (!amt) throw new Error('Usage: /swap usdc 2');
    if (Number(fmtU(amt)) > MAX_USD) throw new Error(`Max ${MAX_USD} USD per action while in beta.`);
    if (amt > bal) throw new Error(`You only have ${fmtU(bal)} USDC.`);
    const out = (await router.getAmountsOut(amt, [USDC, METIS]))[1];
    const min = out - (out * SLIPPAGE_BPS) / 10000n;
    const steps = [];
    if ((await usdc.allowance(w.address, ROUTER)) < amt)
      steps.push({ label: 'approve', send: (x) => new ethers.Contract(USDC, ERC20, x).approve(ROUTER, amt) });
    else await new ethers.Contract(ROUTER, ROUTER_ABI, w).swapExactTokensForMetis.staticCall(amt, min, [USDC, METIS], w.address, deadline());
    steps.push({ label: 'swap', dry: (x) => new ethers.Contract(ROUTER, ROUTER_ABI, x).swapExactTokensForMetis.staticCall(amt, min, [USDC, METIS], x.address, deadline()),
      send: (x) => new ethers.Contract(ROUTER, ROUTER_ABI, x).swapExactTokensForMetis(amt, min, [USDC, METIS], x.address, deadline()) });
    return { text: `Swap ${fmtU(amt)} USDC -> about ${fmtM(out)} METIS (min ${fmtM(min)}) on Netswap. ${steps.length} transaction(s).`, steps };
  }
  if (kind === 'supply') {
    const amt = parseAmt(arg, 6); if (!amt) throw new Error('Usage: /supply 2');
    if (Number(fmtU(amt)) > MAX_USD) throw new Error(`Max ${MAX_USD} USD per action while in beta.`);
    if (amt > bal) throw new Error(`You only have ${fmtU(bal)} USDC.`);
    const steps = [];
    if ((await usdc.allowance(w.address, AAVE_POOL)) < amt)
      steps.push({ label: 'approve', send: (x) => new ethers.Contract(USDC, ERC20, x).approve(AAVE_POOL, amt) });
    else await new ethers.Contract(AAVE_POOL, POOL_ABI, w).supply.staticCall(USDC, amt, w.address, 0);
    steps.push({ label: 'supply', dry: (x) => new ethers.Contract(AAVE_POOL, POOL_ABI, x).supply.staticCall(USDC, amt, x.address, 0),
      send: (x) => new ethers.Contract(AAVE_POOL, POOL_ABI, x).supply(USDC, amt, x.address, 0) });
    return { text: `Supply ${fmtU(amt)} USDC to Aave V3 on Metis (earns interest, withdraw any time). ${steps.length} transaction(s).`, steps };
  }
  if (kind === 'withdraw') {
    const at = new ethers.Contract(await aUsdc(), ERC20, rpc), have = await at.balanceOf(w.address);
    if (have === 0n) throw new Error('You have nothing supplied on Aave. Try /supply 2 first.');
    const all = String(arg).toLowerCase() === 'all';
    const amt = all ? have : parseAmt(arg, 6); if (!amt) throw new Error('Usage: /withdraw 1  or  /withdraw all');
    if (amt > have) throw new Error(`You only have ${fmtU(have)} USDC supplied.`);
    const send = all ? ethers.MaxUint256 : amt;
    await new ethers.Contract(AAVE_POOL, POOL_ABI, w).withdraw.staticCall(USDC, send, w.address);
    return { text: `Withdraw ${all ? 'all (' + fmtU(have) + ')' : fmtU(amt)} USDC from Aave V3 to your wallet.`,
      steps: [{ label: 'withdraw', send: (x) => new ethers.Contract(AAVE_POOL, POOL_ABI, x).withdraw(USDC, send, x.address) }] };
  }
  throw new Error('unknown action');
}

export function registerActions(bot, { walletFor, link }) {
  const err = (e) => (e.shortMessage || e.reason || e.message || String(e)).slice(0, 200);

  async function propose(ctx, kind, arg) {
    const uid = ctx.from.id;
    if (busy.has(uid)) return ctx.reply('An action is still running, please wait.');
    try {
      const p = await plan(walletFor(uid), kind, arg);
      const id = crypto.randomBytes(6).toString('hex');
      pending.set(id, { uid, steps: p.steps, expires: Date.now() + 120000 });
      for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
      await ctx.reply(`${p.text}\n\nChecked against the chain just now. Each step is re-checked right before it is sent. Confirm within 2 minutes.`,
        Markup.inlineKeyboard([Markup.button.callback('✅ Confirm', 'ok:' + id), Markup.button.callback('Cancel', 'no:' + id)]));
    } catch (e) { await ctx.reply('Cannot do that: ' + err(e)); }
  }

  bot.command('swap', (ctx) => {
    const [, tok, amt] = ctx.message.text.trim().split(/\s+/);
    const t = (tok || '').toLowerCase();
    if (t !== 'metis' && t !== 'usdc') return ctx.reply('Usage:\n/swap metis 0.5  (METIS to USDC)\n/swap usdc 2  (USDC to METIS)');
    return propose(ctx, t === 'metis' ? 'swap_metis' : 'swap_usdc', amt);
  });
  bot.command('supply', (ctx) => propose(ctx, 'supply', ctx.message.text.trim().split(/\s+/)[1]));
  bot.command('withdraw', (ctx) => propose(ctx, 'withdraw', ctx.message.text.trim().split(/\s+/)[1]));

  bot.command('position', async (ctx) => {
    try {
      const w = walletFor(ctx.from.id);
      const [m, u, a] = await Promise.all([rpc.getBalance(w.address), new ethers.Contract(USDC, ERC20, rpc).balanceOf(w.address),
        aUsdc().then((t) => new ethers.Contract(t, ERC20, rpc).balanceOf(w.address))]);
      ctx.reply(`Wallet ${w.address}\nMETIS: ${fmtM(m)}\nUSDC: ${fmtU(u)}\nSupplied on Aave: ${fmtU(a)} USDC`);
    } catch (e) { ctx.reply('Failed: ' + err(e)); }
  });

  bot.action(/^no:(\w+)$/, async (ctx) => {
    const p = pending.get(ctx.match[1]);
    if (p && p.uid === ctx.from.id) pending.delete(ctx.match[1]);
    await ctx.answerCbQuery('Cancelled').catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
  });

  bot.action(/^ok:(\w+)$/, async (ctx) => {
    const id = ctx.match[1], uid = ctx.from.id, p = pending.get(id);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (!p || p.uid !== uid || p.expires < Date.now()) return ctx.reply('That request expired. Send the command again.');
    if (busy.has(uid)) return ctx.reply('An action is still running, please wait.');
    pending.delete(id); busy.add(uid);
    try {
      const w = walletFor(uid);
      for (const s of p.steps) {
        if (s.dry) await s.dry(w); // re-check right before sending (after any approval has been mined)
        const rc = await (await s.send(w)).wait();
        await ctx.reply(`✅ ${s.label} done\n${link(rc.hash)}`);
      }
    } catch (e) { await ctx.reply('Failed: ' + err(e) + '\nNothing further was sent. Check /position.'); }
    finally { busy.delete(uid); }
  });
}

// Startup check of every external address. Returns a list of problems (empty = ok). The bot disables action mode if any.
export async function actionsPreflight() {
  const bad = [];
  try {
    for (const [n, a] of [['Netswap router', ROUTER], ['Aave pool', AAVE_POOL], ['aUSDC', AUSDC]])
      if ((await rpc.getCode(a)) === '0x') bad.push(`${n} has no code at ${a}`);
    if (!bad.length) {
      const q = await new ethers.Contract(ROUTER, ROUTER_ABI, rpc).getAmountsOut(ethers.parseUnits('1', 6), [USDC, METIS]).catch(() => null);
      if (!q || q[1] === 0n) bad.push('Netswap has no usable USDC/METIS route');
      const u = await new ethers.Contract(AUSDC, AT_ABI, rpc).UNDERLYING_ASSET_ADDRESS().catch(() => null);
      if (!u || u.toLowerCase() !== USDC.toLowerCase()) bad.push('aUSDC underlying is not the configured TOKEN');
    }
  } catch (e) { bad.push('check failed: ' + (e.shortMessage || e.message)); }
  return bad;
}
