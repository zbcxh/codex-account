# 低配常驻采集器实施计划

> 使用 superpowers:executing-plans 在当前会话逐项执行；用户已明确授权实现和隔离测试，不再重复请求方案确认。

**Goal:** 增加显式常驻模式，优先降低 CPU，限制整树启动私有提交量 300MiB、稳定 200MiB。

**Architecture:** 复用现有上报核心与设备身份；常驻会话自建 stdio app-server。外层 Windows Job 包含采集器及全部后代，实施总内存和 5% CPU 硬限额；内层 Job 仅负责回收自有官方会话。挂起创建并绑定后才执行，空闲使用事件等待。

**Tech Stack:** C# 5、.NET Framework、Windows Job Object、系统 C# 编译器。

**Spec:** ../specs/2026-10-29-low-resource-collector-design.md

## Global Constraints

- 不读取真实账号、不使用真实数据、不启用吴工任务、不安装或部署、不重启正式服务、不推送。
- 保留现有未提交修复和清理；不自动提交混合改动。
- 内存口径为整树私有提交量，同时报告工作集；不能用清空工作集伪装。
- 启动 120 秒、初始化后最多 30 秒收敛、查询 60 秒；连续失败 5/15/30 分钟退避，三次后暂停，显式恢复。
- 所有新增或修改函数、类添加中文功能、参数和返回说明。

## Review Focus

1. 启动失败或句柄绑定失败不能执行无约束代码。
2. 空闲通知、错误流和迟到响应不能造成积压或跨轮串号。
3. 外层 Job 必须包含控制进程，子孙进程不能绕开预算。
4. 旧任务周期不能被误报为常驻实际周期；升级不能覆盖运行中的采集器。
5. 队列恢复、账号切换、迁移与 DPAPI 身份语义不得因复用会话而改变。

## Task 1: 资源边界与 RPC 会话

**Files:** 新增 `client-compiled/ResidentProcess.cs`、`client-compiled/ResidentSession.cs`、`client-compiled/tests/ResidentTests.cs`；修改构建脚本。

**Interfaces:** `ResidentBudget` 管理外层 Job；`ResidentProcess` 提供受控管道与会话 Job；`ResidentSession.Collect()` 返回与短进程相同的报告。

- [x] 先编写并运行缺少接口时失败的合成测试。
- [x] 实现挂起创建、句柄白名单、总 CPU/内存限制、嵌套会话回收。
- [x] 实现一次初始化、多轮独立身份校验、有界 stdout/stderr 与唯一请求编号。
- [x] 验证查询超时、身份变更、通知洪流、异常退出、内存增长和完整子树回收。

## Task 2: 常驻调度与可靠上报

**Files:** 新增 `client-compiled/ResidentCollector.cs`；修改 `QuotaClient.cs`、测试驱动及隔离测试。

**Interfaces:** `QuotaClient.RunCollected(...)` 复用队列和配置协议；`ResidentTaskStore` 通过内部定时器确认实际周期；`ResidentCollector.Run(...)` 持有生命周期锁和预算。

- [x] 先写失败测试，覆盖单次初始化多次上报、锁冲突、周期读回与历史响应隔离。
- [x] 从现有 Run 提取已收集报告的处理核心，保留原短进程行为。
- [x] 增加 `--resident`；仅本机有界 CPU 参数；退避使用单调时钟，第三次失败后等待最终退避再暂停退出。
- [x] 复用现有迁移、队列和身份，失败不清队列；暂停标记必须显式恢复。

## Task 3: 显式安装模式与交付

**Files:** 安装入口与说明、设计状态、客户端指南、AGENTS.md、AOCI 和 CodeGraph。

- [x] 以任务替身测试常驻任务动作、无两分钟上限、无重复触发和身份保留。
- [x] 显式模式选择，缺省仍短进程；不对任何真实任务应用。
- [x] 编译候选到临时目录，运行合成资源/RPC/客户端/安装回归；保留未实测边界。
- [x] 独立审阅通过；低配候选的 AOCI 118条已通过Verify、Check与Guide complete，CodeGraph已同步。后续OTA设计属于新阶段，单独维护其文档变化。

## 执行记录

- Ruling: 在当前脏工作区继续，不切换或覆盖既有内容，不自动提交；这是用户连续任务的最新源码。
- Ruling: 外层 Job 包含控制进程以实现整树私有提交硬限制；内层仅回收官方会话，避免结束控制进程来退避。
- Pre-flight: Task 2 消费 Task 1 的报告与预算接口；Task 3 只生成显式任务定义，不执行安装。

- Ruling: 常驻转换独立显式入口，不更改原任务禁用状态；内部周期独立持久化，不重写身份配置。
- Review: 整树退出确认缺口已补足；未知清理立即暂停、管道写入计入超时、完整健康周期才清零失败，均有合成回归。
- Evidence: Windows峰值计数与1ms私有提交样本的差异保留在LOW-RESOURCE-COLLECTOR.md；没有宣称目标机或真实官方预算达标。
