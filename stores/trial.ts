import { defineStore } from 'pinia';
import type {
  Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput, RandomizeOutcome,
  TrialRole, TrialState
} from '~/types/trial';
import { armWriteFailure, readLocal, writeLocal } from '~/composables/useLocalPersist';
import { BLOCK_SIZE, allocateSlot, buildBlock, ledgerBalance, stratumKey, voidSlotAndRebalance } from '~/utils/randomization';
import { GENESIS_HASH, sealAudit } from '~/utils/audit';
import { PERMISSION_LABEL, hasPermission, type Permission } from '~/utils/permissions';

const STORAGE_KEY = 'trial-iwrs-v2';

function createSeed(): TrialState {
  const ledger: TrialState['ledger'] = {};
  // 上海中心 × 45-64 已有首块：1001/1002 已发，1003/1004 待发
  const first = buildBlock(0, 1001);
  first[0].participantNo = 'S01-001';
  first[1].participantNo = 'S01-002';
  ledger[stratumKey('上海中心', '45-64')] = { blocks: [first] };
  return {
    participants: [
      { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A', dispenseKit: 'KIT-1001', dispensedAt: new Date(Date.now() - 7200_000).toISOString(), firstDoseAt: new Date(Date.now() - 3600_000).toISOString() },
      { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
    ],
    audits: [],
    pending: [],
    ledger,
    nextSequence: 1001 + BLOCK_SIZE
  };
}

/** 模块级互斥锁：两个浏览器标签/两位协调员同时提交，只有一个能进入发号临界区 */
let lockHeld = false;
function acquireLock(): (() => void) | null {
  if (lockHeld) return null;
  lockHeld = true;
  return () => { lockHeld = false; };
}

/** 审计追加串行化，保证 prevHash 链在并发追加时仍然严格有序 */
let auditTail: Promise<unknown> = Promise.resolve();

/** 记录写盘失败过的提交，重试成功后补“恢复”审计 */
const failedAttempts = new Set<string>();
const attemptKey = (input: RandomizeInput) => `${input.participantNo}#${input.identityKey}`;

export interface ActionOutcome {
  ok: boolean;
  message: string;
  denied?: boolean;
  locked?: boolean;
  writeFailed?: boolean;
}

export const useTrialStore = defineStore('trial', {
  state: (): TrialState => readLocal(STORAGE_KEY, createSeed()),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, p) => {
      result[p.site] = (result[p.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    balance: (state) => ledgerBalance(state.ledger),
    lastAuditHash: (state): string => state.audits[0]?.hash ?? GENESIS_HASH
  },
  actions: {
    /* -------------------------------------------------- 持久化事务 */
    persist() {
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        ledger: this.ledger,
        nextSequence: this.nextSequence
      });
    },
    snapshot(): TrialState {
      return JSON.parse(JSON.stringify({
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        ledger: this.ledger,
        nextSequence: this.nextSequence
      })) as TrialState;
    },
    restore(snapshot: TrialState) {
      this.participants = snapshot.participants;
      this.audits = snapshot.audits;
      this.pending = snapshot.pending;
      this.ledger = snapshot.ledger;
      this.nextSequence = snapshot.nextSequence;
    },

    /* -------------------------------------------------- 追加式审计 */
    appendAudit(input: Omit<AuditEntry, 'id' | 'at' | 'hash' | 'prevHash'>, flush = true): Promise<AuditEntry> {
      const job = auditTail.then(async () => {
        const prevHash = this.audits[0]?.hash ?? GENESIS_HASH;
        const entry = await sealAudit(prevHash, input);
        Object.freeze(entry); // 追加后不可改写：运行期任何修改都会抛错
        this.audits.unshift(entry);
        if (flush) this.persist();
        return entry;
      });
      auditTail = job.catch(() => {});
      return job;
    },
    async deny(role: TrialRole, permission: Permission, actor: string, participantNo?: string): Promise<ActionOutcome> {
      await this.appendAudit({
        actor: actor || role,
        action: 'access-denied',
        detail: `越权访问被拒绝：${PERMISSION_LABEL[permission]}（当前角色：${role}）`,
        participantNo
      });
      return { ok: false, denied: true, message: `权限不足：${PERMISSION_LABEL[permission]}仅允许授权角色，本次拒绝已记录审计` };
    },

    /* -------------------------------------------------- 区组发号 */
    async randomize(input: RandomizeInput, options: { role: TrialRole; offline?: boolean; failWrite?: boolean }): Promise<RandomizeOutcome & ActionOutcome> {
      if (!hasPermission(options.role, 'randomize')) return this.deny(options.role, 'randomize', input.actor, input.participantNo);

      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        await this.appendAudit({ actor: input.actor, action: 'duplicate-blocked', detail: `拒绝重复入组：${input.participantNo}`, participantNo: input.participantNo });
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }

      if (options.offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        await this.appendAudit({ actor: input.actor, action: 'pending-queued', detail: `离线提交进入待处理队列：${input.participantNo}`, participantNo: input.participantNo });
        return { ok: true, message: '已加入待提交队列，联网后由授权协调员确认入库' };
      }

      // 非阻塞互斥：拿不到锁说明另一位协调员正在发号，直接拒绝，不排队占号
      const release = acquireLock();
      if (!release) {
        return { ok: false, locked: true, message: '另一位协调员正在占用发号位，请稍后重试（本次未分配任何号码）' };
      }

      const snapshot = this.snapshot();
      try {
        const slot = allocateSlot(this, input.site, input.ageBand, input.participantNo);
        const participant: Participant = {
          id: crypto.randomUUID(),
          ...input,
          status: 'randomized',
          sequence: slot.sequence,
          arm: slot.arm
        };
        this.participants.unshift(participant);
        await this.appendAudit({
          actor: input.actor,
          action: 'randomized',
          detail: `${input.participantNo} 完成分层区组随机，中央随机号 ${slot.sequence}`,
          arm: slot.arm,
          participantNo: input.participantNo
        }, false);

        if (failedAttempts.has(attemptKey(input))) {
          failedAttempts.delete(attemptKey(input));
          await this.appendAudit({
            actor: input.actor,
            action: 'write-recovered',
            detail: `${input.participantNo} 上次写盘失败后重试成功，随机号 ${slot.sequence} 为首次分配，未发生号码占用`,
            participantNo: input.participantNo
          }, false);
        }

        if (options.failWrite) armWriteFailure();
        this.persist(); // 唯一写盘点：失败则整体回滚，号码不占用
        release();
        return { ok: true, message: `随机成功，中央随机号 ${slot.sequence}`, sequence: slot.sequence, arm: slot.arm as Arm };
      } catch (error) {
        this.restore(snapshot);
        failedAttempts.add(attemptKey(input));
        release();
        return {
          ok: false,
          writeFailed: true,
          message: `写盘失败，已回滚：本次未占用随机号，请直接重试。（${(error as Error).message}）`
        };
      }
    },

    /* -------------------------------------------------- 离线入库 */
    async commitPending(id: string, actor: string, role: TrialRole): Promise<ActionOutcome> {
      if (!hasPermission(role, 'commit-pending')) return this.deny(role, 'commit-pending', actor);
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return { ok: false, message: '待提交记录不存在或已入库' };

      const release = acquireLock();
      if (!release) return { ok: false, locked: true, message: '发号位正被占用，请稍后重试' };

      const snapshot = this.snapshot();
      try {
        pending.status = 'committed';
        const slot = allocateSlot(this, pending.payload.site, pending.payload.ageBand, pending.payload.participantNo);
        this.participants.unshift({
          id: crypto.randomUUID(),
          ...pending.payload,
          status: 'randomized',
          sequence: slot.sequence,
          arm: slot.arm
        });
        await this.appendAudit({
          actor,
          action: 'pending-committed',
          detail: `待提交记录确认入库：${pending.payload.participantNo}，中央随机号 ${slot.sequence}`,
          arm: slot.arm,
          participantNo: pending.payload.participantNo
        }, false);
        this.persist();
        release();
        return { ok: true, message: `已入库，随机号 ${slot.sequence}` };
      } catch (error) {
        this.restore(snapshot);
        release();
        return { ok: false, writeFailed: true, message: `写盘失败已回滚，号码未占用，请重试。（${(error as Error).message}）` };
      }
    },

    /* -------------------------------------------------- 撤药作废 */
    async withdraw(id: string, reason: string, actor: string, role: TrialRole): Promise<ActionOutcome & { retainedSequence?: number; replacementSequence?: number }> {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '受试者不存在' };
      if (!hasPermission(role, 'withdraw')) return this.deny(role, 'withdraw', actor, participant.participantNo);
      if (participant.status === 'withdrawn') return { ok: false, message: '该受试者已撤药，不能重复操作' };
      if (!reason.trim()) return { ok: false, message: '撤药必须填写原因' };

      const snapshot = this.snapshot();
      try {
        const at = new Date().toISOString();
        if (!participant.firstDoseAt) {
          // 未首剂给药：原号永久保留但不再分配，区组补发同组槽位重新平衡
          const replacementSequence = this.nextSequence;
          this.nextSequence += 1;
          const result = voidSlotAndRebalance(this.ledger, participant.sequence, reason.trim(), at, replacementSequence);
          if (!result) throw new Error('台账中找不到对应区组槽位');
          participant.status = 'withdrawn';
          participant.withdrawnAt = at;
          participant.withdrawReason = reason.trim();
          participant.withdrawalKind = 'void-before-dose';
          await this.appendAudit({
            actor,
            action: 'withdrawn',
            detail: `撤药（未首剂给药）：随机号 ${participant.sequence} 永久保留且不再分配，区组补发随机号 ${result.replacementSequence} 重新平衡`,
            arm: result.arm,
            reason: reason.trim(),
            participantNo: participant.participantNo
          });
          return { ok: true, message: `已作废：原随机号 ${participant.sequence} 永久保留，区组已用补发号 ${result.replacementSequence} 重新平衡`, retainedSequence: participant.sequence, replacementSequence: result.replacementSequence };
        }

        // 已首剂给药：治疗事实已发生，编号随记录保留，区组不补发
        participant.status = 'withdrawn';
        participant.withdrawnAt = at;
        participant.withdrawReason = reason.trim();
        participant.withdrawalKind = 'discontinue-after-dose';
        await this.appendAudit({
          actor,
          action: 'withdrawn',
          detail: `撤药（已首剂给药）：随机号 ${participant.sequence} 与治疗记录保留，区组不补发`,
          arm: participant.arm,
          reason: reason.trim(),
          participantNo: participant.participantNo
        });
        return { ok: true, message: `已终止用药：随机号 ${participant.sequence} 随治疗记录保留，区组不再补发` };
      } catch (error) {
        this.restore(snapshot);
        return { ok: false, writeFailed: true, message: `操作失败已回滚：${(error as Error).message}` };
      }
    },

    /* -------------------------------------------------- 首剂与发药 */
    async recordFirstDose(id: string, actor: string, role: TrialRole): Promise<ActionOutcome> {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '受试者不存在' };
      if (!hasPermission(role, 'first-dose')) return this.deny(role, 'first-dose', actor, participant.participantNo);
      if (participant.firstDoseAt) return { ok: false, message: '首剂已登记' };
      if (participant.status !== 'randomized') return { ok: false, message: '当前状态不能登记首剂' };
      participant.firstDoseAt = new Date().toISOString();
      await this.appendAudit({ actor, action: 'first-dose', detail: `${participant.participantNo} 登记首剂给药，此后撤药将保留随机号`, participantNo: participant.participantNo });
      return { ok: true, message: '首剂给药已登记' };
    },

    async dispense(id: string, actor: string, role: TrialRole): Promise<ActionOutcome & { kit?: string }> {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '受试者不存在' };
      if (!hasPermission(role, 'dispense')) return this.deny(role, 'dispense', actor, participant.participantNo);
      if (participant.status === 'withdrawn') return { ok: false, message: '受试者已撤药，不能发药' };
      if (participant.dispenseKit) return { ok: false, message: '该随机号已发药' };
      const kit = `KIT-${participant.sequence}`;
      participant.dispenseKit = kit;
      participant.dispensedAt = new Date().toISOString();
      await this.appendAudit({ actor, action: 'dispensed', detail: `${participant.participantNo} 按发药标识 ${kit} 发药`, participantNo: participant.participantNo });
      return { ok: true, message: `已按发药标识 ${kit} 发药`, kit };
    },

    /* -------------------------------------------------- 紧急揭盲 */
    async emergencyUnblind(id: string, reason: string, actor: string, role: TrialRole): Promise<ActionOutcome> {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '受试者不存在' };
      if (!hasPermission(role, 'unblind')) return this.deny(role, 'unblind', actor, participant.participantNo);
      if (participant.status === 'withdrawn') return { ok: false, message: '受试者已撤药，不能揭盲' };
      if (participant.status === 'unblinded') return { ok: false, message: '该受试者已揭盲，揭盲记录只可追加' };
      if (!reason.trim()) return { ok: false, message: '揭盲原因不能为空' };
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      await this.appendAudit({
        actor,
        action: 'unblinded',
        detail: `紧急揭盲：随机号 ${participant.sequence}`,
        arm: participant.arm,
        reason: reason.trim(),
        participantNo: participant.participantNo
      });
      return { ok: true, message: '已揭盲，不可改写的审计记录已追加' };
    },

    /** 受控的治疗组查看请求：只有研究者在受试者已揭盲时放行，其余一律拒绝并审计 */
    async requestViewArm(id: string, actor: string, role: TrialRole): Promise<ActionOutcome & { arm?: Arm }> {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '受试者不存在' };
      if (role !== 'investigator' || participant.status !== 'unblinded') {
        return this.deny(role, 'view-arm', actor, participant.participantNo);
      }
      return { ok: true, message: `治疗组：${participant.arm}`, arm: participant.arm };
    }
  }
});
