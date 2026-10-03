import { defineStore } from 'pinia';
import type { ActionResult, Arm, AuditEntry, Block, Participant, PendingRandomization, RandomizeInput, TrialRole } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v2';
const BLOCK_SIZE = 4;

interface PersistShape {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  blocks: Block[];
}

const seed: PersistShape = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A', firstDoseAt: new Date(Date.now() - 86400_000).toISOString() },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' },
    // 作废记录：随机号 1003 永久保留，不再分配；区组槽位保留，后续发号围绕该槽位重新平衡
    { id: 'p-3', participantNo: 'S01-003', identityKey: 'demo-c', site: '上海中心', ageBand: '45-64', status: 'withdrawn', sequence: 1003, arm: 'A', withdrawnAt: new Date(Date.now() - 3600_000).toISOString(), withdrawReason: '受试者撤回知情同意（未首剂给药）' }
  ],
  blocks: [
    // S01-003 占住第 3 槽（A），下一位发第 4 槽（B），区组仍 2A/2B 平衡
    { id: 'b-1', stratum: '上海中心__45-64', arms: ['A', 'B', 'A', 'B'], slots: ['p-1', 'p-2', 'p-3', null] }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层区组随机，中央随机号 1002', participantNo: 'S01-002' },
    { id: 'a-2', at: new Date(Date.now() - 3600_000).toISOString(), actor: '研究者张宁', action: 'withdrawn', detail: '撤药作废（未首剂给药）：受试者撤回知情同意（未首剂给药）；随机号 1003 永久保留，不再重新分配', participantNo: 'S01-003' }
  ],
  pending: []
};

function shuffleArms(): Arm[] {
  const arms: Arm[] = ['A', 'A', 'B', 'B'];
  for (let i = arms.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arms[i], arms[j]] = [arms[j], arms[i]];
  }
  return arms;
}

function stratumKey(site: string, ageBand: string): string {
  return `${site}__${ageBand}`;
}

/**
 * 互斥锁：协调员同时提交时，只有一个能进入发号临界区，
 * 从根上保证两人不会拿到同一个随机号。
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => T): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export const useTrialStore = defineStore('trial', {
  state: (): PersistShape & { writeFail: boolean } => ({ ...readLocal(STORAGE_KEY, seed), writeFail: false }),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    withdrawnCount: (state) => state.participants.filter((item) => item.status === 'withdrawn').length
  },
  actions: {
    persist() {
      if (this.writeFail) throw new Error('WRITE_INJECTED_FAILURE');
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        blocks: this.blocks
      });
    },
    /** 审计只追加、不改写；写盘故障时审计仍保留在内存中，不阻断主流程 */
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      try { this.persist(); } catch { /* 写盘故障期间审计仅留存内存 */ }
    },
    async randomize(input: RandomizeInput, offline = false): Promise<ActionResult> {
      return serialize(() => {
        if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
          this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
          return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
        }
        if (offline) {
          this.pending.unshift({ id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' });
          this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
          return { ok: true, message: '已加入待提交队列，联网后确认入库' };
        }
        return this.commitRandomization(input);
      });
    },
    /**
     * 区组发号：按「中心+年龄层」分层，每 4 个号一个区组（2A/2B 随机排列）。
     * 作废记录永久占用槽位、随机号不再分配；后续发号围绕保留槽位重新平衡。
     * 写盘失败时回滚内存分配——号码不被占用，可原样重试。
     */
    commitRandomization(input: RandomizeInput): ActionResult {
      const key = stratumKey(input.site, input.ageBand);
      let block = this.blocks.find((item) => item.stratum === key && item.slots.some((slot) => slot === null));
      let created = false;
      if (!block) {
        block = { id: crypto.randomUUID(), stratum: key, arms: shuffleArms(), slots: new Array(BLOCK_SIZE).fill(null) };
        this.blocks.push(block);
        created = true;
      }
      const slotIndex = block.slots.findIndex((slot) => slot === null);
      const sequence = this.participants.length
        ? Math.max(...this.participants.map((item) => item.sequence)) + 1
        : 1001;
      const participant: Participant = {
        id: crypto.randomUUID(),
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        actor: input.actor,
        status: 'randomized',
        sequence,
        arm: block.arms[slotIndex]
      };
      block.slots[slotIndex] = participant.id;
      this.participants.unshift(participant);
      try {
        this.persist();
      } catch {
        // 回滚：释放槽位、撤出受试者、新区组则整体撤除——号码不被占用
        this.participants.shift();
        block.slots[slotIndex] = null;
        if (created) this.blocks.pop();
        return { ok: false, retryable: true, message: '写盘失败：随机号未占用，请关闭故障开关后重试' };
      }
      this.addAudit('randomized', `${input.participantNo} 完成分层区组随机，中央随机号 ${sequence}（区组 ${block.id.slice(0, 8)}）`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央随机号 ${sequence}`, arm: participant.arm };
    },
    commitPending(id: string, actor: string) {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      const result = this.commitRandomization(pending.payload);
      if (!result.ok) return; // 写盘失败时保留待处理状态，允许重试且不占号
      pending.status = 'committed';
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
    },
    /** 记录首剂给药（研究者）。已首剂的受试者不能走未首剂作废流程。 */
    recordFirstDose(id: string, actor: string, role: TrialRole): ActionResult {
      if (role !== 'investigator') {
        this.addAudit('unauthorized-blocked', `越权操作被拒绝：非研究者角色记录首剂给药`, actor);
        return { ok: false, message: '越权操作已拒绝并记录审计' };
      }
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '未找到受试者' };
      if (participant.status !== 'randomized') return { ok: false, message: '当前状态不可记录首剂' };
      if (participant.firstDoseAt) return { ok: false, message: '已记录首剂给药' };
      participant.firstDoseAt = new Date().toISOString();
      this.addAudit('first-dose', `${participant.participantNo} 记录首剂给药`, actor, participant.participantNo);
      return { ok: true, message: '已记录首剂给药' };
    },
    /**
     * 撤药作废（未首剂给药）：必须填写原因；原随机号与治疗组永久保留在记录中，
     * 区组槽位不释放、号码不再分配，后续区组发号围绕保留槽位重新平衡。
     */
    withdraw(id: string, reason: string, actor: string, role: TrialRole): ActionResult {
      if (role !== 'investigator') {
        this.addAudit('unauthorized-blocked', `越权操作被拒绝：非研究者角色执行撤药作废`, actor);
        return { ok: false, message: '越权操作已拒绝并记录审计' };
      }
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '未找到受试者' };
      if (participant.status !== 'randomized') return { ok: false, message: '已撤药或已揭盲，不能重复作废' };
      if (participant.firstDoseAt) return { ok: false, message: '已首剂给药，不适用未首剂作废流程' };
      if (!reason.trim()) return { ok: false, message: '撤药原因不能为空' };
      participant.status = 'withdrawn';
      participant.withdrawnAt = new Date().toISOString();
      participant.withdrawReason = reason.trim();
      this.addAudit('withdrawn', `撤药作废（未首剂给药）：${participant.withdrawReason}；随机号 ${participant.sequence} 永久保留，不再重新分配`, actor, participant.participantNo);
      return { ok: true, message: `已作废：随机号 ${participant.sequence} 永久保留，后续发号已重新平衡` };
    },
    /** 紧急揭盲（研究者）：原因必填，审计仅追加；审计内容不含治疗组，避免跨角色泄露。 */
    emergencyUnblind(id: string, reason: string, actor: string, role: TrialRole): ActionResult {
      if (role !== 'investigator') {
        this.addAudit('unauthorized-blocked', `越权操作被拒绝：非研究者角色执行紧急揭盲`, actor);
        return { ok: false, message: '越权操作已拒绝并记录审计' };
      }
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '未找到受试者' };
      if (participant.status !== 'randomized') return { ok: false, message: '当前状态不可揭盲' };
      if (!reason.trim()) return { ok: false, message: '揭盲原因不能为空' };
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      participant.unblindReason = reason.trim();
      this.addAudit('unblinded', `紧急揭盲（原因已记录，仅追加不可改写）：${participant.unblindReason}`, actor, participant.participantNo);
      return { ok: true, message: '已揭盲，审计记录已追加' };
    },
    /** 查看撤药/揭盲原因：监察员可查原因但看不到治疗组；药品管理员无权查看，越权即拒绝并审计。 */
    viewReason(id: string, actor: string, role: TrialRole): ActionResult {
      if (role === 'pharmacist') {
        this.addAudit('unauthorized-blocked', `越权查看被拒绝：药品管理员无权查看揭盲/撤药原因`, actor);
        return { ok: false, message: '药品管理员无权查看原因，已拒绝并审计' };
      }
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '未找到受试者' };
      const reason = participant.withdrawReason ?? participant.unblindReason;
      if (!reason) return { ok: false, message: '暂无原因记录' };
      return { ok: true, message: reason, reason };
    },
    /** 查看治疗组：仅研究者；监察员、药品管理员越权查看一律拒绝并审计。 */
    viewArm(id: string, actor: string, role: TrialRole): ActionResult {
      if (role !== 'investigator') {
        this.addAudit('unauthorized-blocked', `越权查看被拒绝：${role === 'monitor' ? '监察员' : '药品管理员'}无权查看治疗组`, actor);
        return { ok: false, message: '越权查看治疗组已拒绝并审计' };
      }
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !participant.arm) return { ok: false, message: '未找到治疗组' };
      return { ok: true, message: participant.arm, arm: participant.arm };
    }
  }
});
