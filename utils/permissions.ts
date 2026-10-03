import type { TrialRole } from '~/types/trial';

export type Permission =
  | 'randomize'        // 区组发号
  | 'withdraw'         // 撤药作废
  | 'first-dose'       // 登记首剂给药
  | 'dispense'         // 发药（药品管理员）
  | 'unblind'          // 研究者揭盲
  | 'commit-pending'   // 离线待提交入库
  | 'view-arm'         // 查看治疗组
  | 'view-reason'      // 查看撤药/揭盲原因
  | 'view-dispense';   // 查看看发药标识

const MATRIX: Record<Permission, TrialRole[]> = {
  randomize: ['coordinator', 'investigator'],
  withdraw: ['coordinator', 'investigator'],
  'first-dose': ['coordinator', 'investigator'],
  dispense: ['pharmacist'],
  unblind: ['investigator'],
  'commit-pending': ['coordinator', 'investigator'],
  'view-arm': ['investigator'],
  'view-reason': ['investigator', 'coordinator', 'monitor'],
  'view-dispense': ['pharmacist', 'investigator']
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  randomize: '区组发号',
  withdraw: '撤药作废',
  'first-dose': '登记首剂给药',
  dispense: '药品发放',
  unblind: '紧急揭盲',
  'commit-pending': '待提交入库',
  'view-arm': '查看治疗组',
  'view-reason': '查看撤药/揭盲原因',
  'view-dispense': '查看发药标识'
};

export const hasPermission = (role: TrialRole, permission: Permission) => MATRIX[permission].includes(role);
