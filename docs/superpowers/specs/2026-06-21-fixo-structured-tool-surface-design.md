# Fixo 结构化工具面 — 设计 (Structured Tool Surface)

- Date: 2026-06-21
- Status: Design / awaiting review
- Continues branch: `spinsirr/fixo-public-api` (Phase A) → new branch `spinsirr/fixo-mcp-tools`

## 一句话

把 Fixo 的诊断 + 估价大脑暴露成一组**结构化工具**(走 MCP),让客户用**自己的 agent**
来调。每次诊断发一个票号(= `prediction_id`),修完凭票号回填真实结果,数据闭环越攒越 准 ——
这才是护城河。HMLS 自己的 agent 当第一个客户来 dogfood。

## 背景 / 为什么这么做

- 客户(别的修理店 + HMLS 自己)大多**已经有自己的 agent**。给他们"再跟我们的聊天机器
  人多轮对话"很别扭 —— 两个 agent 互聊有损、还得管会话状态、解析自由文本。他们要的是能被 自己 agent
  调的**工具**。
- 护城河是**数据**(跨店 `预测 → 确认诊断 → 实际花费` 真值),**不是**诊断逻辑本身(可
  复制)。所以设计目标 = 让数据捕获(预测 + 结果)顺畅,而不是藏推理。极端点说,以后甚至
  可以放开诊断逻辑去驱动 adoption(更多店用 → 更多结果 → 护城河更深)。
- 现状:`/v1/diagnose` 已上线(一锤子、纯文字、key-gated,`api.fixo.ink`)。canary 验证大
  脑诊断专家级,但 `estimate` 经常为空 —— 对话 agent 想追问、却没有第二轮。本设计正解这个
  缝,并把整个面做成工具。

## 模型

```
车主  ⇄(聊症状)  修理店的 AI(客户自带)  ⇄(调用)  Fixo 诊断大脑
                                                        │
① 诊断来回几轮,Fixo 记着进度、发一个票号                  │
② 修完凭票号回填实际结果 → Fixo 攒「预测 vs 实际」→ 越来越准 = 护城河
```

ChatGPT / FIXD 永远不知道自己猜对没 —— 拿不到这个闭环,只有修车端能。

## 工具(3 个,MCP)

1. **`diagnose(ticket?, vehicle?, symptom?, observations?, dtcs?)`** →
   `{ ticket, state, questions[], to_confirm[], diagnosis?, ready_to_estimate }`
   - 没 `ticket` = 新开一轮(铸 `ticket`);带 `ticket` = 喂新信息推进状态机。
   - 客户 agent 循环调它,直到 `diagnosis` 出来 / `ready_to_estimate === true`。
   - `questions[]` = Fixo 想让客户向车主确认的问题;`to_confirm[]` = 现场要确认的点。
2. **`estimate(ticket)`** → `{ line_items[], labor_hours, parts[], total_range, assumptions[] }`
   - 用现成 OLP 引擎定价([pricing.ts](../../../apps/agent/src/hmls/skills/estimate/pricing.ts)); 把
     `predicted_estimate` 记到票号上。
   - `assumptions[]` 显式列出"基于哪些假设报的价",这样不用追问也能给数字。
3. **`record_outcome(ticket, confirmed_diagnosis, actual_cost_cents?)`** → `{ ok }`
   - 闭环。修完后客户回填真实结果。喂数据飞轮。

## 诊断怎么吐结构化(选定方案)

**复用现有 Fixo agent + `diagnostic_state` 状态机**(已验证的 5/5 大脑)。它本来就用 `isolate_systems`
/ `plan_pinpoint_tests` / `update_diagnostic_state` 维护**结构化**的 `diagnostic_state`。`diagnose`
= 给定到目前为止的 state,跑一步,返回结构化 state + agent 的追问。自由文本退化成 `questions` /
`narrative` 字段。

- **不选**每步 `generateObject`:会丢掉 agent 的工具使用(OLP 查询、规则层)和已验证的推理 质量。

`skill` 是转移逻辑(怎么从一态走到下一态),状态另存 —— 两者不矛盾。

## 票号 + 状态

- `ticket` = `prediction_id`(`pred_<uuid>`,已有)。
- 进行中的 `diagnostic_state` 存**服务端**,挂在 `fixo_predictions` 行上(加一个 jsonb
  `diagnostic_state` 列)。客户只攥 `ticket` 这个小句柄 —— 这是"Fixo 持状态、客户攥 token"
  的方案(护城河 + 对客户最省事)。
- 复用现有 `fixo_predictions` 表 + 闭环;扒掉消费端的 credits / Supabase-auth,换 API-key。

## MCP server + 鉴权

- `@modelcontextprotocol/sdk` 的 Streamable HTTP server,挂在
  [fixo-app.ts](../../../apps/gateway/src/fixo-app.ts)(gateway),暴露上面 3 个工具。
- key-gated:复用现有 `fixo_api_keys` + api-key 中间件
  ([api-key.ts](../../../apps/gateway/src/middleware/fixo/api-key.ts))。
- **限流**:内部 dogfood 不需要;**对外发 key 之前必须加**(硬门)。本期不做。

## 数据闭环(护城河)

- 预测:`diagnose` 开票即记;`estimate` 记 `predicted_estimate`。
- 结果:`record_outcome` 回填。
- v1 直接复用 Phase 0 的 loop:HMLS 完工填 `confirmed_diagnosis` → `record_outcome`。

## v1 范围(HMLS dogfood)

**做:**

- MCP server + 3 个工具。
- `diagnose` 复用 agent / `diagnostic_state`,结构化输出。
- `fixo_predictions` 加 `diagnostic_state` 列(手写迁移,沿用本仓库手写迁移惯例)。
- HMLS 的 agent 当 **MCP 客户端**调 `diagnose` / `estimate`(替掉现在 `create_order` 里那个 浅的
  in-process `BrainService.diagnose`),票号落到 order;完工 → `record_outcome` 走 MCP。

**明确不做(后续):**

- 结构化 REST 镜像(YAGNI,等真有非-MCP 消费者)。
- 限流 / 计量 / 对外发 key(对外阶段)。
- 把诊断 skill 发给客户自己跑(adoption 阶段再说)。
- 给非-HMLS 的店接入。

`/v1/diagnose`(现有 REST 一锤子)暂留不动、不扩展;MCP 是 v1 的面。

## 风险 / 待定

- **HMLS agent 从 in-process 改成 MCP 客户端** = 同一个 deploy 自己 HTTP 调自己(dogfood 真
  实外部路径,可接受;若延迟/成本敏感,保留 in-process fallback)。
- **`diagnostic_state` 的形状**够不够喂状态机重启一轮 —— 实现时确认(现在它是在一个活 agent session
  里被增量更新的;无状态 API 每次要从存下的 state 复原)。
- **结构化 schema 的字段**最终定版,放进实现 plan(`diagnose` / `estimate` 的返回字段)。

## 非目标

- 不暴露**对话 agent** 作为开发者接口。
- 不做支付;不碰消费端 `fixo.ink` 的 session / credit 逻辑。
