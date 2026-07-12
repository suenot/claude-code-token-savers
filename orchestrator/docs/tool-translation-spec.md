# Anthropic ⇄ OpenAI tool-calling translation spec

Mined from litellm (`experimental_pass_through/adapters/transformation.py`,
`streaming_iterator.py`) and Vercel AI SDK (`packages/{openai,anthropic,provider-utils}`)
on 2026-07-12. Refs: [LL-T]=litellm transformation.py, [LL-S]=litellm
streaming_iterator.py, [V-*]=vercel-ai.

## Part A — request: Anthropic /v1/messages → OpenAI /chat/completions

- A1. Top-level: model+messages required (400 if missing) [LL-T:176]. max_tokens:
  Anthropic REQUIRES it, pass through. Copy-through default: every key not
  explicitly translated goes straight into the OpenAI body [LL-T:1033].
  metadata.user_id→user [LL-T:891]. stop_sequences→stop. thinking
  {enabled,budget_tokens}→reasoning_effort bucketed by budget for non-Claude
  targets; disabled→drop [LL-T:598,956].
- A2. tools[]: {name,description,input_schema} → {type:"function",function:
  {name,description?,parameters:input_schema}} [LL-T:722]. input_schema absent→
  omit parameters. description absent→omit key. Name missing/blank→synthesize
  unnamed_tool_{idx} [LL-T:755]. DO NOT merge Anthropic tool `type` into
  parameters (overwrites parameters.type:"object" — litellm #30557) [LL-T:735].
  Empty tools array→send undefined, not [] [V-openai-prepare:22]. strict: pass
  through only if present. output_format:{json_schema,schema}→response_format:
  {type:json_schema,json_schema:{name,schema,strict:true}} with recursive
  additionalProperties:false + required=all-keys per object level [LL-T:783].
- A3. tool_choice: auto→"auto"; any→"required"; tool{name}→{type:function,
  function:{name}}; none→"none" [LL-T:704]. disable_parallel_tool_use:true
  (inside Anthropic tool_choice)→OpenAI parallel_tool_calls:false (top-level).
  Reverse note: Anthropic has no "none" (vercel drops tools entirely)
  [V-anthropic-prepare:421].
- A4. History, assistant tool_use: one OpenAI assistant msg per turn. text
  blocks→content string; each tool_use→assistant.tool_calls[{id:tool_use.id,
  type:"function",function:{name,arguments:JSON.stringify(input)}}]. arguments
  MUST be a JSON STRING [LL-T:531]. Only set tool_calls if non-empty. Mixed
  text+tool_use→emit both (content may be null when tool_calls present)
  [LL-T:508].
- A5. History, user tool_result → SEPARATE role:"tool" messages: {role:"tool",
  tool_call_id:tool_result.tool_use_id,content}. tool_use_id→tool_call_id is
  MANDATORY [LL-T:400]. Emit tool messages BEFORE residual user text/image,
  preserve order [LL-T:499]. Multiple tool_results in one user msg → multiple
  role:tool msgs (one per id). content shapes: absent→""; string→string; single
  text block→flatten; single image→data/URL string; MULTIPLE blocks
  (text+image)→ONE tool msg (single id) with content as array of parts — never
  split one result across ids. is_error: OpenAI has no flag, fold into content
  (reverse path re-derives from error text [V-anthropic:532]).
- A6. system: string→one system msg; array of {type:text,text}→system msg with
  array content; insert at index 0 [LL-T:856].
- A7. Housekeeping: cache_control preserved ONLY for Claude/Bedrock targets,
  STRIP for plain OpenAI [LL-T:288]. thinking/redacted_thinking blocks→carry
  for Claude, drop for OpenAI. images: base64 source→data:{mt};base64,{data};
  url→url; wrap {type:image_url,image_url:{url}} [LL-T:1112].

## Part B — response (non-stream): OpenAI → Anthropic

Build {id,type:"message",role:"assistant",model,content[],stop_reason,
stop_sequence:null,usage} [LL-T:1302].

- B1. content order thinking→text→tool_use. reasoning_content→{type:thinking}.
  content→{type:text}. each tool_call→{type:tool_use,id:normalized,name,
  input:PARSED object}; arguments JSON string→parse; on parse error attempt
  bracket-repair before failing; empty→{} [LL-T:1205; common_utils.py:1609].
  Non-object parsed value→wrap {rawInvalidInput:value} [V-anthropic:1333].
- B2. IDs: Anthropic pattern ^[a-zA-Z0-9_-]+$. Normalize (strip suffix, replace
  invalid chars with _, empty→"tool_use_id") but PASS THROUGH, don't mint new —
  preserves round-trip correlation [LL-T:1198; common_utils.py:999]. Missing
  id→generate. Tool NAME >64 chars (OpenAI cap): truncate to
  {55prefix}_{8charSHA} on request + keep truncated→original map; restore on
  response [LL-T:22,760,1192].
- B3. finish_reason→stop_reason: stop→end_turn; length→max_tokens; tool_calls
  (+legacy function_call)→tool_use; content_filter→end_turn; default→end_turn.
- B4. usage: prompt_tokens→input_tokens, completion_tokens→output_tokens;
  cached_tokens→cache_read_input_tokens; input=max(prompt−cache_read−
  cache_creation,0) [LL-T:1276].

## Part C — streaming: OpenAI SSE → Anthropic SSE

Target order: message_start → (content_block_start → content_block_delta* →
content_block_stop)* → message_delta(stop_reason+usage) → message_stop.

- C1. Accumulate delta.tool_calls[{index,id?,function:{name?,arguments?}}] per
  INDEX (fallback index=count) [V-tracker:106]. First delta with id+name→emit
  content_block_start {type:tool_use,id:normalized,name,input:{}} [LL-T:1360].
  Later argument fragments→content_block_delta {type:input_json_delta,
  partial_json:fragment}; concatenate RAW, never parse mid-stream [LL-T:1441].
  Empty-args tool→start then stop, zero deltas.
- C2. Index state machine: track current block index + type∈{text,tool_use,
  thinking} [LL-S:142]. message_start first with zeroed usage incl
  cache_creation/read=0 [LL-S:321]. On block-type change OR new tool_use:
  content_block_stop(old) → index++ → content_block_start(new) → RE-EMIT the
  trigger chunk's delta (else the new block's first token is dropped)
  [LL-S:429,810]. Text is its own block interleaved with tool blocks.
- C3. Never finalize a tool call early even if partial_json parses — could be a
  prefix (vercel #13137). Finalize at stream end/flush or genuine new block
  [V-tracker:207].
- C4. Final: on finish_reason → content_block_stop(open block) → message_delta
  {delta:{stop_reason:mapped,stop_sequence:null},usage}. Usage arrives in a
  SEPARATE trailing chunk (choices:[]) — hold message_delta and merge usage
  [LL-S:192,640]. Nothing after message_delta except message_stop — drop
  stragglers [LL-S:420]. [DONE] = end (not JSON). Collapsed chunks carrying
  content+finish_reason together: split first [LL-S:33].
- C5. Wire format: `event: <type>\ndata: <json>\n\n`; event name = JSON type.

## Part D — bugs to avoid

- D1. Dropping tool_use_id/tool_call_id (link-assistant/router's bug): the id
  chain must survive every hop [LL-T:404,412,429,1200].
- D2. Losing assistant tool_calls history (router's other bug): reconstruct
  assistant.tool_calls from tool_use blocks or role:tool msgs are orphaned →
  400 [LL-T:531].
- D3. arguments: OpenAI = JSON string, Anthropic input = object. Stringify one
  way, tolerant parse back [LL-T:536,1205].
- D4. Parsing streamed args mid-flight truncates inputs. Accumulate raw
  [V-tracker:207].
- D5. Merging Anthropic tool `type` into parameters → provider rejects
  [LL-T:735].
- D6. Tool name >64 → truncate+hash+restore map [LL-T:22].
- D7. Non-object tool input → wrap {rawInvalidInput} [V-anthropic:1333].
- D8. New block's first token dropped → re-emit trigger delta after
  content_block_start [LL-S:429].
- D9. Empty tools[]/tool_choice → send undefined [V-openai-prepare:22].
- D10. Events after message_delta violate SSE order — buffer and drop
  [LL-S:420].
- D11. N tool_results→N role:tool msgs (distinct ids); one multi-part result→
  ONE tool msg (single id) [LL-T:417].
- D12. Missing content_block_stop before final message_delta → force-emit
  [LL-S:507].
- D13. Leaking cache_control/thinking to plain OpenAI → gate on target family
  [LL-T:288].
