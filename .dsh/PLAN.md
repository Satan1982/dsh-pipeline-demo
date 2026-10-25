# issue #60：Add words and wordCount helpers (unattended end-to-end)

这份文件由调度器按 issue 生成，是本次任务的唯一验收清单。

## 目标
在 src/text.js 里新增 words(text) 与 wordCount(text)：按空白切分文本，忽略空串，返回词数组 / 词数。

## 验收标准
- words("a b  c") 等于 ["a","b","c"]
- words("") 等于 []
- wordCount("a b c") === 3
- 在 src/text.test.js 里补对应断言，并用 bash scripts/verify.sh --bless 同步两个基线

## 验收命令（调度器会自己跑一遍，必须 exit 0）
```
```bash
node --input-type=module -e "
import { words, wordCount } from './src/text.js';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
if(!eq(words('a b  c'),['a','b','c'])){console.log('VERDICT: FAIL words');process.exit(1);}
if(!eq(words(''),[])){console.log('VERDICT: FAIL empty');process.exit(1);}
if(wordCount('a b c')!==3){console.log('VERDICT: FAIL count');process.exit(1);}
console.log('VERDICT: PASS');
"
```
```

## 约束
- 只改 src/text.js 与 src/text.test.js（外加两个基线文件）
- 不改 ci/、scripts/verify.sh、.github/

## 硬性红线（pre-commit 钩子会挡）
- 不许删/改已有测试与断言来凑绿；基线必须 `bash scripts/verify.sh --bless` 同步。
- 不许改 `.github/workflows/`、`scripts/verify.sh`、`scripts/assert-guard.mjs`、`ci/*`（需要时在 issue 打 `allow:gate`）。
- 不许留调试占位符、断点语句、只跑单个用例的标记或调试日志（评审层会逐条列出具体行）。
- 不许加依赖；一 PR 一个垂直切片。
