import 'dotenv/config';
import { ethers } from 'ethers';
export const env = process.env;
export const rpc = new ethers.JsonRpcProvider(env.RPC_URL || 'https://andromeda.metis.io/?owner=1088');
export const STATUS = ['None', 'Open', 'Accepted', 'Delivered', 'Released', 'Refunded'];
export const ERC20 = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
export const ESCROW_ABI = [
  'function createTaskX402(tuple(tuple(address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit, address owner, uint256 validAfter, bytes signature, tuple(address provider,address verifier,uint64 deadline,string specURI) p) returns (uint256)',
  'function nextId() view returns (uint256)', 'function permit2() view returns (address)', 'function x402Proxy() view returns (address)',
  'function submitDelivery(uint256,string,bytes)',
  'function approve(uint256)', 'function reject(uint256,string)', 'function claim(uint256)', 'function refundExpired(uint256)',
  'function receiptDigest(uint256,bytes32,bytes32) view returns (bytes32)',
  'function tasks(uint256) view returns (address,address,address,uint256,uint64,uint64,uint8,bytes32,bytes32,address)',
  'function completed(address) view returns (uint32)', 'function refunded(address) view returns (uint32)',
  'event Created(uint256 indexed id,address indexed requester,address token,uint256 amount,bytes32 specHash,string specURI,address verifier)',
];
export const escrowAt = (s) => new ethers.Contract(env.ESCROW, ESCROW_ABI, s);
// Content is stored on-chain as a data: URI so proofs never depend on a private database.
export const toURI = (t) => 'data:text/plain;charset=utf-8;base64,' + Buffer.from(t).toString('base64');
export const fromURI = (u) => Buffer.from(u.split(',')[1], 'base64').toString('utf8');

export async function claude(prompt, { search = false, max = 1500 } = {}) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env.MODEL || 'claude-sonnet-5-5', max_tokens: max,
      messages: [{ role: 'user', content: prompt }],
      ...(search ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] } : {}),
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'LLM error');
  return d.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ---- On-chain facts: anyone can re-fetch these from Metis and compare (this is what makes the report re-verifiable) ----
const TOKEN_READ = [
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
];
export async function onchainFacts(addr) {
  addr = ethers.getAddress(addr.toLowerCase());
  const [code, nonce, bal] = await Promise.all([rpc.getCode(addr), rpc.getTransactionCount(addr), rpc.getBalance(addr)]);
  const f = { chain: 'Metis Andromeda (1088)', address: addr, isContract: code !== '0x', codeBytes: (code.length - 2) / 2, nonce, metisBalance: ethers.formatEther(bal) };
  if (f.isContract) {
    const c = new ethers.Contract(addr, TOKEN_READ, rpc);
    try {
      const [name, symbol, decimals, supply] = await Promise.all([c.name(), c.symbol(), c.decimals(), c.totalSupply()]);
      f.token = { name, symbol, decimals: Number(decimals), totalSupply: ethers.formatUnits(supply, decimals), owner: await c.owner().catch(() => null) };
    } catch { /* not a standard ERC-20 */ }
  }
  return f;
}
// Best-effort extra context from a Blockscout-style explorer API (set EXPLORER_API). Not verified by the verifier.
export async function explorerExtras(addr) {
  if (!env.EXPLORER_API) return null;
  try {
    const g = async (p) => { const r = await fetch(env.EXPLORER_API + p, { signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; };
    const [info, counters] = await Promise.all([g(`/addresses/${addr}`), g(`/addresses/${addr}/counters`)]);
    const tok = info?.is_contract ? await g(`/tokens/${addr}`) : null;
    return { note: 'explorer API data, unverified', verifiedContract: info?.is_verified ?? null, creator: info?.creator_address_hash ?? null,
      txCount: counters?.transactions_count ?? null, tokenTransfers: counters?.token_transfers_count ?? null, holders: tok?.holders_count ?? null };
  } catch { return null; }
}

// Startup self-check: prints clear problems in the logs (important when you deploy from a phone and can't test locally).
export async function preflight(role) {
  const need = role === 'provider'
    ? ['ESCROW', 'TOKEN', 'ANTHROPIC_API_KEY', 'PROVIDER_KEY', 'TRUSTED_VERIFIERS']
    : ['ESCROW', 'TOKEN', 'ANTHROPIC_API_KEY', 'VERIFIER_KEY', 'BOT_TOKEN', 'WALLET_SECRET', 'WALLET_DB', 'PROVIDER_URL'];
  const missing = need.filter((k) => !env[k] || /^0x_|^$/.test(env[k]) && k !== 'WALLET_SECRET' && k !== 'WALLET_DB');
  if (missing.length) { console.error('❌ Missing or placeholder env vars:', missing.join(', ')); process.exit(1); }
  const bad = [];
  try {
    const net = await rpc.getNetwork();
    if (net.chainId !== 1088n) bad.push(`RPC chain ID is ${net.chainId}, expected 1088 (Metis Andromeda)`);
    if ((await rpc.getCode(env.ESCROW)) === '0x') bad.push('ESCROW has no contract code at that address (wrong address or wrong network)');
    else {
      const e = escrowAt(rpc); await e.nextId();
      if ((await rpc.getCode('0x000000000022D473030F116dDEE9F6B43aC78BA3')) === '0x') bad.push('Permit2 is not deployed on this chain');
      const p2 = await e.permit2().catch(() => null);
      if (!p2) bad.push('ESCROW is an old TaskEscrow without x402 support: redeploy the new contract');
      else if (p2.toLowerCase() !== '0x000000000022d473030f116ddee9f6b43ac78ba3') bad.push('ESCROW was deployed with a different Permit2 address: ' + p2);
    }
    const tk = new ethers.Contract(env.TOKEN, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], rpc);
    const [sym, dec] = [await tk.symbol(), Number(await tk.decimals())];
    console.log(`token: ${sym}, ${dec} decimals`);
    if (dec !== 6) bad.push(`TOKEN has ${dec} decimals, this code assumes 6`);
    const key = role === 'provider' ? env.PROVIDER_KEY : env.VERIFIER_KEY;
    const addr = new ethers.Wallet(key).address;
    const bal = await rpc.getBalance(addr);
    console.log(`${role === 'provider' ? 'provider' : 'verifier'} wallet ${addr}, ${ethers.formatEther(bal)} METIS`);
    if (bal < ethers.parseEther('0.01')) console.warn('⚠️ Low METIS balance: top up this wallet or settlements will fail');
    if (role === 'provider' && !env.TRUSTED_VERIFIERS.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).every((a) => ethers.isAddress(a))) bad.push('TRUSTED_VERIFIERS contains an invalid address');
  } catch (e) { bad.push('check failed: ' + (e.shortMessage || e.message)); }
  if (bad.length) { bad.forEach((b) => console.error('❌', b)); process.exit(1); }
  console.log('✅ self-check passed');
}
