# cr-2day-audit：两日改动复审（2026-11-15）

> 范围：12cb32e..7c7b400（22 笔提交，61 文件 +4308/-121）。两路独立审阅者分域对抗审查
> + 主会话全量 gate（CR2D）与证据链体检（67 条被引日志全部 exit_code=0 且入库）。

## 审阅结论与处置

**必须修 3 → 全修**：
1. close 失败路径谎报"已还原"且磁盘残留 bootstrap 态（0374794 实证）→ 完整快照回写
   （prevState 深拷贝，失败 writeAtomic 落盘），§52 断言同步
2. .ai/writes.json 未提交手改（coder.writes→../TDasset×2，越出仓库根）→ git checkout
   还原；要让 coder 写旁挂仓须改 agents 源→build（正路未走，属后续决策）
3. doctor 剖面 B 矛盾输出（projectKey 空时同屏"未接入"!与"空间 ✓"）→ ✓ 行加非空条件

**值得考虑 5 → 全修（快）**：
4. init 净化补 iteration.field（field_a7de08 纯空间事实随包外泄面）
5. transitionStatus 文本兜底正则转义（状态名含元字符静默失配）；readStatusViaMql
   加 workItemType 透传 + id 纯数字校验（注入面本已关死，改显式拒绝）
6. 安装器：mv -n 防同日覆盖封存件 + mv 失败如实报；非 ASCII 目录 hash 兜底（防 default 互覆）
7. 本仓删 stacks 死键（projects 唯一栈源，死配置无告警问题随之消失）；build:agents 重生成
8. .gitignore 补 .ai/task-loop/、timer 软链、tdasset-*.md；FS 文档工具表同步
   （update_field→transition_state）；retro 补 0374794 勘误

**表态不改（记录在案）**：
- severity.field=priority 随包（内置通用字段，各空间同 key，无害）
- 证据复用（DFG×4 等一次真跑证多条 TODO）——可接受，--task 归属头只记一个任务
- 手动 --once 刷节流戳顺延定时器——改判语义成本大于收益

## 验证

AUD1 五套件联跑全绿（cli 252/0 含 close 真还原断言）；close 自收尾 gate 全量绿。
