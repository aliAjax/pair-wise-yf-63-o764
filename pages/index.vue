<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { Participant, TrialRole } from '~/types/trial';
import { canViewParticipantArm, canViewReason, redactAudit, verifyChain } from '~/utils/audit';
import { hasPermission } from '~/utils/permissions';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, nextSequence, balance } = storeToRefs(trial);

const ROLE_OPTIONS: { label: string; value: TrialRole }[] = [
  { label: '协调员', value: 'coordinator' },
  { label: '研究者', value: 'investigator' },
  { label: '药品管理员', value: 'pharmacist' },
  { label: '监察员', value: 'monitor' }
];
const role = ref<TrialRole>('coordinator');
const defaultActors: Record<TrialRole, string> = {
  coordinator: '协调员陈晨',
  investigator: '研究者张宁',
  pharmacist: '药管林药师',
  monitor: '监察员周巡'
};
const actor = ref(defaultActors.coordinator);
const roleLabel = (r: TrialRole) => ROLE_OPTIONS.find((item) => item.value === r)?.label ?? r;
const switchRole = (r: TrialRole) => { role.value = r; actor.value = defaultActors[r]; };

const failWrite = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '身份核验标识不少于4位'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+'])
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({
  validationSchema: schema,
  initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64' }
});
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');

const report = (result: { ok: boolean; message: string }) => {
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

const submit = handleSubmit(async (values) => {
  const result = await trial.randomize({ ...values, actor: actor.value }, { role: role.value, failWrite: failWrite.value });
  report(result);
  if (result.ok) resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand } });
});

/** 两位协调员同时提交：同号临界区只放行一个，另一个立即被拒绝 */
const simulateConcurrent = async () => {
  const stamp = Date.now();
  const base = { site: site.value, ageBand: ageBand.value };
  const [first, second] = await Promise.all([
    trial.randomize({ ...base, participantNo: `C-${stamp.toString().slice(-5)}A`, identityKey: `concurrent-${stamp}-A`, actor: '协调员甲' }, { role: 'coordinator' }),
    trial.randomize({ ...base, participantNo: `C-${stamp.toString().slice(-5)}B`, identityKey: `concurrent-${stamp}-B`, actor: '协调员乙' }, { role: 'coordinator' })
  ]);
  ElMessage[first.ok ? 'success' : 'error'](`协调员甲：${first.message}`);
  setTimeout(() => ElMessage[second.ok ? 'success' : 'warning'](`协调员乙：${second.message}`), 350);
};

/* -------------------------------------------------- 撤药 */
const withdraw = async (row: Participant) => {
  const beforeDose = !row.firstDoseAt;
  const title = beforeDose ? '撤药（尚未首剂给药）' : '撤药（已首剂给药）';
  const tip = beforeDose
    ? `该受试者尚未首剂给药。作废后原随机号 ${row.sequence} 将永久保留且不再分配，本区组补发同组新槽位重新平衡。请填写撤药原因：`
    : `该受试者已首剂给药。随机号 ${row.sequence} 与治疗记录保留，区组不补发。请填写终止用药原因：`;
  try {
    const { value } = await ElMessageBox.prompt(tip, title, {
      inputType: 'textarea',
      inputValidator: (v) => Boolean(v && v.trim()) || '撤药原因不能为空'
    });
    report(await trial.withdraw(row.id, value, actor.value, role.value));
  } catch {}
};

const recordDose = async (row: Participant) => report(await trial.recordFirstDose(row.id, actor.value, role.value));
const dispense = async (row: Participant) => report(await trial.dispense(row.id, actor.value, role.value));

const unblind = async (row: Participant) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${row.participantNo} 填写紧急揭盲原因，提交后生成不可改写的追加审计：`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (v) => Boolean(v && v.trim()) || '揭盲原因不能为空'
    });
    report(await trial.emergencyUnblind(row.id, value, actor.value, role.value));
  } catch {}
};

const requestArm = async (row: Participant) => {
  if (!hasPermission(role.value, 'view-arm')) {
    report(await trial.requestViewArm(row.id, actor.value, role.value));
    return;
  }
  report(await trial.requestViewArm(row.id, actor.value, role.value));
};

const commitPending = async (id: string) => report(await trial.commitPending(id, actor.value, role.value));

/* -------------------------------------------------- 视图 */
const statusTag = (row: Participant) => {
  if (row.status === 'withdrawn') return { type: 'danger', text: row.withdrawalKind === 'void-before-dose' ? '已作废(未给药)' : '已撤药(已给药)' };
  if (row.status === 'unblinded') return { type: 'warning', text: '已揭盲' };
  return { type: 'success', text: '已随机' };
};

const armCell = (row: Participant) => {
  if (!canViewParticipantArm(role.value, row.status)) return { text: '已隐藏', type: 'info' as const };
  return { text: row.arm, type: 'warning' as const };
};

const visibleAudits = computed(() => redactAudit(audits.value, role.value));
const chainState = ref<{ ok: boolean; brokenId?: string }>({ ok: true });
const verifyAudits = async () => {
  const broken = await verifyChain(audits.value);
  chainState.value = broken ? { ok: false, brokenId: broken.brokenId } : { ok: true };
  ElMessage[broken ? 'error' : 'success'](broken ? `哈希链在记录 ${broken.brokenId.slice(0, 8)} 处断裂，审计被改写！` : '哈希链校验通过：审计完整且未被改写');
};

const ACTION_LABEL: Record<string, string> = {
  randomized: '区组发号',
  withdrawn: '撤药作废',
  'first-dose': '首剂登记',
  dispensed: '发药',
  unblinded: '紧急揭盲',
  'access-denied': '越权拒绝',
  'pending-queued': '离线入队',
  'pending-committed': '队列入库',
  'duplicate-blocked': '重复拦截',
  'write-recovered': '失败重试恢复'
};

const counts = computed(() => ({
  total: participants.value.length,
  active: participants.value.filter((p) => p.status !== 'withdrawn').length,
  voided: balance.value.voided,
  unblinded: participants.value.filter((p) => p.status === 'unblinded').length,
  pending: trial.pendingCount
}));
</script>

<template>
  <main class="page">
    <header class="hero">
      <div>
        <el-tag type="success">GCP / IWRS 本地原型</el-tag>
        <h1>{{ t('title') }}</h1>
        <p>{{ t('subtitle') }}</p>
      </div>
      <el-radio-group :model-value="role" @update:model-value="switchRole">
        <el-radio-button v-for="option in ROLE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
      </el-radio-group>
    </header>

    <section class="stats">
      <div class="stat"><span>有效在组</span><b>{{ counts.active }}</b></div>
      <div class="stat"><span>作废保留号</span><b>{{ counts.voided }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
      <div class="stat"><span>区组有效槽 A/B</span><b>{{ balance.a }} / {{ balance.b }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <b>{{ t('randomize') }}</b>
            <el-switch v-model="failWrite" active-text="模拟下次写盘失败" />
          </div>
        </template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site">
            <el-select v-model="site" style="width:100%">
              <el-option label="上海中心" value="上海中心" />
              <el-option label="广州中心" value="广州中心" />
              <el-option label="新加坡中心" value="新加坡中心" />
            </el-select>
          </el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand">
            <el-radio-group v-model="ageBand">
              <el-radio-button value="18-44">18-44</el-radio-button>
              <el-radio-button value="45-64">45-64</el-radio-button>
              <el-radio-button value="65+">65+</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="操作人"><el-input v-model="actor" /></el-form-item>
          <div class="actions">
            <el-button type="primary" native-type="submit">执行分层区组发号</el-button>
            <el-button type="warning" plain @click="simulateConcurrent">模拟两位协调员同时提交</el-button>
          </div>
          <p class="hint">下一全局号游标：{{ nextSequence }}（号码只增不复用；写盘失败自动回滚，重试不会占号）</p>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header>
          <div class="card-head"><b>{{ t('participants') }}</b><el-tag>{{ roleLabel(role) }} · {{ actor }}</el-tag></div>
        </template>
        <el-table :data="participants" max-height="430" size="small">
          <el-table-column prop="participantNo" label="受试者" min-width="100" />
          <el-table-column prop="site" label="中心" min-width="92" />
          <el-table-column prop="sequence" label="随机号" width="78" />
          <el-table-column label="状态" width="118">
            <template #default="{ row }">
              <el-tag size="small" :type="statusTag(row).type">{{ statusTag(row).text }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="canViewParticipantArm(role, 'unblinded')" label="治疗组" width="84">
            <template #default="{ row }">
              <el-tag size="small" :type="armCell(row).type">{{ armCell(row).text }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="hasPermission(role, 'view-dispense')" label="发药标识" width="104">
            <template #default="{ row }">{{ row.dispenseKit ?? '—' }}</template>
          </el-table-column>
          <el-table-column v-if="canViewReason(role)" label="原因" min-width="120">
            <template #default="{ row }">
              <span v-if="row.withdrawReason" class="reason">撤药：{{ row.withdrawReason }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="240" fixed="right">
            <template #default="{ row }">
              <el-button v-if="hasPermission(role, 'withdraw') && row.status !== 'withdrawn'" size="small" type="danger" plain @click="withdraw(row)">撤药作废</el-button>
              <el-button v-if="hasPermission(role, 'first-dose') && !row.firstDoseAt && row.status === 'randomized'" size="small" plain @click="recordDose(row)">首剂</el-button>
              <el-button v-if="hasPermission(role, 'dispense') && row.status !== 'withdrawn' && !row.dispenseKit" size="small" type="success" plain @click="dispense(row)">发药</el-button>
              <el-button v-if="hasPermission(role, 'unblind') && row.status === 'randomized'" size="small" type="warning" plain @click="unblind(row)">揭盲</el-button>
              <el-button size="small" :type="role === 'investigator' ? 'warning' : 'info'" plain @click="requestArm(row)">查治疗组</el-button>
            </template>
          </el-table-column>
        </el-table>
        <p class="hint">
          药品管理员只见发药标识；监察员可查原因但治疗组始终隐藏；非研究者点击「查治疗组」会被拒绝并审计。
        </p>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <div class="stack">
        <el-card shadow="never">
          <template #header><b>{{ t('pending') }}</b></template>
          <el-empty v-if="pending.length === 0" description="暂无待提交记录" :image-size="60" />
          <el-table v-else :data="pending" size="small">
            <el-table-column prop="payload.participantNo" label="受试者" />
            <el-table-column prop="status" label="状态" width="100" />
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="commitPending(row.id)">确认入库</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <b>区分层区组台账</b>
              <el-tag size="small" type="info">每区组4槽 · 作废号保留 · 补发再平衡</el-tag>
            </div>
          </template>
          <div class="blocks">
            <template v-for="(stratum, key) in trial.ledger" :key="key">
              <div v-for="(block, bi) in stratum.blocks" :key="`${key}-${bi}`" class="block">
                <div class="block-title">{{ key }} · 区组 {{ bi + 1 }}</div>
                <div class="slots">
                  <el-tag v-for="slot in block" :key="slot.sequence" size="small" :type="slot.status === 'voided' ? 'danger' : slot.participantNo ? 'success' : slot.replacement ? 'warning' : 'info'">
                    #{{ slot.sequence }}<template v-if="slot.replacement">补</template>
                    {{ slot.status === 'voided' ? '作废' : slot.participantNo ? slot.participantNo : '待发' }}
                  </el-tag>
                </div>
              </div>
            </template>
          </div>
        </el-card>
      </div>

      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <b>{{ t('audit') }}</b>
            <div>
              <el-tag type="warning" size="small">仅追加 · SHA-256 哈希链</el-tag>
              <el-button size="small" plain style="margin-left:8px" @click="verifyAudits">校验完整性</el-button>
            </div>
          </div>
        </template>
        <el-alert v-if="!chainState.ok" type="error" :closable="false" show-icon title="审计哈希链断裂：存在改写痕迹" style="margin-bottom:10px" />
        <el-timeline class="audit-list">
          <el-timeline-item v-for="entry in visibleAudits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()"
            :type="entry.action === 'unblinded' ? 'danger' : entry.action === 'access-denied' ? 'warning' : entry.action === 'withdrawn' ? 'danger' : entry.action === 'write-recovered' ? 'success' : 'primary'">
            <b>{{ entry.actor }} · {{ ACTION_LABEL[entry.action] ?? entry.action }}</b>
            <div>{{ entry.detail }}</div>
            <div v-if="entry.reason && canViewReason(role)" class="reason">原因：{{ entry.reason }}</div>
            <div v-if="entry.arm && role === 'investigator'" class="arm-secret">治疗组：{{ entry.arm }}</div>
            <div class="hash">链：{{ entry.prevHash === 'GENESIS' ? 'GENESIS' : `…${entry.prevHash.slice(0, 10)}` }} → {{ entry.hash.slice(0, 12) }}…</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
.stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:14px; margin-bottom:20px; }
.card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.actions { display:flex; gap:10px; flex-wrap:wrap; }
.hint { color:#7a909d; font-size:12px; margin:8px 0 0; }
.stack { display:flex; flex-direction:column; gap:20px; }
.blocks { display:flex; flex-direction:column; gap:10px; max-height:330px; overflow:auto; }
.block { border:1px solid #d9e8e8; border-radius:10px; padding:8px 10px; }
.block-title { font-size:12px; color:#607889; margin-bottom:6px; }
.slots { display:flex; flex-wrap:wrap; gap:6px; }
.reason { color:#b04a4a; font-size:12px; }
.muted { color:#aab8c0; }
.arm-secret { color:#9a6a00; font-size:12px; }
.hash { color:#9fb3bd; font-size:11px; font-family:ui-monospace,monospace; margin-top:2px; }
.audit-list { max-height:430px; }
@media (max-width: 900px) { .stats { grid-template-columns:1fr 1fr; } }
</style>
