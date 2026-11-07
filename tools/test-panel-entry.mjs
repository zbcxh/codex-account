import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server/server.mjs', import.meta.url), 'utf8');
const begin = source.indexOf('const panelSelector =');
const end = source.indexOf('const MIME =', begin);
assert.ok(begin > 0 && end > begin);

/** 功能：在内存文件系统替身中执行真实面板入口选择逻辑。参数：选择器内容及入口存在标记。返回值：实际选择的静态目录。 */
function selectPanel(selector, hasIndex = true) {
  const here = path.resolve('fixture/server');
  const context = {
    HERE: here, path,
    fs: {
      /** 功能：模拟选择器或构建入口存在性。参数：目标路径。返回值：是否存在。 */
      existsSync(file) { return file === path.join(here, 'web-current.json') ? selector !== null : hasIndex; },
      /** 功能：返回合成选择器。参数：无。返回值：JSON 文本。 */
      readFileSync() { return JSON.stringify({ version: selector }); },
    },
  };
  return vm.runInNewContext(source.slice(begin, end) + '\nPUBLIC_DIR;', context);
}

test('无选择器使用当前 Vue 构建，不引用已删除旧面板', () => {
  assert.equal(selectPanel(null), path.resolve('fixture/web/dist'));
});
test('保留现有选择器对应的 Vue 部署路径', () => {
  assert.equal(selectPanel('current-20261029'), path.resolve('fixture/server/web-releases/current-20261029'));
});
test('缺少 Vue 构建时明确失败', () => {
  assert.throws(() => selectPanel(null, false), /panel_index_missing/);
});
test('选择器不能通过路径穿越暴露项目文件', () => {
  for (const version of ['../data', 'a/b', '..', '']) {
    assert.throws(() => selectPanel(version), /invalid_panel_version/);
  }
});
