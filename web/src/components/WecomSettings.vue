<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api';
import { useUI } from '../store';

const ui = useUI();
const configured = ref<boolean | null>(null);
const webhook = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
interface Delivery { id: number; kind: string; triggered_at: number; status: string; result_code: string | null; device_name: string | null }
interface Status { configured: boolean; deliveries: Delivery[] }
const deliveries = ref<Delivery[]>([]);
const kinds: Record<string, string> = { test: '测试消息', devices: '多设备上线', reset_primary: '主窗口重置', reset_secondary: '次窗口重置' };
const statuses: Record<string, string> = { sending: '发送中', sent: '企微已接收', failed: '发送失败', unknown: '结果未知' };

/** 功能：显示触发时间；参数：seconds 为 Unix 秒；返回值：本机日期时间。 */
function date(seconds: number) { return new Date(seconds * 1000).toLocaleString(); }

/** 功能：显式发送测试消息并读取结果；参数：无；返回值：异步完成。 */
async function test() {
  if (busy.value || !ui.authorized || !configured.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await api.mutate<{ sent: boolean }>('/api/wecom/test', {});
    if (ui.authorized) {
      notice.value = result.sent ? '测试消息已被企业微信接收，请在群内查看。' : '';
      error.value = result.sent ? '' : '测试消息发送失败，请查看最近提醒记录。';
      const state = await api.mutate<Status>('/api/wecom/status', {});
      if (ui.authorized) deliveries.value = state.deliveries;
    }
  } catch (cause) {
    if (ui.authorized) error.value = cause instanceof Error ? cause.message : '测试失败';
  } finally { busy.value = false; }
}

/** 功能：在授权后读取或更新企微推送配置；参数：undefined 读取，null 停用，字符串保存；返回值：异步完成。 */
async function update(value?: string | null) {
  if (busy.value) return;
  if (!ui.authorized) {
    ui.authOpen = true;
    return;
  }
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = value === undefined
      ? await api.mutate<Status>('/api/wecom/status', {})
      : await api.mutate<Status>('/api/wecom/save', { webhook: value });
    if (ui.authorized) {
      configured.value = result.configured;
      deliveries.value = result.deliveries;
      if (value !== undefined) notice.value = value === null ? '提醒已停用，即时生效。' : 'Webhook 已保存，提醒即时启用。';
    }
  } catch (cause) {
    if (ui.authorized) error.value = cause instanceof Error ? cause.message : '操作失败';
  } finally {
    webhook.value = '';
    busy.value = false;
  }
}

// 退出授权时清空界面里的地址和配置状态。
watch(() => ui.authorized, authorized => {
  if (!authorized) {
    configured.value = null;
    webhook.value = '';
    error.value = '';
    notice.value = '';
    deliveries.value = [];
  } else {
    void update();
  }
}, { immediate: true });
</script>

<template>
  <section class="panel" style="margin-top:20px">
    <div class="panel-head">
      <span class="panel-title">企业微信提醒</span>
      <el-button :loading="busy" @click="update()">{{ ui.authorized ? '刷新状态' : '管理授权' }}</el-button>
    </div>
    <div class="panel-body" v-if="ui.authorized">
      <p><el-tag :type="configured ? 'success' : 'info'">{{ configured === null ? '正在读取状态' : configured ? '提醒已启用' : '提醒已停用' }}</el-tag></p>
      <p>同账号第 3 台设备上线时提醒，之后每新增一台提醒一次。重复上报不发，降回 2 台后可再次触发。</p>
      <p>额度按主、次窗口实际返回的重置时间提醒，同账号同窗口同时间只提醒一次。重置消息表示已到预计时间。</p>
      <el-input v-model="webhook" type="password" autocomplete="off" :disabled="busy"
        aria-label="企业微信 Webhook 地址" placeholder="输入新的企业微信群机器人 Webhook 地址" />
      <div style="margin-top:12px">
        <el-button type="primary" :disabled="busy || !webhook.trim()" @click="update(webhook)">保存地址</el-button>
        <el-button :disabled="busy || !configured" @click="test">发送测试消息</el-button>
        <el-button type="danger" plain :disabled="busy || !configured" @click="update(null)">停用提醒</el-button>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
      <h3>最近提醒记录</h3>
      <el-table :data="deliveries" empty-text="暂无触发记录" style="width:100%">
        <el-table-column label="触发时间" min-width="180"><template #default="{ row }">{{ date(row.triggered_at) }}</template></el-table-column>
        <el-table-column label="类型" min-width="120"><template #default="{ row }">{{ kinds[row.kind] || row.kind }}</template></el-table-column>
        <el-table-column label="触发设备" min-width="140"><template #default="{ row }">{{ row.device_name || '—' }}</template></el-table-column>
        <el-table-column label="结果" min-width="120"><template #default="{ row }">{{ statuses[row.status] || row.status }}</template></el-table-column>
        <el-table-column prop="result_code" label="结果码" min-width="150" />
      </el-table>
    </div>
  </section>
</template>
