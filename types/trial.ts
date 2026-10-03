export type TrialRole = 'coordinator' | 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction =
  | 'randomized'
  | 'withdrawn'
  | 'first-dose'
  | 'dispensed'
  | 'unblinded'
  | 'access-denied'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'write-recovered';

export type ParticipantStatus = 'randomized' | 'withdrawn' | 'unblinded';

/** 区组内一个槽位：作废槽位永久保留编号，区组会补发新槽位直至有效槽位重新平衡 */
export interface BlockSlot {
  sequence: number;
  arm: Arm;
  status: 'active' | 'voided';
  participantNo?: string;
  /** 撤药未给药后补发的槽位：携带被作废槽位的治疗组，发号时全分层优先消化 */
  replacement?: boolean;
  voidedAt?: string;
  voidReason?: string;
}

/** 每个分层（研究中心 × 年龄分层）维护自己的区组链 */
export interface StratumLedger {
  blocks: BlockSlot[][];
}

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: ParticipantStatus;
  /** 中央随机号：一旦生成永久保留，撤药未给药也不会再分配给任何人 */
  sequence: number;
  arm: Arm;
  /** 首剂给药标记：决定撤药是“作废重平衡”还是“终止保留” */
  firstDoseAt?: string;
  /** 发药标识（药品管理员唯一可见的工作信息） */
  dispenseKit?: string;
  dispensedAt?: string;
  withdrawnAt?: string;
  withdrawReason?: string;
  withdrawalKind?: 'void-before-dose' | 'discontinue-after-dose';
  unblindedAt?: string;
}

/** 追加式审计：prevHash 形成哈希链，任何改写都会在校验时暴露 */
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  /** 不含治疗组的叙述，所有角色可见 */
  detail: string;
  /** 治疗组等敏感字段，按角色读取；写入后永不修改 */
  arm?: Arm;
  /** 撤药/揭盲原因，监察员可查，药品管理员不可查 */
  reason?: string;
  participantNo?: string;
  hash: string;
  prevHash: string;
}

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed';
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}

export interface TrialState {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  ledger: Record<string, StratumLedger>;
  /** 单调游标：号只会向后走，保证不重用 */
  nextSequence: number;
}

export interface RandomizeOutcome {
  ok: boolean;
  message: string;
  sequence?: number;
  arm?: Arm;
}
