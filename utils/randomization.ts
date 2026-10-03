import type { Arm, BlockSlot, Participant, StratumLedger, TrialState } from '~/types/trial';

export const BLOCK_SIZE = 4;
/** 区组固定 1:1，两种交错模板按区组序号轮换，运行中两组计数差不超过 1 */
const BLOCK_PATTERNS: Arm[][] = [
  ['A', 'B', 'A', 'B'],
  ['B', 'A', 'B', 'A']
];

export const stratumKey = (site: string, ageBand: Participant['ageBand']) => `${site}§${ageBand}`;

export function buildBlock(blockIndex: number, startSequence: number): BlockSlot[] {
  return BLOCK_PATTERNS[blockIndex % BLOCK_PATTERNS.length].map((arm, i) => ({
    sequence: startSequence + i,
    arm,
    status: 'active'
  }));
}

export function ensureStratum(ledger: Record<string, StratumLedger>, key: string): StratumLedger {
  if (!ledger[key]) ledger[key] = { blocks: [] };
  return ledger[key];
}

const isOpenSlot = (slot: BlockSlot) => slot.status === 'active' && !slot.participantNo;

/**
 * 取下一个可发槽位：
 * 1) 全分层优先消化“撤药补发槽”（携带被作废槽位的治疗组），保证作废后立即重新平衡；
 * 2) 否则按区组顺序消耗计划槽位；
 * 3) 当前区组发满才开启新区组。
 */
export function allocateSlot(state: Pick<TrialState, 'ledger' | 'nextSequence'>, site: string, ageBand: Participant['ageBand'], participantNo: string): BlockSlot {
  const key = stratumKey(site, ageBand);
  const stratum = ensureStratum(state.ledger, key);
  if (stratum.blocks.length === 0) {
    stratum.blocks.push(buildBlock(0, state.nextSequence));
    state.nextSequence += BLOCK_SIZE;
  }

  // 1) 补发槽优先：跨区组也能找到（作废可能发生在已填满的旧区组）
  for (const block of stratum.blocks) {
    const replacement = block.find((item) => isOpenSlot(item) && item.replacement);
    if (replacement) {
      replacement.participantNo = participantNo;
      return replacement;
    }
  }

  // 2) 按区组先后找未占用的计划槽位
  for (const block of stratum.blocks) {
    const slot = block.find(isOpenSlot);
    if (slot) {
      slot.participantNo = participantNo;
      return slot;
    }
  }

  // 3) 全部发满：开启新区组
  const block = buildBlock(stratum.blocks.length, state.nextSequence);
  state.nextSequence += BLOCK_SIZE;
  stratum.blocks.push(block);
  block[0].participantNo = participantNo;
  return block[0];
}

/**
 * 未首剂给药撤药：原槽位作废（编号永久保留、不再分配），
 * 在同一分层补发一个同治疗组的新槽位（标记 replacement），下次发号优先消化，
 * 使该分层已发放的有效槽位 A/B 始终保持均衡。
 * 中央随机号全局唯一单调，补发号从全局游标领取，不影响其他分层。
 */
export function voidSlotAndRebalance(ledger: Record<string, StratumLedger>, sequence: number, reason: string, at: string, replacementSequence: number): { arm: Arm; replacementSequence: number; stratum: string } | undefined {
  for (const [key, stratum] of Object.entries(ledger)) {
    for (const block of stratum.blocks) {
      const slot = block.find((item) => item.sequence === sequence);
      if (!slot) continue;
      slot.status = 'voided';
      slot.voidedAt = at;
      slot.voidReason = reason;
      block.push({ sequence: replacementSequence, arm: slot.arm, status: 'active', replacement: true });
      return { arm: slot.arm, replacementSequence, stratum: key };
    }
  }
}

/**
 * 台账平衡：a/b 只统计“已发放且在组”的有效槽位（待发库存不计入实际平衡）；
 * voided 为作废保留号数量；stock 为尚未发放的计划/补发库存槽。
 */
export function ledgerBalance(ledger: Record<string, StratumLedger>): { assigned: number; a: number; b: number; voided: number; stock: number } {
  let assigned = 0;
  let a = 0;
  let b = 0;
  let voided = 0;
  let stock = 0;
  for (const stratum of Object.values(ledger)) {
    for (const block of stratum.blocks) {
      for (const slot of block) {
        if (slot.status === 'voided') { voided += 1; continue; }
        if (!slot.participantNo) { stock += 1; continue; }
        assigned += 1;
        if (slot.arm === 'A') a += 1; else b += 1;
      }
    }
  }
  return { assigned, a, b, voided, stock };
}
