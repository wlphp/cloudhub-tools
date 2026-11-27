// 精选公开与原创固定评测题集。原始英文题干作为跨账号统一评测输入，不随界面语言改写。
// IFEval: Google Research Authors, Apache-2.0. LiveBench: Apache-2.0 / MIT.
// SimpleBench: Copyright (c) 2024 simple-bench, MIT.
import { CODEX_PELICAN_DEFAULT_PROMPT } from "../../platform/clients/codex-pelican";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type BenchmarkRule =
  | { kind: "json" | "noComma" }
  | { kind: "bullets" | "placeholders"; count: number }
  | { kind: "choice" | "boldInteger"; answer: string }
  | { kind: "solution"; answers: readonly string[] }
  | { kind: "jsonFields"; fields: readonly { name: string; value: JsonValue }[] };

export interface ScoredBenchmark {
  id: string;
  suite: "IFEval" | "SimpleBench" | "LiveBench" | "Cockpit";
  label: string;
  sourceId: string;
  sourceUrl: string;
  release: string;
  graderVersion: "cockpit-strict-v1" | "cockpit-exact-v2";
  reference?: string;
  prompt: string;
  rules: readonly BenchmarkRule[];
}

export interface PelicanModelPreset {
  id: string;
  name: string;
  model: string;
  defaultEffort: string;
}

export const DEFAULT_MODEL_PRESETS: readonly PelicanModelPreset[] = [
  { id: "preset-gpt-6-1-sol", name: "GPT-6.1 Sol", model: "gpt-6.1-sol", defaultEffort: "medium" },
  { id: "preset-gpt-6-astra", name: "GPT-6 Astra", model: "gpt-6-astra", defaultEffort: "medium" },
  { id: "preset-gpt-6-1-terra", name: "GPT-6.1 Terra", model: "gpt-6.1-terra", defaultEffort: "medium" },
  { id: "preset-gpt-6-sol", name: "GPT-6 Sol", model: "gpt-6-sol", defaultEffort: "medium" },
  { id: "preset-gpt-6-luna", name: "GPT-6 Luna", model: "gpt-6-luna", defaultEffort: "medium" },
  { id: "preset-gpt-5-6-sol", name: "GPT-5.6 Sol", model: "gpt-5.6-sol", defaultEffort: "medium" },
  { id: "preset-gpt-5-6-terra", name: "GPT-5.6 Terra", model: "gpt-5.6-terra", defaultEffort: "medium" },
  { id: "preset-gpt-5-6-luna", name: "GPT-5.6 Luna", model: "gpt-5.6-luna", defaultEffort: "medium" },
  { id: "preset-gpt-6-2-sol", name: "GPT-6.2 Sol", model: "gpt-6.2-sol", defaultEffort: "medium" },
  { id: "preset-gpt-6-2-astra", name: "GPT-6.2 Astra", model: "gpt-6.2-astra", defaultEffort: "medium" },
];

export const REASONING_EFFORTS: readonly { value: string; label: string }[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "最大" },
  { value: "ultra", label: "极致" },
];

export const CANDY_REASONING_PROMPT = `不要搜索资料，自己思考：

袋子里有三种口味的糖——苹果、桃子、西瓜。每种口味又有两种形状：圆形和五角星。摸糖的时候，形状靠手感就能分辨，但不能分辨口味。

不同口味和形状的数量如下：
形状 | 苹果 | 桃子 | 西瓜
圆形 | 7 | 9 | 8
五角星 | 7 | 6 | 4

问题是：最少取多少颗，能保证手里同时有一组「圆形苹果 + 五角星桃子」或者「五角星苹果 + 圆形桃子」？

允许按形状选择拿取，每颗取出后不放回，不能根据口味挑选，也不能在取出后获知口味。请给出最少数量、保证成功的取法，以及更少数量不能保证成功的理由。用纯文本回答，不要生成 HTML。`;

export const CANDY_REFERENCE = "21 颗：先取 12 颗五角星，再取 9 颗圆形。五角星必含苹果和桃子，圆形必含苹果或桃子。20 颗不能保证。可选形状、不可选口味。";

interface LedgerRecord {
  eventId: string;
  project: string;
  period: string;
  invoice: string;
  revision: number;
  state: "posted" | "void";
  amountCents: number;
}

const TARGET_UPDATES: readonly (readonly [string, string, number, LedgerRecord["state"], number])[] = [
  ["T01", "A101", 1, "posted", 12050], ["T03", "A101", 3, "void", 0],
  ["T05", "A102", 2, "posted", 8100], ["T06", "A103", 1, "posted", 30000],
  ["T09", "A104", 1, "posted", 1999], ["T12", "A105", 2, "void", 0],
  ["T15", "A106", 3, "posted", 9999], ["T16", "A107", 1, "posted", 2500],
  ["T18", "A108", 2, "posted", 7500], ["T07", "A103", 2, "void", 0],
  ["T02", "A101", 2, "posted", 12990], ["T04", "A102", 1, "posted", 8400],
  ["T08", "A103", 3, "posted", 29025], ["T10", "A104", 2, "posted", 2199],
  ["T11", "A105", 1, "posted", 45000], ["T13", "A106", 1, "posted", 10000],
  ["T14", "A106", 2, "posted", 10555], ["T17", "A108", 1, "posted", 7000],
];

const TARGET_EVENTS: readonly LedgerRecord[] = TARGET_UPDATES.map(([eventId, invoice, revision, state, amountCents]) => ({
  eventId, project: "ORBIT", period: "2026-09", invoice, revision, state, amountCents,
}));

function buildContextLedgerRecords(): readonly LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (let index = 0; index < 240; index++) {
    records.push({
      eventId: `N${String(index + 1).padStart(4, "0")}`,
      project: index % 3 === 0 ? "ORBIT" : index % 3 === 1 ? "ORBIT-ARCHIVE" : "LYRA",
      period: index % 3 === 0 ? "2026-08" : "2026-09",
      invoice: `A${101 + (index % 8)}`,
      revision: 10 + Math.floor(index / 8),
      state: index % 7 === 0 ? "void" : "posted",
      amountCents: index % 7 === 0 ? 0 : 1100 + ((index * 733) % 48000),
    });
    if (index % 13 === 6) {
      const target = TARGET_EVENTS[Math.floor(index / 13)];
      if (target) records.push({ ...target });
    }
    if (index === 199 || index === 219 || index === 239) {
      records.push({ ...TARGET_EVENTS[index === 199 ? 0 : index === 219 ? 3 : 14] });
    }
  }
  return records;
}

const CONTEXT_LEDGER_PROMPT = `Reconcile the event ledger below. This is a data-processing problem, not a request to execute code.
Each line between BEGIN_LEDGER and END_LEDGER is one JSON record.
1. Keep only records whose project is exactly ORBIT and period is exactly 2026-09. Similar names and other periods are different scopes.
2. Deduplicate these records by eventId. Repeated eventIds have identical data and count only once.
3. For each invoice in that scope, use only the record with the greatest integer revision, regardless of input order. Distinct events for one invoice have distinct revisions.
4. A latest state of void removes the invoice completely. A later posted revision restores it. A void amount is zero; it is not a negative transaction. Earlier amounts are replaced, not summed.
Return only one strict JSON object, without Markdown or commentary, with exactly these keys:
- uniqueTargetEvents: number of distinct target-scope eventIds before revision selection (an integer).
- activeInvoiceCount: number of invoices whose latest state is posted (an integer).
- totalCents: sum of the latest posted amounts, in integer cents.
- largestInvoiceId: invoice ID with the greatest latest posted amount; break a tie by lexicographically smallest ID.
- activeInvoiceIds: all active invoice IDs in ascending lexicographic order (an array of strings).
BEGIN_LEDGER
${buildContextLedgerRecords().map(record => JSON.stringify(record)).join("\n")}
END_LEDGER`;

const CODE_TRACE_SOURCE = `const source = [2, , 0, 5];
const alias = source;
const copy = source.slice();
alias[1] = 3;
delete source[3];
let calls = 0;
const mapped = source.map((value, index) => { calls++; return (value ?? 9) + index; });
const functions = [];
for (let i = 0; i < 3; i++) functions.push(() => i);
function settle() { try { return 7; } finally { return 11; } }
console.log(JSON.stringify({source, copy, mapped, keys: Object.keys(mapped),
  calls, closures: functions.map(fn => fn()), settled: settle()}));`;

export const LEGACY_BENCHMARKS: readonly ScoredBenchmark[] = [
  {
    id: "ifeval1075", suite: "IFEval", label: "JSON 输出", sourceId: "1075",
    sourceUrl: "https://github.com/google-research/google-research/blob/26d8ccdab6fec61b5c83ad6327ea8bda9e580288/instruction_following_eval/data/input_data.jsonl",
    release: "2024-06-11", graderVersion: "cockpit-strict-v1",
    prompt: "Can you help me make an advertisement for a new product? It's a diaper that's designed to be more comfortable for babies and I want the entire output in JSON format.",
    rules: [{ kind: "json" }],
  },
  {
    id: "ifeval102", suite: "IFEval", label: "列表约束", sourceId: "102",
    sourceUrl: "https://github.com/google-research/google-research/blob/26d8ccdab6fec61b5c83ad6327ea8bda9e580288/instruction_following_eval/data/input_data.jsonl",
    release: "2024-06-11", graderVersion: "cockpit-strict-v1",
    prompt: "Write a dialogue between two people, one is dressed up in a ball gown and the other is dressed down in sweats. The two are going to a nightly event. Your answer must contain exactly 3 bullet points in the markdown format (use \"* \" to indicate each bullet) such as:\n* This is the first point.\n* This is the second point.",
    rules: [{ kind: "bullets", count: 3 }],
  },
  {
    id: "ifeval1005", suite: "IFEval", label: "占位符", sourceId: "1005",
    sourceUrl: "https://github.com/google-research/google-research/blob/26d8ccdab6fec61b5c83ad6327ea8bda9e580288/instruction_following_eval/data/input_data.jsonl",
    release: "2024-06-11", graderVersion: "cockpit-strict-v1",
    prompt: "Write a resume for a fresh high school graduate who is seeking their first job. Make sure to include at least 12 placeholder represented by square brackets, such as [address], [name].",
    rules: [{ kind: "placeholders", count: 12 }],
  },
  {
    id: "ifeval1001", suite: "IFEval", label: "禁用逗号", sourceId: "1001",
    sourceUrl: "https://github.com/google-research/google-research/blob/26d8ccdab6fec61b5c83ad6327ea8bda9e580288/instruction_following_eval/data/input_data.jsonl",
    release: "2024-06-11", graderVersion: "cockpit-strict-v1",
    prompt: "I am planning a trip to Japan, and I would like thee to write an itinerary for my journey in a Shakespearean style. You are not allowed to use any commas in your response.",
    rules: [{ kind: "noComma" }],
  },
  {
    id: "simple1", suite: "SimpleBench", label: "常识·冰块融化", sourceId: "1",
    sourceUrl: "https://github.com/simple-bench/SimpleBench/blob/fbc2e429085bdedad7d1a236d2bc9bc18c95f16e/simple_bench_public.json",
    release: "public-2024-12-20", graderVersion: "cockpit-strict-v1",
    prompt: "Beth places four whole ice cubes in a frying pan at the start of the first minute, then five at the start of the second minute and some more at the start of the third minute, but none in the fourth minute. If the average number of ice cubes per minute placed in the pan while it was frying a crispy egg was five, how many whole ice cubes can be found in the pan at the end of the third minute?\nA. 30\nB. 0\nC. 20\nD. 10\nE. 11\nF. 5\n\nYou may explain briefly. End your response with exactly one final line: Answer: X\nReplace X with one option letter A, B, C, D, E, or F. Do not list multiple final answers.",
    rules: [{ kind: "choice", answer: "B" }],
  },
  {
    id: "simple2", suite: "SimpleBench", label: "常识·运动时序", sourceId: "2",
    sourceUrl: "https://github.com/simple-bench/SimpleBench/blob/fbc2e429085bdedad7d1a236d2bc9bc18c95f16e/simple_bench_public.json",
    release: "public-2024-12-20", graderVersion: "cockpit-strict-v1",
    prompt: "A juggler throws a solid blue ball a meter in the air and then a solid purple ball (of the same size) two meters in the air. She then climbs to the top of a tall ladder carefully, balancing a yellow balloon on her head. Where is the purple ball most likely now, in relation to the blue ball?\nA. at the same height as the blue ball\nB. at the same height as the yellow balloon\nC. inside the blue ball\nD. above the yellow balloon\nE. below the blue ball\nF. above the blue ball\n\nYou may explain briefly. End your response with exactly one final line: Answer: X\nReplace X with one option letter A, B, C, D, E, or F. Do not list multiple final answers.",
    rules: [{ kind: "choice", answer: "A" }],
  },
  {
    id: "simple4", suite: "SimpleBench", label: "逻辑·说谎者", sourceId: "4",
    sourceUrl: "https://github.com/simple-bench/SimpleBench/blob/fbc2e429085bdedad7d1a236d2bc9bc18c95f16e/simple_bench_public.json",
    release: "public-2024-12-20", graderVersion: "cockpit-strict-v1",
    prompt: "There are two sisters, Amy who always speaks mistruths and Sam who always lies. You don't know which is which. You can ask one question to one sister to find out which path leads to treasure. Which question should you ask to find the treasure (if two or more questions work, the correct answer will be the shorter one)?\nA. \"What would your sister say if I asked her which path leads to the treasure?\"\nB. \"What is your sister’s name?”\nC. \"What path leads to the treasure?\"\nD. \"What path do you think I will take, if you were to guess?\"\nE. \"What is in the treasure?\"\nF. “What is your sister’s number?”\n\nYou may explain briefly. End your response with exactly one final line: Answer: X\nReplace X with one option letter A, B, C, D, E, or F. Do not list multiple final answers.",
    rules: [{ kind: "choice", answer: "C" }],
  },
  {
    id: "simple8", suite: "SimpleBench", label: "推理·数量守恒", sourceId: "8",
    sourceUrl: "https://github.com/simple-bench/SimpleBench/blob/fbc2e429085bdedad7d1a236d2bc9bc18c95f16e/simple_bench_public.json",
    release: "public-2024-12-20", graderVersion: "cockpit-strict-v1",
    prompt: "On a shelf, there is only a green apple, red pear, and pink peach. Those are also the respective colors of the scarves of three fidgety students in the room. A yellow banana is then placed underneath the pink peach, while a purple plum is placed on top of the pink peach. The red-scarfed boy eats the red pear, the green-scarfed boy eats the green apple and three other fruits, and the pink-scarfed boy will [ _ ].\nA. eat just the yellow banana\nB. eat the pink, yellow and purple fruits\nC. eat just the purple plum\nD. eat the pink peach\nE. eat two fruits\nF. eat no fruits\n\nYou may explain briefly. End your response with exactly one final line: Answer: X\nReplace X with one option letter A, B, C, D, E, or F. Do not list multiple final answers.",
    rules: [{ kind: "choice", answer: "F" }],
  },
  {
    id: "livezebra2", suite: "LiveBench", label: "斑马谜题·2人",
    sourceId: "bd14ba82d1fe813dcdf6c16f0f868e5f3fe92e4cee9cf5eb3fd5cb6f03d68517",
    sourceUrl: "https://huggingface.co/datasets/livebench/reasoning/tree/6fc6498a5dfba553f69f4413feabade1f1a2d384",
    release: "2024-11-25", graderVersion: "cockpit-strict-v1",
    prompt: "There are 2 people standing in a line. From left to right, they are numbered 1 to 2.\nEach person has a set of attributes: Hobby, Job, Movie-Genre.\nThe attributes have the following possible values:\nHobby: filmmaking, collecting\nJob: journalist, police-officer\nMovie-Genre: adventure, thriller\nEach person has a unique value for each attribute.\nYou know the following about the people:\nThe person who is a journalist is somewhere to the right of the person who watches adventure\nThe person who is a police-officer is not the same as the person who likes filmmaking\n\nGiven this information, answer the following questions:\nAt what position is the person who watches adventure?\nWhat hobby does the person who is a journalist do?\nWhat is the job of the person who watches adventure?\nWhat is the job of the person who watches thriller?\nThink step by step and explain your reasoning, then output your answers in order in the format:\n<solution>answer1, answer2, answer3, ...</solution>\nFor instance, if there were 3 questions and the answers were A, B, and C, the output would be:\n<solution>A, B, C</solution>\nIf the answer to a question is a number, be sure to put it in numerical form (e.g. '3' instead of 'three').\n",
    rules: [{ kind: "solution", answers: ["1", "filmmaking", "police-officer", "journalist"] }],
  },
  {
    id: "livezebra5", suite: "LiveBench", label: "斑马谜题·5人",
    sourceId: "5dfee88d04c7497f9f4ee44138fed2f9298ed523ed05bde479293eb0cb06ee2f",
    sourceUrl: "https://huggingface.co/datasets/livebench/reasoning/tree/6fc6498a5dfba553f69f4413feabade1f1a2d384",
    release: "2024-11-25", graderVersion: "cockpit-strict-v1",
    prompt: "There are 5 people standing in a line. From left to right, they are numbered 1 to 5.\nEach person has a set of attributes: Food, Job, Movie-Genre, Music-Genre, Sport.\nThe attributes have the following possible values:\nFood: lemon, blueberry, cranberry, cauliflower, pepper\nJob: police-officer, manager, nurse, designer, dancer\nMovie-Genre: spy, romance, satire, superhero, musical\nMusic-Genre: disco, country, techno, salsa, rock\nSport: lacrosse, weightlifting, tennis, cricket, golf\nEach person has a unique value for each attribute.\nYou know the following about the people:\nThe person who plays tennis and the person who listens to salsa have different parity positions\nThe person who eats blueberry is on the immediate left or immediate right of the person who listens to rock\nThe person who watches superhero is not anywhere to the right of the person who plays weightlifting\nThe person who eats lemon is not anywhere to the right of the person who is a nurse\nThe person who watches romance is not anywhere to the left of the person who watches spy\nThe person who listens to disco is somewhere to the right of the person who eats cauliflower\nThe person who watches spy is the same as the person who eats blueberry or the person who watches spy is the same as the person who listens to salsa or both\nThe person who listens to techno is not anywhere to the left of the person who is a dancer\nThe person who watches romance is on the immediate left or immediate right of the person who watches musical\nThe person who listens to salsa is on the immediate left or immediate right of the person who watches superhero\nThe person who plays lacrosse is not anywhere to the left of the person who watches superhero\nThe person who plays golf is on the far left or far right\nThe person who watches superhero is somewhere to the right of the person who is a designer\nThe person who eats pepper is on the immediate left or immediate right of the person who is a manager\nThe person who is a designer is not anywhere to the left of the person who is a nurse\nThe person who listens to techno is in an even position\nThe person who plays weightlifting is on the far left or far right\nThe person who watches musical is on the immediate left or immediate right of the person who eats lemon\nThe person who is a dancer is somewhere to the right of the person who listens to rock\nIn the above, 'parity position' means the evenness or oddness of the person's position in the line.\nGiven this information, answer the following questions:\nWhat movie genre does the person who plays tennis watch?\nWhat job does the person in position 3 have?\nWhat job does the person in position 2 have?\nAt what position is the person who listens to salsa?\nThink step by step and explain your reasoning, then output your answers in order in the format:\n<solution>answer1, answer2, answer3, ...</solution>\nFor instance, if there were 3 questions and the answers were A, B, and C, the output would be:\n<solution>A, B, C</solution>\nIf the answer to a question is a number, be sure to put it in numerical form (e.g. '3' instead of 'three').\n",
    rules: [{ kind: "solution", answers: ["romance", "designer", "nurse", "3"] }],
  },
  {
    id: "livetriangle", suite: "LiveBench", label: "三角形切割",
    sourceId: "59979242f2437bc604ba87e9af3dd80878837a3ad01436d110fca1191f1dc0bb",
    sourceUrl: "https://huggingface.co/datasets/livebench/reasoning/tree/6fc6498a5dfba553f69f4413feabade1f1a2d384",
    release: "2024-07-26", graderVersion: "cockpit-strict-v1",
    prompt: "Suppose I have a physical, solid, equilateral triangle, and I make two cuts. The two cuts are from two parallel lines, and both cuts pass through the interior of the triangle. How many pieces are there after the cuts? Think step by step, and then put your answer in **bold** as a single integer (for example, **0**). If you don't know, guess.",
    rules: [{ kind: "boldInteger", answer: "3" }],
  },
  {
    id: "livesquare", suite: "LiveBench", label: "正方形切割",
    sourceId: "3d118e7c265b1ddf3c22d8765dc0c224dec03fad27d51c9687b46d61b6c4d0e5",
    sourceUrl: "https://huggingface.co/datasets/livebench/reasoning/tree/6fc6498a5dfba553f69f4413feabade1f1a2d384",
    release: "2024-07-26", graderVersion: "cockpit-strict-v1",
    prompt: "Suppose I have a physical, solid square with vertices ABCD, and I make two cuts through AC and BD. How many pieces are there after the cuts?  Think step by step, and then put your answer in **bold** as a single integer (for example, **0**). If you don't know, guess.",
    rules: [{ kind: "boldInteger", answer: "4" }],
  },
];

export const CHALLENGE_BENCHMARKS: readonly ScoredBenchmark[] = [
  {
    id: "cockpitMathExactV1", suite: "Cockpit", label: "数学·精确概率",
    sourceId: "math-exact-v1", sourceUrl: "", release: "v1", graderVersion: "cockpit-exact-v2",
    prompt: `A bag contains 6 distinct red balls, 5 distinct blue balls and 4 distinct green balls. Choose a uniformly random unordered set of 5 balls without replacement. Every 5-element subset is equally likely.
Call a sample valid if it contains at least one ball of each color AND strictly more red balls than blue balls.
Return only one strict JSON object with exactly these keys, without Markdown or commentary:
- validSubsets: the number of valid subsets (an integer).
- totalSubsets: the number of all 5-element subsets (an integer).
- probability: the probability that a sample is valid, as a reduced positive fraction string "p/q".
- conditionalProbability: the probability of strictly more red than blue, CONDITIONED on at least one ball of each color, as a reduced positive fraction string "p/q".
Fractions must have no spaces and use the least positive denominator.`,
    rules: [{
      kind: "jsonFields",
      fields: [
        { name: "validSubsets", value: 850 },
        { name: "totalSubsets", value: 3003 },
        { name: "probability", value: "850/3003" },
        { name: "conditionalProbability", value: "85/217" },
      ],
    }],
    reference: "合法取球数量组合 (红, 蓝, 绿) 为 (2,1,2) 与 (3,1,1)，分别贡献 C(6,2)C(5,1)C(4,2)=450 与 C(6,3)C(5,1)C(4,1)=400，共 850 种；总样本 C(15,5)=3003；包含全部三种颜色的样本由容斥原理得 2170 种，因此概率为 850/3003，条件概率为 850/2170=85/217。",
  },
  {
    id: "cockpitCodeTraceV1", suite: "Cockpit", label: "代码·边界追踪",
    sourceId: "code-trace-v1", sourceUrl: "", release: "v1", graderVersion: "cockpit-exact-v2",
    prompt: `Trace this ECMAScript 2022 program using standard built-ins. No prototype modifications exist. Sparse array holes are not explicit undefined values; apply the actual map, slice, Object.keys and JSON.stringify rules.
Return exactly the JSON object printed by the program. Use strict JSON only, with all seven printed keys and no extra keys, Markdown or commentary. You do not need to execute any code.
\`\`\`javascript
${CODE_TRACE_SOURCE}
\`\`\``,
    rules: [{
      kind: "jsonFields",
      fields: [
        { name: "source", value: [2, 3, 0, null] },
        { name: "copy", value: [2, null, 0, 5] },
        { name: "mapped", value: [2, 4, 2, null] },
        { name: "keys", value: ["0", "1", "2"] },
        { name: "calls", value: 3 },
        { name: "closures", value: [0, 1, 2] },
        { name: "settled", value: 11 },
      ],
    }],
    reference: "alias 修改了 source 但不影响此前的 slice；delete source[3] 保留数组长度并产生稀疏空洞；map 会跳过空洞，仅执行 3 次回调并保留 3 个自有键；JSON.stringify 将数组空洞序列化为 null；let 循环每次迭代拥有独立绑定；finally 中的 return 会覆盖 try 的待返回结果。",
  },
  {
    id: "cockpitContextLedgerV1", suite: "Cockpit", label: "长文·事件账本",
    sourceId: "context-ledger-v1", sourceUrl: "", release: "v1", graderVersion: "cockpit-exact-v2",
    prompt: CONTEXT_LEDGER_PROMPT,
    rules: [{
      kind: "jsonFields",
      fields: [
        { name: "uniqueTargetEvents", value: 18 },
        { name: "activeInvoiceCount", value: 6 },
        { name: "totalCents", value: 59323 },
        { name: "largestInvoiceId", value: "A103" },
        { name: "activeInvoiceIds", value: ["A102", "A103", "A104", "A106", "A107", "A108"] },
      ],
    }],
    reference: "先严格过滤 project=ORBIT 且 period=2026-09，再去重得到 18 条目标事件；按最大 revision 取最新状态后，A101 与 A105 为 void，其余 6 张有效账单金额之和为 59323 分，最大账单为恢复后的 A103（29025 分）。末尾重复投递的旧版本不得覆盖高版本。",
  },
  {
    id: "cockpitMultiStepV1", suite: "Cockpit", label: "推理·依赖规划",
    sourceId: "resource-planning-v1", sourceUrl: "", release: "v1", graderVersion: "cockpit-exact-v2",
    prompt: `Schedule eight non-preemptive jobs using a shared pool of 3 identical workers. Time starts at 0. Every start time is a nonnegative integer. A job occupies its required number of workers for its entire duration, on [start, start+duration). A successor may start exactly when all predecessors finish. Workers can be reused immediately at a finish time. No other constraints exist.
Job | duration | workers | immediate predecessors
A | 3 | 2 | none
B | 2 | 1 | none
C | 4 | 2 | A
D | 3 | 1 | B
E | 2 | 1 | A,B
F | 4 | 3 | C,D
G | 2 | 1 | E
H | 1 | 2 | F,G
Minimize the finishing time of H (all jobs are its ancestors). Among all schedules with that minimum finish, choose the lexicographically smallest start-time vector in alphabetical job order A,B,C,D,E,F,G,H. Lexicographic means minimize A's start first, then B's, and so on, subject to the optimal finish.
Return only one strict JSON object, with exactly these keys and no Markdown or commentary:
- minimumFinish: optimal finish time (integer).
- startTimes: the canonical eight-element start-time vector (array of integers).
- totalWorkerTime: sum over all jobs of duration times workers (integer).`,
    rules: [{
      kind: "jsonFields",
      fields: [
        { name: "minimumFinish", value: 14 },
        { name: "startTimes", value: [0, 0, 3, 2, 5, 7, 11, 13] },
        { name: "totalWorkerTime", value: 37 },
      ],
    }],
    reference: "最优完工时间为 14，字典序最小启动向量 A..H 为 [0,0,3,2,5,7,11,13]。F 需独占全部 3 个 worker，无法与 G 并行；总工时为 6+2+8+3+2+12+2+2=37。",
  },
];

export const SCORED_BENCHMARKS: readonly ScoredBenchmark[] = [...LEGACY_BENCHMARKS, ...CHALLENGE_BENCHMARKS];
export const SELECTABLE_SCORED_BENCHMARKS: readonly ScoredBenchmark[] = [
  ...LEGACY_BENCHMARKS.filter(entry => ["ifeval1075", "simple1", "simple4", "livezebra5"].includes(entry.id)),
  ...CHALLENGE_BENCHMARKS,
];

export const PELICAN_BENCHMARKS: Readonly<Record<string, string>> = {
  animation: CODEX_PELICAN_DEFAULT_PROMPT,
  candy: CANDY_REASONING_PROMPT,
  ...Object.fromEntries(SCORED_BENCHMARKS.map(entry => [entry.id, entry.prompt])),
  custom: "",
};

export const PELICAN_BENCHMARK_IDS: readonly string[] = [
  "animation",
  "candy",
  ...SELECTABLE_SCORED_BENCHMARKS.map(entry => entry.id),
  "custom",
];

export function pelicanBenchmark(prompt: string): string {
  return Object.keys(PELICAN_BENCHMARKS).find(id => id !== "custom" && PELICAN_BENCHMARKS[id] === prompt) ?? "custom";
}

export function scoredPelicanBenchmark(prompt: string): ScoredBenchmark | undefined {
  return SCORED_BENCHMARKS.find(entry => entry.prompt === prompt);
}

export function pelicanBenchmarkLabel(id: string): string {
  if (id === "animation") return "鹈鹕动画";
  if (id === "candy") return "糖果推理";
  if (id === "custom") return "自定义";
  const found = SCORED_BENCHMARKS.find(entry => entry.id === id);
  return found ? `${found.suite} · ${found.label}` : id;
}

export const BENCHMARK_NOTICES: Readonly<Record<"IFEval" | "SimpleBench" | "LiveBench", string>> = {
  IFEval: "Copyright The Google Research Authors. Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).",
  SimpleBench: "MIT License — Copyright (c) 2024 simple-bench. Permission is hereby granted, free of charge, under standard MIT terms.",
  LiveBench: "Dataset prompts from LiveBench (Apache License 2.0, FastChat / MIT License, Copyright (c) 2024 LiveCodeBench).",
};

const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const PREVIEW_RESET_STYLE = "html,body{margin:0;width:100%;height:100%}body>svg:only-child{display:block;width:100%;height:100%}";
const PREVIEW_LOCKDOWN = `(() => {
  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'WebTransport']) {
    try { Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false }); } catch (_) {}
  }
  for (const key of ['alert', 'confirm', 'prompt', 'print']) {
    try { Object.defineProperty(globalThis, key, { value: () => undefined, writable: false, configurable: false }); } catch (_) {}
  }
})()`;

export function pelicanPreviewDocument(html: string): string {
  const sanitized = html.replace(/<(?:meta|base)\b[^>]*>/gi, "").trim();
  const headPayload = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer"><style>${PREVIEW_RESET_STYLE}</style><script>${PREVIEW_LOCKDOWN}</script>`;
  const headMatch = /<head\b[^>]*>/i.exec(sanitized);
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length;
    return `${sanitized.slice(0, idx)}${headPayload}${sanitized.slice(idx)}`;
  }
  const htmlMatch = /<html\b[^>]*>/i.exec(sanitized);
  if (htmlMatch) {
    const idx = htmlMatch.index + htmlMatch[0].length;
    return `${sanitized.slice(0, idx)}<head>${headPayload}</head>${sanitized.slice(idx)}`;
  }
  return `<!DOCTYPE html><html><head>${headPayload}</head><body>${sanitized}</body></html>`;
}
