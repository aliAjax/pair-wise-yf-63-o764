export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type ParticipantStatus = 'randomized' | 'unblinded' | 'withdrawn';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'withdrawn'
  | 'first-dose'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'unauthorized-blocked';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: ParticipantStatus;
  sequence: number;
  arm: Arm;
  actor?: string;
  firstDoseAt?: string;
  unblindedAt?: string;
  unblindReason?: string;
  withdrawnAt?: string;
  withdrawReason?: string;
}

/** 区组：每个分层（中心+年龄层）一个区组，4 个槽位，2A/2B 随机排列。作废记录永久占槽，号码不再分配。 */
export interface Block {
  id: string;
  stratum: string;
  arms: Arm[];
  slots: (string | null)[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
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

export interface ActionResult {
  ok: boolean;
  message: string;
  arm?: Arm;
  reason?: string;
  /** 写盘失败时为 true：号码未被占用，可原样重试 */
  retryable?: boolean;
}
