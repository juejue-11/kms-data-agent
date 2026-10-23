# PCB 业务效果评测

评测数据是脱敏的合成标注草案，覆盖口语别名、相似缺陷、矛盾参数、多轮追问、无命中、网络冲突和上下文压缩。评分器把检索命中与最终判定分开计算：最终判定还分别检查缺陷结论、关键判据、追问和应拒绝下结论的场景。

运行器只读取 JSON，不读取环境变量，也不发起网络请求。没有 `--results` 时输出缺少实际结果的描述性基线；这只用于检查评分器和数据管线，不代表真实模型质量。发布阈值必须在真实标注运行后另行确定。

```powershell
node test/evals/run.ts --results test/fixtures/pcb-evaluation-results.example.json --pretty
node test/terminology-chaos.mjs --results test/fixtures/pcb-evaluation-results.example.json --pretty
```

实际运行结果至少包含 `caseId`，并可提供如下结构：

```json
{
  "caseId": "alias-solder-mask-pad-exposure",
  "retrieval": {
    "status": "ok",
    "hits": [{ "evidenceId": "ev_alias_solder_mask", "label": "solder-mask-exposure" }]
  },
  "answer": {
    "predictedDefect": "solder-mask-exposure",
    "criteria": ["pad copper is exposed"],
    "followUpQuestions": [],
    "asked": false,
    "refused": false
  }
}
```

评分器不会因为回答正文包含某个术语就判定通过；需要运行适配器提供结构化的结论、判据和追问字段。正文可以作为 `answer.text` 保留供诊断。

`pcb-evaluation-results.example.json` 顶层带有 `sample: true`，因此示例报告会标记为合成自检样例。没有 `--results` 时 `baseline.measured` 为 `false`；提供实际对应结果后才会变为 `true`。这些脱敏合成草案须经专业人员审核并完成真实标注测量，才能讨论发布阈值，示例成绩不代表真实模型质量基线。

The fixtures are synthetic, sanitised drafts for exercising the scorer. They are not human-labelled production standards; a domain review and representative real annotation run are required before using any report as a release baseline.

