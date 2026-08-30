# OpenClaw × Telegram × Ocean Wave

这是一个只读的实时研究流水线，监听 Telegram 的“美股百家论”和“Go Finance”，不发频道消息、不点赞、不转发，也不下单。

## 实时流程

1. Telegram 新消息或编辑到达后，先在 1 秒内写入 SQLite，并保存每个频道的消息游标。
2. 本地快速识别器立即标记明确的 Buy to Open、加仓、Sell to Close、止盈和止损；AI 暂时不可用时也不会漏掉原始信号。
3. 有截图时保存原图和哈希。Sharp/libvips 在 Node 进程内完成 EXIF 旋转、缩放和超宽图分段，再交给 Luna 视觉识别；视觉临时 PNG 在分析后立即删除，不再为每张图启动 Python。
4. Luna 合并文字和图片，抽取代码、到期日、行权价、Call/Put、方向、价格、仓位与生命周期。
5. 同一接收周期并行启动 Schwab 和 Fidelity：Schwab 提供完整期权链，Fidelity 校验标的价格。Schwab 成功后最多额外等 Fidelity 1 秒；Schwab 失败时仍完整等待 Fidelity 备援。两源报价时间相差超过 15 秒时 Fidelity 只能标记陈旧，不能通过验证。Schwab token 在进程内按到期时间缓存并单飞刷新，避免每条行情同步调用 DPAPI。Ocean Wave 的常驻隐藏 worker 已在监听就绪前预热，数值热路径使用 C++，不会为每条信号重复启动 Python。Terra 使用真实报价时间分析 Greeks、IV、期限结构、事件、新闻和“为什么此时”；数据不足时必须降级，不得补造数值。
6. 精确、实时且时间对齐的开仓报价通过验证后，全局共享的一个预测进程和一个学习进程同时接管仓位；两个进程分别用 `workflow_id` 隔离状态，不再为每笔仓位各占两个 Node 运行时。预测侧冻结 Ocean Wave 当时的概率、方向、置信度与可成交 ask，学习侧分别保存开仓 Terra、退出 Terra 和因子贡献。卖出信号到达后，用当时可成交 bid 验证预测，计算 Brier/log-loss，将一次有界反馈写入影子校准器，并立即删除该仓位在两个进程中的状态。子进程崩溃时由数据库事件重放；只有监听器安全退出才关闭两个共享进程。
7. Sol 按 `America/Los_Angeles` 的自然日串联记录，提出 Ocean Wave challenger；没有足够的样本和点时数据时不能晋级生产模型。Sol 的计算输入只包含明确期权交易及其关联生命周期；大盘、指数、支撑阻力、新闻观点等文字作为独立的次要语境留库，不会传给 Sol，不参与盈亏、胜率、校准、训练或模型优化。回测的点时行情覆盖率同样只统计明确期权买入信号。

两个频道的固定语义是：明确开仓和加仓均为 `Buy to Open`；开仓文本中的数字 `@价格` 是频道确认成交价；缺失到期日时使用信号时刻 Schwab 期权链中最近的挂牌到期日；止盈、止损、盈利自控、翻倍兑现和平仓均为 `Sell to Close`。频道确认成交与券商/NBBO 独立验证始终分栏记录。退出优先沿 Telegram 回复链关联；回复链断裂时，只在代码或合同唯一匹配时使用活跃仓位台账，歧义时保持未关联。

“止盈 50%”“止损 50%”按当时剩余仓位的 50% 卖出；“盈利自控”每出现一次同样卖出当时剩余仓位的 50%，因此多次出现按几何方式递减（100% → 50% → 25% → 12.5%）。`清掉`、`清空`、`走完` 等明确话术卖出全部剩余仓位。部分退出后预测和学习状态继续保留；到期时若仍有剩余仓位但频道没有给出最终退出指令，系统进入人工选择，不擅自把剩余部分结算成频道交易结果。

有明确到期日（包括按最近挂牌日补全）的期权不会按每日收盘或通用持仓时长提前结算。完全没有退出指令的仓位会保持未成熟状态，到到期日常规收盘才用最后可获得的期权 bid/数字结算；若已经发生过部分退出而频道没有给出剩余部分的最终指令，则转入人工选择。最终期权报价确实缺失时才使用并明确标注内在价值估算。`orphanMaxHoldHours` 只负责回收极少数无法解析出到期日的损坏/旧记录，绝不作用于有效日期合约。

OpenClaw 网关断线或模型偶发输出非 JSON 时，分析层会先进行内部格式重试；后台消息修复会继续使用持久化原文和点时行情。只有连续两轮仍未恢复才发送异常通知，恢复后发送一次恢复通知。原始 Telegram 消息、快速扫描结果和信号时点行情均在 AI 调用之前持久化。

同一 Telegram 消息的编辑版本全部保留作审计，但统计、日报、回测、生命周期和模型反馈只读取最终版本；事件时间使用 `edited_at`，没有编辑时才使用 `published_at`。同一消息、同一 Luna/Terra 阶段的重复成功重试也只取最后一次。这样 `清掉@0.90` 后编辑为 `清掉@0.94` 只会按 `0.94` 结算一次。

## 只关注新数据

新数据库第一次启动时，只读取每个频道最新消息 ID 作为基线，不保存或分析旧消息。之后若程序短暂断线，只补齐已经建立基线之后、且 ID 大于已保存游标的消息。这是断点续传，不会倒查基线之前的频道历史。

事件订阅是实时主路径；10 秒游标轮询只负责断线补洞。原始消息、快速信号和频道游标在同一个短事务内落盘，与慢速行情、视觉、Luna/Terra 完全分离。严格无期权线索、无图片且非回复的普通市场文字由本地规则直接归档为次要语境，不再消耗 Luna/Terra。旧任务每轮每频道最多补做一条且静默更新，不会挤压新消息或在恢复时发送一串重复通知。运行状态每 10 秒写入心跳、真实活跃仓位数、队列、行情 worker 和内存；连续 Telegram 健康检查失败会让进程退出，由唯一的 OceanWaveSupervisor 按持久化限额和指数退避恢复，不再每分钟启动 PowerShell watchdog。

若 OpenClaw/Codex 达到账户额度上限，程序会持久化熔断至供应商给出的恢复时间，不再反复调用或重复报警。期间文字、确定性信号、Schwab/Fidelity 行情和截图原图继续实时保存；视觉与 Luna/Terra 分析保留为待处理。额度恢复后只修复这些已实时捕获的新消息；定时 Sol 日报只处理当天，不自动倒查旧日期。确需补做某天时必须显式运行 `npm.cmd run daily -- --date YYYY-MM-DD`。

Luna 与 Terra 的调用按“消息版本＋重试次数”使用隔离会话，不把整个频道一天的内容反复带回模型；生命周期上下文来自可审计的数据库记录。这样既避免长对话超过上下文导致格式错误，也避免同一历史反复消耗账号额度。Sol 仍只在每日汇总时串联当天的不可变结果。

## QQQ / SPY 日内研究

OceanWaveSupervisor 按 Schwab 官方 market-hours 在开盘前 5 分钟预热，官方日历决定实际开盘、收盘、节假日和提前收盘；官方日历临时不可用时才使用明确标记的固定时段降级。开盘后用一笔 Schwab batch 同步取得 QQQ、SPY、IWM、DIA、TLT、GLD；只有 QQQ/SPY 是预测目标，其余标的只提供相对强弱、risk-on、利率和防御性 regime 语境。QQQ/SPY 的报价时间偏差超过 3 秒或报价年龄超过 15 秒时拒绝该分钟，不拿错时数据训练。Fidelity 只在每个 30 分钟 origin 异步交叉验证，或 Schwab 失败时作为仅标的行情备援，不会拖慢 Schwab 主路径。

每分钟保存一个不可变市场点，并为所有尚未成熟的 30 分钟预测路径结算对应 lead；同日短暂断线只用 Schwab 已完成的一分钟 K 线补齐基线之后的缺口，不会用当前报价冒充过去，也不会对缺口时间反向生成预测。开盘和之后每 30 分钟同时冻结 QQQ、SPY 各一条 lead 1–30 路径，最后一轮不得晚于正式收盘前 30 分钟。0–100 仅为展示分；学习使用 Brier、log-loss、Huber、pinball、区间覆盖、校准误差和 bid/ask 成本压力。盘中每个 lead 只更新 `shadow_only` 校准，生产权重整日冻结。

VWAP、RVOL、5/15 分钟收益、实现波动率和开盘分钟数是六项关键因果字段。任何字段缺失都保持缺失并降低数据完整度，绝不以当前价、0 或 1 伪造；数值预测仍会保存以便事后评分，但结果明确标为 `abstain`、`valid_for_learning=false`。无效交易日同样只评分、不更新 ELO、协方差、上一期权链或校准状态。

频道里经 Luna 验证的明确 QQQ/SPY 未来预测进入独立受限 Node 进程，与期权信号、普通大盘文字和 Ocean Wave 自有预测分开统计；到期或收盘即退出并释放内存。收盘后，C++ 对因果对数收益执行 OLS detrend、Hann taper 和固定 2–5、5–15、15–60、60–120 分钟频带分析。Fourier 只作为小权重 regime/challenger 特征，不做正弦价格外推。随后 `gpt-5.6-sol`、thinking=`high` 比较自有模型与频道预测，并且只能提出 `no_change`、`collect_more_data`、`backtest_candidate` 或 `shadow_candidate`；至少 40 个交易日、每标的 500 个成熟 origin 以及 purged walk-forward、成本压力和 shadow gate 未通过前，不能改生产模型。

## 使用

监听器、模型源码、C++ 核心、测试和文档都位于同一个 `D:\Ocean-Wave` 仓库根目录，不再使用第二层 `ocean-wave` 目录。模型接口见 [docs/model-overview.md](docs/model-overview.md)，点时数据约束见 [docs/data_integration.md](docs/data_integration.md)，最近一次脱敏周度证据见 [docs/weekly_evidence_2026-08-24_2026-08-28.md](docs/weekly_evidence_2026-08-24_2026-08-28.md)。

```text
npm.cmd run doctor
npm.cmd run listen
npm.cmd run intraday
npm.cmd run stop
npm.cmd run daily -- --date YYYY-MM-DD
npm.cmd run position:resolve -- --workflow-id position-raw-123 --exit-price 1.25 --exit-at 2026-09-18T20:00:00Z
npm.cmd run position:resolve -- --workflow-id position-raw-123 --disposition unscored-no-settlement
npm.cmd run maintenance:clean
npm.cmd run database:compact
```

`position:resolve` 只处理已经处于 `awaiting_human_choice` 的精确 `workflow_id`。第一种形式用人工确认的最终退出价格和时间结算剩余仓位；第二种形式明确记录“不评分、不结算”。命令从不可变事件重建开仓成本和按剩余仓位几何递减的所有部分退出，在一个 SQLite 事务中追加 `human_choice_resolved` 与 `completed`，不会改删旧事件、启动 worker 或重启实时进程。完全相同的命令可安全重试；不同的二次结算或其他已终结仓位会被拒绝。

最简单的退出方式是双击项目根目录的 `stop-ocean-wave.cmd`。它不依赖 PowerShell 执行策略，也不要求当前终端位于项目目录。`npm run stop` 是同一个完整安全退出流程，但只能在项目目录中运行；PowerShell 禁止 `npm.ps1` 时可改用 `npm.cmd run stop`。安全退出会先把 Supervisor 标记为停止中并关闭自动恢复，再同时通知 Telegram 监听和 QQQ/SPY 日内研究进程，停止接收新任务，等待已经入队的图片、Luna、Terra、Sol、频道预测与行情处理结束，关闭全部常驻 worker，执行 SQLite WAL checkpoint，关闭数据库并释放防睡眠状态。默认最多等待一小时，绝不会因等待超时而强杀生产数据库进程。可用 `npm.cmd run supervisor:status` 查询统一运行状态。

首次 Telegram 授权使用 `npm.cmd run telegram:login`。登录会话、通知机器人凭据和本机数据凭据由 Windows DPAPI 加密保存在 `.secrets`，不要提交或复制到其他账户。

`maintenance:clean` 和 `database:compact` 默认都只是 dry-run，并在 `outputs/` 生成 JSON 清单。文件清理只有显式追加 `-- --apply` 才处理可重建的视觉派生图、项目 Python bytecode 和停机后的编译中间物。数据库压缩更严格：必须先用完整退出流程让 runtime 明确进入 `stopped`，所有记录 PID 均已退出，并且数据库同名 `-wal`、`-shm` 文件都不存在；否则 `npm.cmd run database:compact -- --apply` 会拒绝执行。apply 不会 checkpoint、直接打开、复制、删除或替换生产 WAL/SHM；监听运行期间的 dry-run 为取得 SQLite 一致性视图，SQLite 自身可能在内部读取已存在的 WAL，但命令不会直接操作或修改 sidecar。它也不会删除任何数据库行、完整期权链、价格证据、原始消息、生命周期、模型反馈或审计关联。唯一转换是把与 `market_snapshots.snapshot_json` 逐字节且 SHA-256 完全相同的旧 Terra 重复输入换成当前 `terra-input-manifest.v1` 引用。

数据库 apply 会先在 `data/db-archives/` 写入原库的 gzip 冷归档、原库和 gzip 的 SHA-256 及解压逐字节校验清单，然后只在同卷临时副本中迁移。临时副本必须通过 `integrity_check`、`foreign_key_check`、全部用户表行数、除 Terra 输入外的内容指纹、Telegram 游标和可恢复仓位集合对账后才原子替换主库；Windows 文件锁导致 rename 失败时保持原库不变，不使用非原子的 copy fallback。若没有符合条件的 Terra 重复输入，apply 记录 `nothing_to_compact` 并直接退出，不建归档、不 VACUUM、不替换数据库。

Codex 桌面程序与 OpenClaw 使用独立的本机凭据库。在 Codex 中切换账号后，运行 `npm.cmd run auth:sync` 将当前账号安全同步到 main、Luna、Terra、Sol；随后受控重启 OpenClaw gateway，再运行一次 `npm.cmd run smoke:openclaw`。只有三个模型都成功时，探针才会解除旧账号留下的额度熔断。脚本不会打印访问令牌；同一账号刷新时也会保留正常的限流状态。

首次安装先运行 `powershell -File scripts/build-supervisor.ps1` 构建并自检透明的 C++ 无窗口宿主，再运行 `powershell -File scripts/install-tasks.ps1`。系统只保留一个登录触发的 `OceanWaveSupervisor` 启动项；它直接执行经过 SHA-256 校验的 `bin/OceanWaveSupervisor.exe`，内部统一管理实时监听、交易时段研究、日报、限定恢复和安全退出，不再用重复计划任务轮询。这个唯一登录启动项必须使用当前交互用户，因为 Telegram/Schwab 凭据受 Windows CurrentUser DPAPI 保护；它只是启动入口，不承担业务调度。运行时不会调用 PowerShell、动态下载、编码命令、提权或隐藏脚本。Supervisor 运行期间由原生宿主阻止 Windows 自动睡眠，但不会阻止手动关机、网络中断或账户登出；Windows 注销/关机通知会先请求完整排空。突然断电仍由 SQLite WAL、`synchronous=FULL`、幂等事件和下次启动的游标恢复保护。

## 行情与模型安全

实时行情以 Schwab 为主源；Fidelity 在后台并行校验标的价格，并在 Schwab 暂时失败时作为标的行情备援。Fidelity 后台服务不共享 Chrome 登录 Cookie，因此备援结果明确标为“仅标的”，不能替代期权 bid/ask、Greeks 或完整期权链。

行情进程通过有界的逐行 JSON 管道接收短期 Schwab token，令牌不出现在命令行。进程缓存最多 32 个标的并在 100 次请求后由监督器平滑回收；不再每 10 次请求强制全量 GC。在线 ELO 状态采用量化距离键并清除过期网格，避免行情变化造成内存无限增长。模型与上一期权链状态写入同一个原子 `SYMBOL.state.json` 代际文件，并兼容首次读取旧的 `model.json + chain.json`；Windows 杀毒/索引器短暂锁文件时采用有限指数退避。退出时会等待异步模型检查点写完，再关闭 worker 和数据库。

每笔已验证仓位的学习结果只更新持久化的 `shadow-calibration.v1`：截距、斜率和单次因子信用都有硬边界，工作流 ID 防止同一结果重复学习。未来预测会同时记录原始概率与影子校准概率，校准只能把置信度向 0.5 收缩，不能制造更强观点；正式概率和生产因子权重保持不变。影子校准与日内晋级门禁统一要求至少 40 个完整有效交易日和每标的 500 个成熟预测，且样本外回测、成本压力测试和 shadow gate 全部通过后，Sol 才能提出可审查的晋级候选。

`signal_published_at` 只记录 Telegram 喊单时间，`observed_at`/`as_of` 来自数据源的真实报价时间，`captured_at` 是本机完成抓取的时间。三者分开保存，任何超过允许时差的快照都会 abstain；若实时授权尚未就绪，记录会明确标为 `text_only`，绝不把当前报价冒充消息当时的历史价格。

OpenClaw 提示词通过权限受限的临时文件传递，不出现在进程命令行；DPAPI 和防睡眠逻辑位于可审计的固定脚本中。`npm run check` 会同时检查所有 JavaScript 语法、关键安全约束和完整测试集。

Ocean Wave 候选模型必须使用点时输入、可成交 bid/ask、交易成本、purged walk-forward、校准和 shadow run。频道自报止盈或胜率只能作为辅助证据，不能替代独立结果标签。
