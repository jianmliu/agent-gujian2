# 多怪物与并行遭遇实施计划

> 按用户明确授权，在当前隔离分支实施整批功能，统一验收后开 PR，不合并 main。

**目标**：两名玩家可独立与两只怪交战，所有待决场次可原子恢复且各结算一次。
**架构**：v4 集合状态，固定怪物目录，UUID 战斗身份，独立玩家原生上下文，世界步内整体 CAS。
**技术**：Node22、SQLite、现有 Three.js、Playwright。

- [x] 1. 保存设计并验证基线。`node --test test/shared-battle-clock.test.mjs test/shared-world-continuous.test.mjs` 应15项通过。
- [x] 2. 先写 `test/shared-world-parallel.test.mjs`，测试 `view.monsters` 的两个实例、同 tick 唯一占用、两场不同 UUID、私有目标隔离、重启不改变 clock 和 ID、先后单次结算。旧实现应因无 monsters 失败。
- [x] 3. 新建 `src/shared-encounters.js` 集中定义位置、集合不变量与迁移。修改 `src/shared-world.js` 初始化/读取/接触/动作/逐步推进/原子迁移，保持旧摘要以接受旧档。升级现有测试的集合断言，旧档夹具明确转回单例格式。
- [x] 4. 修改 `web/shared-world-client.js` 和 `web/shared-world-3d.js` 遍历公开 monsters，分别显示和隐藏每只怪，面板标明私有战斗目标。网络请求仍使用私有 battle.id。
- [x] 5. 扩展 `test/shared-world-browser.test.mjs` 两个入口的实玩路线，保持原移动/断线/时钟覆盖，增加第二场、独立目标、双场 SIGKILL 与各一次结算。增加迁移、损坏关联和同时攻击失败回滚测试。
- [x] 6. `npm run test:shared` 与 `npm test` 统一验收；独立代码复核，修复有效发现后重新验证受影响范围。日志和截图写入本机批次目录。更新 `docs/shared-world-prototype.md` 与计划状态。
- [x] 7. 提交当前分支、创建并附加 PR，确认 OPEN 且未合并，报告测试和实际边界。

已提交 [PR #5](https://github.com/jianmliu/agent-gujian2/pull/5)，保持未合并。统一验收共享 35/35，normal/pure 各15/15。
