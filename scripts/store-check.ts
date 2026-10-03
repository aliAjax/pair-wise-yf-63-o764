// store 集成测试：并发互斥、写盘回滚重试、撤药再平衡、角色拒绝
import { createPinia, setActivePinia } from 'pinia';
import { useTrialStore } from '../stores/trial';
// @ts-ignore 测试垫片
import { __resetPersist, armWriteFailure } from './fake-persist.mjs';

let failures = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures += 1; console.error(`  ✗ ${msg}`); } };

const fresh = () => { __resetPersist(); setActivePinia(createPinia()); return useTrialStore(); };
const input = (n, extra = {}) => ({ participantNo: n, identityKey: `id-${n}`, site: '上海中心', ageBand: '45-64', actor: '协调员陈晨', ...extra });

console.log('S1) 并发：两个发号同时提交，恰好一个拿号、一个被锁拒，无重号');
{
  const s = fresh();
  const [a, b] = await Promise.all([
    s.randomize(input('T001'), { role: 'coordinator' }),
    s.randomize(input('T002'), { role: 'coordinator' })
  ]);
  assert(a.ok !== b.ok, `一胜一负（a.ok=${a.ok} b.ok=${b.ok}）`);
  assert(Boolean(a.locked) !== Boolean(b.locked), '恰好一人收到占用提示');
  const winnerSeq = a.ok ? a.sequence : b.sequence;
  assert(typeof winnerSeq === 'number', `胜出者拿到号 ${winnerSeq}`);
  const loser = a.ok ? b : a;
  assert(loser.locked && loser.sequence === undefined, '失败者未拿到任何号码');
  // 失败者随后重试即可成功，且拿到下一个不同的号
  const retry = await s.randomize(input('T002'), { role: 'coordinator' });
  assert(retry.ok && retry.sequence !== winnerSeq, `重试成功且号码不同（${retry.sequence} vs ${winnerSeq}）`);
  const seqs = s.participants.map((p) => p.sequence);
  assert(new Set(seqs).size === seqs.length, '台账无重复随机号');
}

console.log('S2) 写盘失败：事务回滚、号码不占用、重试成功并补恢复审计');
{
  const s = fresh();
  armWriteFailure();
  const failed = await s.randomize(input('W001'), { role: 'coordinator' });
  assert(!failed.ok && failed.writeFailed, `首次写盘失败被捕获（${failed.message.slice(0, 20)}…）`);
  assert(!s.participants.some((p) => p.participantNo === 'W001'), '失败提交未进入台账');
  const seqAfterFail = s.nextSequence;
  const retry = await s.randomize(input('W001'), { role: 'coordinator' });
  assert(retry.ok, '重试成功');
  assert(s.nextSequence === seqAfterFail, `游标未因失败前移（${s.nextSequence}）`);
  assert(s.participants.filter((p) => p.participantNo === 'W001').length === 1, '该受试者只有一条记录');
  assert(s.audits.some((e) => e.action === 'write-recovered'), '追加了 write-recovered 恢复审计');
}

console.log('S3) 未给药撤药：原号保留不分配，补发优先，A/B 重新平衡');
{
  const s = fresh();
  // seed: 1001 A(已发药已首剂), 1002 B
  const r1 = await s.randomize(input('V001'), { role: 'coordinator' }); // 1003 A
  assert(r1.sequence === 1003 && r1.arm === 'A', `新入组拿 1003/A（${r1.sequence}/${r1.arm}）`);
  const target = s.participants.find((p) => p.participantNo === 'V001');
  const w = await s.withdraw(target.id, '筛选失败误纳排', '协调员陈晨', 'coordinator');
  assert(w.ok && w.retainedSequence === 1003 && w.replacementSequence === 1005, `作废保留 1003、补发 1005（${w.message.slice(0, 18)}…）`);
  const voidedSlot = s.ledger['上海中心§45-64'].blocks.flat().find((slot) => slot.sequence === 1003);
  assert(voidedSlot.status === 'voided' && voidedSlot.participantNo === 'V001', '1003 槽位标记作废且保留受试者痕迹');
  // 下一发放优先拿补发号 1005 A，而不是库存 1004 B
  const r2 = await s.randomize(input('V002'), { role: 'coordinator' });
  assert(r2.sequence === 1005 && r2.arm === 'A', `下一发放优先补发号 1005/A（${r2.sequence}/${r2.arm}）`);
  const assigned = s.participants.filter((p) => p.status !== 'withdrawn');
  const a = assigned.filter((p) => p.arm === 'A').length;
  const bb = assigned.filter((p) => p.arm === 'B').length;
  assert(Math.abs(a - bb) === 1, `补发优先取 A 后区组中途失衡仅 1（A=${a} B=${bb}）`);
  const restore = await s.randomize(input('V003'), { role: 'coordinator' }); // 库存 1004 B
  assert(restore.sequence === 1004 && restore.arm === 'B', `随后按库存发 1004/B（${restore.sequence}/${restore.arm}）`);
  const afterBlock = s.participants.filter((p) => p.status !== 'withdrawn');
  assert(afterBlock.filter((p) => p.arm === 'A').length === afterBlock.filter((p) => p.arm === 'B').length, '区组发满时 A/B 严格相等');
  // 1003 永远不再出现
  for (let i = 0; i < 5; i++) await s.randomize(input(`X${i}`, { identityKey: `id-X${i}` }), { role: 'coordinator' });
  assert(!s.participants.some((p) => p.sequence === 1003 && p.participantNo !== 'V001'), '1003 未被任何后来者复用');
}

console.log('S4) 已首剂后撤药：编号保留、区组不补发');
{
  const s = fresh();
  const r = await s.randomize(input('D001'), { role: 'coordinator' }); // 1003 A
  await s.recordFirstDose(s.participants.find((p) => p.participantNo === 'D001').id, '协调员', 'coordinator');
  const cursorBefore = s.nextSequence;
  const w = await s.withdraw(s.participants.find((p) => p.participantNo === 'D001').id, 'AE 停药', '协调员', 'coordinator');
  assert(w.ok && w.replacementSequence === undefined, '已给药撤药不补发');
  assert(s.nextSequence === cursorBefore, '游标不前移');
  const still = s.participants.find((p) => p.participantNo === 'D001');
  assert(still.sequence === 1003 && still.withdrawalKind === 'discontinue-after-dose', '记录与编号保留为终止用药');
  const next = await s.randomize(input('D002'), { role: 'coordinator' });
  assert(next.sequence === 1004, `后续发号按库存继续（${next.sequence}）`);
}

console.log('S5) 角色：越权操作被拒绝并写 access-denied 审计');
{
  const s = fresh();
  const denied1 = await s.randomize(input('P001'), { role: 'pharmacist' });
  assert(!denied1.ok && denied1.denied, '药品管理员发号被拒');
  const denied2 = await s.emergencyUnblind(s.participants[0].id, '想看', '监察员周巡', 'monitor');
  assert(!denied2.ok && denied2.denied, '监察员揭盲被拒');
  const denied3 = await s.requestViewArm(s.participants[0].id, '药管林药师', 'pharmacist');
  assert(!denied3.ok && denied3.denied, '药管查治疗组被拒');
  assert(s.audits.filter((e) => e.action === 'access-denied').length === 3, '三次拒绝均入审计');
}

console.log('S6) 揭盲：仅研究者可做，事后审计只追加；重复揭盲被拒');
{
  const s = fresh();
  const target = s.participants.find((p) => p.participantNo === 'S01-002');
  const w = await s.emergencyUnblind(target.id, 'SAE 急诊需要', '研究者张宁', 'investigator');
  assert(w.ok, '研究者揭盲成功');
  const again = await s.emergencyUnblind(target.id, '再试', '研究者张宁', 'investigator');
  assert(!again.ok, '重复揭盲被拒（只可追加）');
  const view = await s.requestViewArm(target.id, '研究者张宁', 'investigator');
  assert(view.ok && view.arm === 'B', '揭盲后研究者可查看治疗组 B');
  const viewMonitor = await s.requestViewArm(target.id, '监察员周巡', 'monitor');
  assert(!viewMonitor.ok, '即使已揭盲，监察员仍看不到组');
  // 审计冻结：运行期改写被阻止
  const entry = s.audits.find((e) => e.action === 'unblinded');
  let threw = false;
  try { entry.detail = '篡改'; } catch { threw = true; }
  assert(threw && entry.detail.includes('紧急揭盲'), '审计记录 Object.freeze，改写抛错');
}

console.log(failures === 0 ? '\n集成测试全部通过 ✅' : `\n${failures} 项失败 ❌`);
if (failures) process.exit(1);
