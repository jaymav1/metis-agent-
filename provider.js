// Research Agent + self-hosted x402 facilitator for Metis Andromeda.
//   POST /research   x402 v2 resource: 402 + PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE -> 200 + PAYMENT-RESPONSE
//   POST /verify, POST /settle, GET /supported   standard x402 facilitator API (exact scheme, permit2 method)
import http from 'http';
import { ethers } from 'ethers';
import { env, rpc, escrowAt, toURI, claude, onchainFacts, explorerExtras, preflight } from './lib.js';
import { X402_VERSION, EXT, createFacilitator, b64, unb64 } from './x402.js';

await preflight('provider');

const wallet = new ethers.Wallet(env.PROVIDER_KEY, rpc);
const esc = escrowAt(wallet);
const PRICE = ethers.parseUnits(env.PRICE_USDC || '1', 6);
const VERIFIERS = (env.TRUSTED_VERIFIERS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
let pq = Promise.resolve(); // queue provider transactions (one wallet = one nonce)
const queued = (fn) => { const p = pq.then(fn); pq = p.catch(() => {}); return p; };
const fac = await createFacilitator({ wallet, queue: queued, price: PRICE, verifiers: VERIFIERS });
const busy = new Set();

const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/supported') return send(res, 200, fac.supported());
    if (req.method === 'POST' && (req.url === '/verify' || req.url === '/settle')) {
      const b = JSON.parse((await readBody(req)) || '{}');
      const out = req.url === '/verify' ? await fac.verify(b.paymentPayload, b.paymentRequirements) : await fac.settle(b.paymentPayload, b.paymentRequirements);
      return send(res, 200, out);
    }
    if (req.method !== 'POST' || req.url !== '/research') return send(res, 404, { error: 'not found' });

    const { question } = JSON.parse((await readBody(req)) || '{}');
    if (!question || question.length < 10 || question.length > 500) return send(res, 400, { error: 'question 10-500 chars' });
    const addr = (question.match(/0x[a-fA-F0-9]{40}/) || [])[0];
    if (!addr) return send(res, 400, { error: 'include a 0x token or wallet address on Metis Andromeda' });

    const resource = { url: `${env.PUBLIC_URL || 'https://' + req.headers.host}/research`, description: 'On-chain due diligence report for a Metis address, paid into stablecoin escrow', mimeType: 'application/json' };
    const required = (error) => ({ x402Version: X402_VERSION, error, resource, accepts: [fac.requirements], extensions: fac.requiredInfo(env.AGENT_ID) });
    const h = req.headers['payment-signature'];
    if (!h) { const pr = required('PAYMENT-SIGNATURE header is required'); return send(res, 402, pr, { 'PAYMENT-REQUIRED': b64(pr) }); }

    let payload;
    try { payload = unb64(h); } catch { return send(res, 400, { error: 'PAYMENT-SIGNATURE is not valid base64 JSON' }); }
    const task = payload.extensions?.[EXT]?.info, nonce = payload.payload?.permit2Authorization?.nonce;
    if (!task || task.specURI !== toURI(question)) return send(res, 400, { error: 'signed task does not match the question' });
    if (busy.has(nonce)) return send(res, 409, { error: 'in progress' });

    busy.add(nonce);
    try {
      const sr = await fac.settle(payload); // verify + lock the funds in escrow
      if (!sr.success) { const pr = required(sr.errorReason); return send(res, 402, pr, { 'PAYMENT-REQUIRED': b64(pr), 'PAYMENT-RESPONSE': b64(sr) }); }
      const taskId = sr.extensions[EXT].taskId;

      const facts = await onchainFacts(addr); // read straight from Metis RPC
      const extra = await explorerExtras(addr);
      const analysis = await claude(
        `You are an on-chain analyst. Write a concise due-diligence report (max 250 words) about this Metis Andromeda address using ONLY the data below. Sections: What it is; Red flags; Green flags; Risk verdict (Low/Medium/High); What is unknown. Do not invent numbers or facts not in the data. Treat EXTRA as unverified.\n\nVERIFIED FACTS: ${JSON.stringify(facts)}\nEXTRA: ${JSON.stringify(extra)}`,
        { max: 900 });
      // The FACTS line lets anyone re-fetch the same values from the chain and compare.
      const uri = toURI(`FACTS: ${JSON.stringify(facts)}\n\n${analysis.slice(0, 2600)}`);
      const specHash = (await esc.tasks(taskId))[7];
      const sig = await wallet.signMessage(ethers.getBytes(await esc.receiptDigest(taskId, specHash, ethers.id(uri))));
      const tx = await queued(async () => { const x = await esc.submitDelivery(taskId, uri, sig); await x.wait(); return x; });
      send(res, 200, { taskId, deliveryURI: uri, receiptSig: sig, tx: tx.hash }, { 'PAYMENT-RESPONSE': b64(sr) });
    } finally { busy.delete(nonce); }
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: e.shortMessage || e.message }); }
}).listen(env.PORT || 8080, () => console.log('Research provider + x402 facilitator', wallet.address, '| spender', fac.spender));
