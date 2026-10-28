// Agent-to-agent mode: no human, no Telegram. One agent hires another, pays via escrow, verifies, settles.
// Usage: node src/agent.js 0xAddressToAnalyze
import { ethers } from 'ethers';
import { env, rpc } from './lib.js';
import { hire, link } from './hire.js';

const target = process.argv[2];
if (!target || !ethers.isAddress(target)) { console.error('Usage: node src/agent.js 0xAddress'); process.exit(1); }
const wallet = new ethers.Wallet(env.REQUESTER_KEY, rpc);
const verifierWallet = new ethers.Wallet(env.VERIFIER_KEY, rpc);
console.log('Requester agent:', wallet.address);
try {
  const r = await hire({ wallet, verifierWallet, question: `On-chain due diligence report for ${target}`, log: (m) => console.log(m) });
  if (r.paid) console.log(`✅ Verified, provider paid. ${link(r.tx)}\n\n${r.answer}`);
  else console.log(`❌ Rejected (${r.reason}). Refunded. ${link(r.tx)}`);
} catch (e) { console.error('Failed:', e.shortMessage || e.message, e.taskId ? `(task #${e.taskId} still escrowed)` : ''); process.exit(1); }
