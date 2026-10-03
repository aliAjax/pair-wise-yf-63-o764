import { BLOCK_SIZE, allocateSlot, buildBlock, ledgerBalance, stratumKey, voidSlotAndRebalance } from '../utils/randomization';
import { GENESIS_HASH, redactAudit, sealAudit, verifyChain, canViewParticipantArm, canViewReason } from '../utils/audit';
import { hasPermission, PERMISSION_LABEL } from '../utils/permissions';
import type { TrialState } from '../types/trial';

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures += 1; console.error(`  ✗ ${msg}`); }
};

const newState = (): TrialState => ({ participants: [], audits: [], pending: [], ledger: {}, nextSequence: 1001 });

console.log('1) 区组发号：每 4 槽一组、A/B 各半、顺序递增');
{
  const s = newState();
  const seqs: number[] = [];
  for (let i = 0; i < 6; i++) seqs.push(allocateSlot(s, '上海', '45-64', `P${i}`).sequence);
  assert(seqs.join(',') === '1001,1002,1003,1004,1005,1006', `发号顺序 ${seqs.join(',')}`);
  const b = ledgerBalance(s.ledger);
  assert(b.assigned === 6 && b.a === 3 && b.b === 3, `6 发后在组 ${b.assigned}：A=${b.a} B=${b.b}`);
  assert(b.stock === 2 && b.voided === 0, `两区组尚有 2 个待发库存（stock=${b.stock}）`);
  assert(s.nextSequence === 1009, `两个区组预占后游标=${s.nextSequence}`);
}

console.log('2) 未首剂撤药：原号作废保留，补发同组槽位，平衡恢复');
{
  const s = newState();
  const s1 = allocateSlot(s, '上海', '45-64', 'P1'); // 1001 A
  const s2 = allocateSlot(s, '上海', '45-64', 'P2'); // 1002 B
  const s3 = allocateSlot(s, '上海', '45-64', 'P3'); // 1003 A
  assert(s1.arm === 'A' && s3.arm === 'A', '1001 与 1003 均为 A（模板 ABA B）');
  // 作废 P3 的 1003（A）
  const next = s.nextSequence; // 1005
  const r = voidSlotAndRebalance(s.ledger, 1003, '误纳排', new Date().toISOString(), next);
  s.nextSequence += 1;
  assert(r?.arm === 'A' && r?.replacementSequence === 1005, `补发同组 A 的新号 1005（得到 ${r?.replacementSequence}/${r?.arm}）`);
  const slot4 = allocateSlot(s, '上海', '45-64', 'P4'); // 补发槽优先
  assert(slot4.sequence === 1005 && slot4.arm === 'A' && slot4.replacement === true, `下一位优先拿到补发号 1005/A 而非复用 1003（得到 ${slot4.sequence}/${slot4.arm}）`);
  const b = ledgerBalance(s.ledger);
  // 在组有效槽：1001(A) 1002(B) 1005(A)；待发库存：1004(B)
  assert(b.voided === 1 && b.assigned === 3 && b.a === 2 && b.b === 1, `作废 1、在组 ${b.assigned}：A=${b.a} B=${b.b}`);
  // 1003 永久不再分配：再发 3 个，依次走库存 1004、新区组 1006、1007
  const more = [allocateSlot(s, '上海', '45-64', 'P5').sequence, allocateSlot(s, '上海', '45-64', 'P6').sequence, allocateSlot(s, '上海', '45-64', 'P7').sequence];
  assert(more.join(',') === '1004,1006,1007', `1003 永不复用：${more.join(',')}`);
  assert(!more.includes(1003), '1003 未被任何人再次拿到');
  const after = ledgerBalance(s.ledger);
  assert(after.a === after.b, `补发消化后区组 A/B 重新相等（A=${after.a} B=${after.b}）`);
}

console.log('3) 分层隔离：A/B 排列按分层独立，中央随机号全局唯一单调');
{
  const s = newState();
  const a = allocateSlot(s, '上海', '45-64', 'P1').sequence;
  const b = allocateSlot(s, '广州', '45-64', 'P2').sequence;
  const c = allocateSlot(s, '上海', '18-44', 'P3').sequence;
  assert(a === 1001 && b === 1005 && c === 1009, `中央号全局不重复：${a},${b},${c}`);
  assert(Object.keys(s.ledger).length === 3, `台账有 3 个分层键（${Object.keys(s.ledger).length}）`);
  const armA = s.ledger[stratumKey('上海', '45-64')].blocks[0][0].arm;
  const armB = s.ledger[stratumKey('广州', '45-64')].blocks[0][0].arm;
  assert(armA === 'A' && armB === 'A', '各分层都从各自区组模板首位 A 开始排列');
}

console.log('3b) 跨区组作废：旧区组已填满，补发槽仍被下一发放优先消化');
{
  const s = newState();
  for (let i = 0; i < 5; i++) allocateSlot(s, '上海', '45-64', `P${i}`); // 1001..1005
  // 此时区组0已发满，区组1开了 1005(A)，库存 1006(B) 1007(A) 1008(B)
  const replacementSequence = s.nextSequence; // 1009
  s.nextSequence += 1;
  voidSlotAndRebalance(s.ledger, 1001, '知情同意撤回', new Date().toISOString(), replacementSequence);
  const next = allocateSlot(s, '上海', '45-64', 'P6');
  assert(next.sequence === 1009 && next.arm === 'A' && next.replacement === true, `跨区组补发优先（${next.sequence}/${next.arm}）`);
  const b = ledgerBalance(s.ledger);
  assert(b.voided === 1 && Math.abs(b.a - b.b) <= 1, `跨区组作废后失衡被补发立刻纠正（差≤1）：A=${b.a} B=${b.b}`);
  // 继续发满当前区组：下一发放走库存 1006(B)，A/B 即重新相等
  const follow = allocateSlot(s, '上海', '45-64', 'P7');
  const b2 = ledgerBalance(s.ledger);
  assert(follow.sequence === 1006 && b2.a === b2.b, `库存按序发放 ${follow.sequence}，区组完成时 A=${b2.a} B=${b2.b}`);
}

console.log('4) 哈希链：追加链接、可校验、改写即断裂');
{
  const entries = [];
  let prev = GENESIS_HASH;
  prev = (await sealAudit(prev, { actor: '张宁', action: 'randomized', detail: 'd1' })); entries.unshift(prev);
  prev = (await sealAudit(entries[0].hash, { actor: '张宁', action: 'unblinded', detail: 'd2', arm: 'A', reason: 'SAE' })); entries.unshift(prev);
  assert(await verifyChain(entries) === null, '两条记录哈希链校验通过');
  const tampered = JSON.parse(JSON.stringify(entries));
  tampered[0].detail = '被改写';
  const broken = await verifyChain(tampered);
  assert(broken?.brokenId === tampered[0].id, '改写 detail 后链在该记录处断裂');
  const tamperedArm = JSON.parse(JSON.stringify(entries));
  tamperedArm[0].arm = 'B';
  assert((await verifyChain(tamperedArm))?.brokenId === tamperedArm[0].id, '篡改治疗组同样被发现');
}

console.log('5) 角色矩阵：药品管理员只见发药；监察员见原因不见组');
{
  assert(!hasPermission('pharmacist', 'view-arm'), '药管不能看治疗组');
  assert(hasPermission('pharmacist', 'dispense'), '药管可发药');
  assert(!hasPermission('monitor', 'view-arm'), '监察员不能看治疗组');
  assert(canViewReason('monitor'), '监察员可查原因');
  assert(!canViewReason('pharmacist'), '药管不可查原因');
  assert(hasPermission('coordinator', 'withdraw') && hasPermission('coordinator', 'randomize'), '协调员可发号/撤药');
  assert(hasPermission('investigator', 'unblind') && !hasPermission('monitor', 'unblind'), '仅研究者可揭盲');
  assert(!canViewParticipantArm('investigator', 'randomized'), '研究者也只能在揭盲后看组');
  assert(canViewParticipantArm('investigator', 'unblinded'), '研究者对已揭盲者可见组');
  const e = [await sealAudit(GENESIS_HASH, { actor: 'x', action: 'unblinded', detail: 'd', arm: 'A', reason: 'r' })];
  const mon = redactAudit(e, 'monitor');
  assert(mon[0].arm === undefined && mon[0].reason === 'r', '监察员审计：组被抹掉、原因保留');
  const ph = redactAudit(e, 'pharmacist');
  assert(ph[0].arm === undefined && ph[0].reason === undefined, '药管审计：组与原因都被抹掉');
  assert(redactAudit(e, 'investigator')[0].arm === 'A', '研究者审计可见组');
  // 脱敏副本不影响原始哈希校验
  assert((await verifyChain(e)) === null, '脱敏只是视图层处理，原链仍可校验');
}

console.log('6) 区组模板：交替模板保证任一点 A/B 差不超过 1');
{
  const s = newState();
  let ok = true;
  for (let i = 0; i < 9; i++) {
    allocateSlot(s, '上海', '45-64', `P${i}`);
    const b = ledgerBalance(s.ledger);
    if (Math.abs(b.a - b.b) > 1) ok = false;
  }
  assert(ok, '任意发号时刻 A/B 计数差 ≤ 1');
  assert(BLOCK_SIZE === buildBlock(0, 1).length, '区组大小为 4');
  void PERMISSION_LABEL;
  void stratumKey;
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
if (failures) process.exit(1);
