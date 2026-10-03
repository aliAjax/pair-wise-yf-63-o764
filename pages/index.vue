<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { Participant, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, writeFail } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({ validationSchema: schema, initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' } });
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

const roleLabel: Record<TrialRole, string> = { investigator: '研究者', pharmacist: '药品管理员', monitor: '监察员' };

const statusMeta = (status: Participant['status']) => {
  if (status === 'unblinded') return { type: 'danger' as const, text: '已揭盲' };
  if (status === 'withdrawn') return { type: 'warning' as const, text: '已作废' };
  return { type: 'info' as const, text: '已随机' };
};

/** 药品管理员只看发药标识，不见治疗组 */
const dispensingId = (p: Participant) => `DP-${p.sequence}`;

const submit = handleSubmit(async (values) => {
  const result = await trial.randomize(values, offline.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
});

const firstDose = (row: Participant) => {
  const result = trial.recordFirstDose(row.id, actor.value ?? '', role.value);
  if (!result.ok) ElMessage.error(result.message);
  else ElMessage.success(result.message);
};

const withdraw = async (row: Participant) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${row.participantNo} 填写撤药作废原因（未首剂给药）`, '撤药作废', {
      inputType: 'textarea',
      inputValidator: (v) => Boolean(v?.trim()) || '撤药原因不能为空',
      confirmButtonText: '确认作废（号码保留不分配）'
    });
    const result = trial.withdraw(row.id, value, actor.value ?? '', role.value);
    if (!result.ok) ElMessage.error(result.message);
    else ElMessage.warning(result.message);
  } catch {}
};

const unblind = async (row: Participant) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${row.participantNo} 填写紧急揭盲原因`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (v) => Boolean(v?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认揭盲并审计'
    });
    const result = trial.emergencyUnblind(row.id, value, actor.value ?? '', role.value);
    if (!result.ok) ElMessage.error(result.message);
    else ElMessage.warning(result.message);
  } catch {}
};

const showReason = (row: Participant) => {
  const result = trial.viewReason(row.id, actor.value ?? '', role.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessageBox.alert(result.reason ?? '', `${row.participantNo} · 原因记录`, { confirmButtonText: '关闭' });
};

/** 越权查看治疗组：监察员/药品管理员点击即被拒绝并审计 */
const peekArm = (row: Participant) => {
  const result = trial.viewArm(row.id, actor.value ?? '', role.value);
  if (!result.ok) ElMessage.error(result.message);
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  withdrawn: trial.withdrawnCount,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount
}));

const auditType = (action: string) => {
  if (action === 'unblinded') return 'danger';
  if (action === 'withdrawn') return 'warning';
  if (action === 'unauthorized-blocked' || action === 'duplicate-blocked') return 'danger';
  if (action === 'first-dose') return 'success';
  return 'primary';
};
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>撤药作废</span><b>{{ counts.withdrawn }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b>
          <div style="float:right;display:flex;gap:12px;align-items:center">
            <el-switch v-model="offline" active-text="模拟离线" />
            <el-switch v-model="writeFail" active-text="模拟写盘失败" />
          </div>
        </template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-004" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">执行分层区组随机</el-button>
        </el-form>
        <el-alert type="info" :closable="false" style="margin-top:12px"
          title="区组发号规则"
          description="每 4 个号一个区组（2A/2B 随机排列）。作废记录永久保留随机号、不再分配，后续发号围绕保留槽位重新平衡。写盘失败时号码不占用，可原样重试。" />
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ roleLabel[role] }}</el-tag></div></template>
        <el-table :data="participants" max-height="520">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="100" />
          <el-table-column prop="sequence" label="随机号" width="80" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }"><el-tag :type="statusMeta(row.status).type">{{ statusMeta(row.status).text }}</el-tag></template>
          </el-table-column>
          <el-table-column v-if="role === 'pharmacist'" label="发药标识" width="110">
            <template #default="{ row }"><el-tag type="success">{{ dispensingId(row as Participant) }}</el-tag></template>
          </el-table-column>
          <el-table-column v-else label="治疗组" width="100">
            <template #default="{ row }">
              <el-tag v-if="role === 'investigator'" :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ row.arm }}</el-tag>
              <el-button v-else size="small" text type="info" @click="peekArm(row as Participant)">
                <el-icon><Lock /></el-icon>&nbsp;已隐藏
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="240">
            <template #default="{ row }">
              <template v-if="role === 'investigator'">
                <el-button v-if="row.status === 'randomized' && !row.firstDoseAt" size="small" @click="firstDose(row as Participant)">记录首剂</el-button>
                <el-button v-if="row.status === 'randomized' && !row.firstDoseAt" size="small" type="warning" plain @click="withdraw(row as Participant)">撤药作废</el-button>
                <el-button v-if="row.status === 'randomized'" size="small" type="danger" plain @click="unblind(row as Participant)">揭盲</el-button>
                <el-button v-if="row.status === 'withdrawn' || row.status === 'unblinded'" size="small" plain @click="showReason(row as Participant)">查看原因</el-button>
              </template>
              <template v-else-if="role === 'monitor'">
                <el-button v-if="row.withdrawReason || row.unblindReason" size="small" plain @click="showReason(row as Participant)">查看原因</el-button>
                <el-button size="small" type="info" plain @click="peekArm(row as Participant)">查看治疗组</el-button>
              </template>
              <template v-else>
                <el-button size="small" type="info" plain @click="showReason(row as Participant)">查看原因</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" />
          <el-table-column prop="status" label="状态" />
          <el-table-column label="操作"><template #default="{ row }"><el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actor ?? '')">确认入库</el-button></template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加 · 不可改写</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="auditType(entry.action)">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: repeat(2, 1fr) !important; } }
</style>
