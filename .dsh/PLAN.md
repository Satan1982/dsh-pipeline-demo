# issue #62：Add excerpt helper (post-fix end-to-end)

这份文件由调度器按 issue 生成，是本次任务的唯一验收清单。

## 目标
在 src/text.js 新增 excerpt(text, n)：返回前 n 个字符，超出时末尾加 "…"；n <= 0 时返回空串。

## 验收标准
- excerpt("abcdef", 3) === "abc…"
- excerpt("ab", 5) === "ab"
- excerpt("abcdef", 0) === ""
- 在 src/text.test.js 补断言并 bash scripts/verify.sh --bless

## 验收命令（调度器会自己跑一遍，必须 exit 0）
```
```bash
node --input-type=module -e "
import { excerpt } from './src/text.js';
const ok = excerpt('abcdef',3)==='abc…' && excerpt('ab',5)==='ab' && excerpt('abcdef',0)==='';
console.log(ok ? 'VERDICT: PASS' : 'VERDICT: FAIL excerpt');
process.exit(ok?0:1);
"
```
```

## 约束
- 只改 src/text.js 与 src/text.test.js 及两个基线文件

## 硬性红线（pre-commit 钩子会挡）
- 不许删/改已有测试与断言来凑绿；基线必须 `bash scripts/verify.sh --bless` 同步。
- 不许改 `.github/workflows/`、`scripts/verify.sh`、`scripts/assert-guard.mjs`、`ci/*`（需要时在 issue 打 `allow:gate`）。
- 不许留调试占位符、断点语句、只跑单个用例的标记或调试日志（评审层会逐条列出具体行）。
- 不许加依赖；一 PR 一个垂直切片。
