import type { AuditAction, AuditEntry, Arm, TrialRole } from '~/types/trial';

/** 参与哈希链的字段：任何一项被改写，链校验都会失败 */
function canonical(entry: Omit<AuditEntry, 'hash'>): string {
  return JSON.stringify([entry.id, entry.at, entry.actor, entry.action, entry.detail, entry.arm ?? null, entry.reason ?? null, entry.participantNo ?? null, entry.prevHash]);
}

export async function hashEntry(entry: Omit<AuditEntry, 'hash'>): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(entry));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const GENESIS_HASH = 'GENESIS';

export interface AuditInput {
  actor: string;
  action: AuditAction;
  detail: string;
  arm?: Arm;
  reason?: string;
  participantNo?: string;
}

export async function sealAudit(prevHash: string, input: AuditInput): Promise<AuditEntry> {
  const entry: Omit<AuditEntry, 'hash'> = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...input,
    prevHash
  };
  return { ...entry, hash: await hashEntry(entry) };
}

/** 从最早一条向最新校验哈希链；返回第一个断裂点（全部合法返回 null） */
export async function verifyChain(entries: AuditEntry[]): Promise<{ brokenId: string } | null> {
  let prevHash = GENESIS_HASH;
  const ordered = [...entries].reverse();
  for (const entry of ordered) {
    if (entry.prevHash !== prevHash) return { brokenId: entry.id };
    const { hash, ...rest } = entry;
    if ((await hashEntry(rest)) !== hash) return { brokenId: entry.id };
    prevHash = entry.hash;
  }
  return null;
}

/**
 * 角色可见性矩阵：
 * - investigator 研究者：仅揭盲后的受试者可见治疗组；审计中可见治疗组与原因
 * - coordinator 协调员：发号/撤药操作人，可见原因，不可见治疗组
 * - pharmacist 药品管理员：只见发药标识，治疗组与原因均不可见
 * - monitor 监察员：可查撤药/揭盲原因，任何情况下看不到治疗组
 */
const POLICY: Record<TrialRole, { armAfterUnblind: boolean; auditArm: boolean; reason: boolean }> = {
  investigator: { armAfterUnblind: true, auditArm: true, reason: true },
  coordinator: { armAfterUnblind: false, auditArm: false, reason: true },
  pharmacist: { armAfterUnblind: false, auditArm: false, reason: false },
  monitor: { armAfterUnblind: false, auditArm: false, reason: true }
};

export const canViewReason = (role: TrialRole) => POLICY[role].reason;

/** 治疗组仅在受试者已揭盲时对研究者开放，其他角色一律拒绝 */
export const canViewParticipantArm = (role: TrialRole, status: string) =>
  POLICY[role].armAfterUnblind && status === 'unblinded';

/** 按角色脱敏审计流：无权限字段直接抹掉（哈希链仍可独立校验） */
export function redactAudit(entries: AuditEntry[], role: TrialRole): AuditEntry[] {
  const policy = POLICY[role];
  return entries.map((entry) => {
    const copy: AuditEntry = { ...entry };
    if (!policy.auditArm) delete copy.arm;
    if (!policy.reason) delete copy.reason;
    return copy;
  });
}
