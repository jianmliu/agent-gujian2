# agent-gujian2 —《古剑奇谭二：永夜初晗凝碧天》无头评测宿主与双端确定性引擎

`agent-gujian2` 是基于 `/Volumes/T7-Data/pal/Open-Gujian2` 构建的**零 DOM / 零 WebGL 确定性内核 + Stdin/Stdout JSON-Lines 智能体无头评测宿主**。同一套核心引擎 [`Open-Gujian2/js/engine_core.js`](../Open-Gujian2/js/engine_core.js) 同时驱动：
1. **Node.js 无头高速评测宿主**（`20,000+ ~ 2,000,000+ FPS` 锁步运行、0.2ms 内存快照回滚、`normal` / `pure` 双模式防作弊评测）；
2. **Three.js 3D 开放世界浏览器端**（`Open-Gujian2/index.html` + `js/main.js`，暴露 `window.Gujian2Engine` 与 `P` 键 **🤖 AI 自动巡航**）。

---

## 核心特性

1. **真实地形与建筑 OBB 物理碰撞 (`WorldPhysics`)**：
   - 直接加载 `assets/world.meta.json`、`assets/world.heights.bin`（`2000 × 2050` Uint16 真实高度图，覆盖 `4000m × 4100m` 九大区域）与 `assets/props/index.json`（252 个 Vision Engine `.vmesh` 原版建筑与桥梁）。
   - 双线性插值计算精确地形高度 `terrainHeightAt(x, z)` 与坡度 `slopeAt(x, z)`，陡坡悬崖（`slope > 0.68`）阻挡移动并返回 `move_blocked_by_cliff`。
   - 空间网格索引（Spatial Grid）支持聚落建筑 2D OBB 碰撞阻挡（`move_blocked_by_prop`）与桥梁桥面高度抬升（`bridgeHeightAt(x, z)`）。
2. **《古剑奇谭二：永夜初晗凝碧天》九域七章完整主线 (`quest_stage 100 -> 1000`)**：
   - **四大可操控主角**：`101` 乐无异（腾蛇 / 金刚力士）、`102` 闻人羽（天狼 / 流光）、`103` 夏夷则（太阴 / 太极）、`104` 阿阮（鸾鸟 / 山鬼）。
   - **剧情 NPC 与 Boss**：`105` 华月、`106` 谢衣 / 初七、`107` 沈夜（紫微大祭司）。
   - **七章主线战役**：
     1. 第一章·长安偃术试炼（`n04` 沧澜山脉/定国公府，`100 -> 200`）
     2. 第二章·江陵古墓与百草天罡（`n01p1` 望仙台，`200 -> 300`）
     3. 第三章·太华山与青萝谷寻仙（`n01p2` 青萝谷 & `n08` 镜湖秘境，`300 -> 450`）
     4. 第四章·静水湖谢衣居与桃源仙居（`n12p3` 禾风平原，`450 -> 600`）
     5. 第五章·赤岩捐毒遗迹（`q04b` 赤岩荒原，迎战【沙海巨型偃甲·金刚力士】，`600 -> 750`）
     6. 第六章·雾隐巫山与落霞神女墓（`n10` 雾隐林 & `q07` 落霞坡，重铸昭明神剑、迎战【流月城廉贞祭司·华月】，`750 -> 880`）
     7. 终章·断霄流月城寂静之间（`q08` 断霄岭/流月城之巅，决战【紫微大祭司·沈夜】，`880 -> 1000`，`game_cleared = true`）
3. **4 人小队即时动作战斗 + 星蕴定式 + 偃甲工坊 + 桃源仙居**：
   - 支持 `switch_leader`（1-4 切换主控）、轻攻击三连击（Combo 1-2-3）、重攻击破盾（`heavy`）、闪避翻滚（`dodge`，赋予 `0.45s` 无敌帧 `iframe` 规避 Boss 红圈 AOE）、格挡反击（`guard`）、四主角星蕴终结技（`ultimate`）与阿阮 AI 自动【春风化雨】群体治疗。

---

## 🏆 Pure 模式（零先验盲测）全剧情通关排行榜 (100% All-Story Completion Leaderboard)

在严格的 **`pure` 模式（零先验 / 防作弊盲测）** 下，隐藏内部 `quest_stage` 与 `diagnostics`，要求智能体必须通过 `move_to` 走到交互点 `35m` 范围内才能执行 `interact`、`solve_mechanism` 或 `trigger_echo`，每轮最多允许执行 2 个动作指令，禁止编写外部自动化脚本，并完成**100% 全剧情全要素收集**：
- **7/7 主线章节全通关**（`game_cleared = true`）
- **13/13 原版主线剧目全触发**（共 **64/64 句**原版主线与忆念剧本台词）
- **7/7 多分支道心抉择全完成**（`branch_ch1_departure` .. `branch_ch7_final_stand`）
- **9/9 九域【星海忆念】支线全收集**（`echo_n04_chanji` .. `echo_q08_shenxi`）
- **9/9 九域开放世界全探索**（`n04`、`n01p1`、`n01p2`、`n08`、`n12p3`、`q04b`、`n10`、`q07`、`q08`）
- **4/4 主角全员 Lv.60 + 4/4 星蕴终结技 + 3/3 偃甲合成 + 桃源仙居全操作 + 3/3 Boss 战全胜**

| 排名 | 模型 (`Model`) | 模式 | 主线剧目 (`STORY_SCRIPTS`) | 分支抉择 (`STORY_BRANCHES`) | 星海忆念 (`SIDE_ECHOES`) | 九域探索 | 四主角 & 偃甲 & Boss | 工具步数 (`toolCalls`) | 推理轮数 (`calls/turn`) | 耗时 | 重放核验 (`SHA-256`) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 🥇 **#1** | `agy-cli:gemini-4-argon-medium` | `pure` | **13 / 13** (64 句) | **7 / 7** | **9 / 9** | **9 / 9** | 4主 Lv.60 · 偃甲 3/3 · 胜场 3/3 | **64 步** | 38 轮 (`1.68`/轮) | 278.6s | `✓ VERIFIED` (`c89472df8954`) |
| 🥈 **#2** | `agy-cli:claude-opus-5-5-high` | `pure` | **13 / 13** (64 句) | **7 / 7** | **9 / 9** | **9 / 9** | 4主 Lv.60 · 偃甲 3/3 · 胜场 3/3 | **100 步** | 59 轮 (`1.69`/轮) | 259.5s | `✓ VERIFIED` (`443a203e1aa5`) |

---

## 快速运行

```bash
# 1. 运行 15 步全流程无头基准测试（同时验证 normal 与 pure 盲测模式）
npm test

# 2. 启动 pure 模式全剧情智能体闯关评测
npm run bench:run -- --model claude-opus-5-5-high

# 3. 对 bench/out/* 所有轨迹执行 SHA-256 确定性逐步重放核验
npm run bench:verify

# 4. 生成全剧情通关排行榜与 Web 交互式回放器 (web/board.html & web/replay.html)
npm run bench:board

# 5. 启动 JSON-Lines 交互式无头宿主
npm run host
npm run host:pure
```

## 双人共享世界原型

在同一片古剑二地形中独立移动、互相可见，通过接触共享怪物触发一场原有规则驱动的战斗。服务器可从 SQLite 检查点恢复待决战斗。启动命令与双浏览器验收见 [共享世界原型](docs/shared-world-prototype.md)。
