// x402 v2, scheme "exact", transfer method "permit2".
// Why permit2: the real Metis m.USDC (0xEA32...1a21) is a bridged L2StandardERC20 without EIP-3009 or EIP-2612,
// so the other "exact" method (transferWithAuthorization) cannot work on it. Permit2 is deployed on Metis.
import { ethers } from 'ethers';
import { env, rpc, escrowAt, ERC20 } from './lib.js';

export const X402_VERSION = 2;
export const CHAIN_ID = 1088;
export const NETWORK = 'eip155:1088';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const EXT = 'escrow-task'; // x402 extension carrying the task details the payer commits to
const coder = ethers.AbiCoder.defaultAbiCoder();

export const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
export const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

// Same typed data as Permit2's permitWitnessTransferFrom with the x402 Witness {to, validAfter}.
export const TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }],
};
export const domain = { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 };

// Must match TaskEscrow.taskCommitment. The result is used as the Permit2 nonce, so the signature also
// binds provider, verifier, deadline and spec: the facilitator cannot swap them.
export function taskCommitment(escrow, owner, token, amount, task) {
  const h = ethers.keccak256(coder.encode(['address', 'uint256', 'address', 'address', 'uint256'], [escrow, CHAIN_ID, owner, token, amount]));
  return ethers.keccak256(coder.encode(['bytes32', 'address', 'address', 'uint64', 'bytes32'], [h, task.provider, task.verifier, task.deadline, ethers.id(task.specURI)]));
}

const lc = (x) => String(x).toLowerCase();
const typedValue = (a) => ({
  permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, spender: a.spender,
  nonce: BigInt(a.nonce), deadline: BigInt(a.deadline), witness: { to: a.witness.to, validAfter: BigInt(a.witness.validAfter) },
});

// ---------- client side ----------
export async function signExact({ wallet, requirements, spender, task, resource }) {
  const now = Math.floor(Date.now() / 1000);
  const amount = BigInt(requirements.amount);
  const a = {
    permitted: { token: requirements.asset, amount: amount.toString() }, spender,
    nonce: BigInt(taskCommitment(requirements.payTo, wallet.address, requirements.asset, amount, task)).toString(),
    deadline: String(now + requirements.maxTimeoutSeconds),
    witness: { to: requirements.payTo, validAfter: String(now - 600) },
  };
  const signature = await wallet.signTypedData(domain, TYPES, typedValue(a));
  return {
    x402Version: X402_VERSION, resource, accepted: requirements,
    payload: { signature, permit2Authorization: { ...a, from: wallet.address } },
    extensions: { [EXT]: { info: task } },
  };
}

// ---------- facilitator (self-hosted, Metis) ----------
export async function createFacilitator({ wallet, queue, price, verifiers }) {
  const escrowRead = escrowAt(rpc), escrowWrite = escrowAt(wallet);
  const proxy = await escrowRead.x402Proxy();
  const spender = proxy === ethers.ZeroAddress ? env.ESCROW : proxy;
  const token = new ethers.Contract(env.TOKEN, ERC20, rpc);
  const permit2 = new ethers.Contract(PERMIT2, ['function nonceBitmap(address,uint256) view returns (uint256)'], rpc);

  const requirements = {
    scheme: 'exact', network: NETWORK, amount: price.toString(), asset: env.TOKEN, payTo: env.ESCROW,
    maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'permit2' },
  };
  const requiredInfo = (agentId) => ({ [EXT]: { info: { provider: wallet.address, verifier: verifiers[0], escrow: env.ESCROW, spender, agentId: agentId || null } } });

  const args = (p) => {
    const a = p.payload.permit2Authorization, t = p.extensions[EXT].info;
    return [{ permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) },
      a.from, BigInt(a.witness.validAfter), p.payload.signature,
      { provider: t.provider, verifier: t.verifier, deadline: BigInt(t.deadline), specURI: t.specURI }];
  };

  // POST /verify semantics: read-only checks, in the order of the exact/permit2 spec.
  async function verify(p, req = requirements) {
    const bad = (invalidReason, payer) => ({ isValid: false, invalidReason, payer });
    try {
      if (p?.x402Version !== X402_VERSION) return bad('unsupported_x402_version');
      if (req.scheme !== 'exact' || req.network !== NETWORK || req.extra?.assetTransferMethod !== 'permit2') return bad('unsupported_scheme_or_network');
      if (lc(req.payTo) !== lc(env.ESCROW) || lc(req.asset) !== lc(env.TOKEN) || BigInt(req.amount) < price) return bad('requirements_not_accepted');
      const acc = p.accepted || {};
      for (const k of ['scheme', 'network', 'amount', 'asset', 'payTo']) if (lc(acc[k]) !== lc(req[k])) return bad('accepted_requirements_mismatch');
      const a = p.payload?.permit2Authorization, sig = p.payload?.signature, task = p.extensions?.[EXT]?.info;
      if (!a || !sig || !task) return bad('invalid_exact_evm_payload');
      const owner = ethers.getAddress(a.from), amount = BigInt(a.permitted.amount), now = BigInt(Math.floor(Date.now() / 1000));
      if (lc(a.permitted.token) !== lc(req.asset)) return bad('invalid_exact_evm_payload_token', owner);
      if (amount !== BigInt(req.amount)) return bad('invalid_exact_evm_payload_authorization_value', owner);
      if (lc(a.witness.to) !== lc(req.payTo)) return bad('invalid_exact_evm_payload_recipient', owner);
      if (lc(a.spender) !== lc(spender)) return bad('invalid_exact_evm_payload_spender', owner);
      if (BigInt(a.witness.validAfter) > now) return bad('invalid_exact_evm_payload_valid_after', owner);
      if (BigInt(a.deadline) < now + 5n) return bad('invalid_exact_evm_payload_deadline', owner);
      if (ethers.verifyTypedData(domain, TYPES, typedValue(a), sig) !== owner) return bad('invalid_exact_evm_payload_signature', owner);
      // our escrow-specific rules (the extension)
      if (lc(task.provider) !== lc(wallet.address) || !verifiers.includes(lc(task.verifier))) return bad('task_provider_or_verifier_not_accepted', owner);
      if (Number(task.deadline) < Number(now) + 600) return bad('task_deadline_too_soon', owner);
      if (BigInt(a.nonce) !== BigInt(taskCommitment(req.payTo, owner, req.asset, amount, task))) return bad('task_binding_mismatch', owner);
      // on-chain state
      if ((await token.allowance(owner, PERMIT2)) < amount) return bad('permit2_allowance_required', owner);
      if ((await token.balanceOf(owner)) < amount) return bad('insufficient_funds', owner);
      const nonce = BigInt(a.nonce);
      if (((await permit2.nonceBitmap(owner, nonce >> 8n)) >> (nonce & 255n)) & 1n) return bad('nonce_already_used', owner);
      await escrowRead.createTaskX402.staticCall(...args(p)); // simulate the settlement
      return { isValid: true, payer: owner };
    } catch (e) { return bad('verify_error: ' + (e.shortMessage || e.message)); }
  }

  // POST /settle semantics: broadcast. For an escrow-backed resource "settled" means "locked in escrow".
  async function settle(p, req = requirements) {
    const v = await verify(p, req);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, payer: v.payer, transaction: '', network: NETWORK };
    try {
      const rc = await queue(async () => (await escrowWrite.createTaskX402(...args(p))).wait());
      const ev = rc.logs.map((l) => { try { return escrowRead.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'Created');
      return { success: true, payer: v.payer, transaction: rc.hash, network: NETWORK, amount: req.amount, extensions: { [EXT]: { taskId: ev.args.id.toString() } } };
    } catch (e) {
      return { success: false, errorReason: 'settle_error: ' + (e.shortMessage || e.message), payer: v.payer, transaction: '', network: NETWORK };
    }
  }

  const supported = () => ({
    kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: NETWORK, extra: { assetTransferMethod: 'permit2' } }],
    extensions: [EXT], signers: { 'eip155:*': [wallet.address] },
  });
  return { requirements, requiredInfo, spender, verify, settle, supported };
}
