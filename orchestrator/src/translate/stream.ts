// Streaming translator: OpenAI SSE -> Anthropic SSE. Pure port of Part C of
// docs/tool-translation-spec.md (litellm's AnthropicStreamWrapper), reshaped
// from litellm's pull-based iterator into a push transform: feed raw OpenAI SSE
// text with write(), get Anthropic SSE event strings back; call end() to flush.
//
// Target order: message_start -> (content_block_start -> content_block_delta* ->
// content_block_stop)* -> message_delta(stop_reason+usage) -> message_stop.
//
// Deviation from litellm (justified): litellm always opens a phantom index-0
// text block up front, so a tool-first or thinking-first response emits an empty
// text block before the real one. We instead DEFER the first content_block_start
// until the first real content chunk determines the block type. This avoids
// emitting an empty text block, keeps block indices tight, and still implements
// every transition rule (stop -> index++ -> start -> re-emit trigger delta).

import type { TranslateMeta } from './request.ts';
import { mapFinishReason, normalizeToolUseId, restoreToolName, translateUsage, zeroedUsage } from './response.ts';

type BlockType = 'text' | 'tool_use' | 'thinking';

function frame(event: any): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function randomMsgId(): string {
  return 'msg_' + Math.random().toString(36).slice(2, 14);
}
function randomToolId(): string {
  return 'toolu_' + Math.random().toString(36).slice(2, 14);
}

function deltaHasContent(delta: any): boolean {
  if (!delta || typeof delta !== 'object') return false;
  if (typeof delta.content === 'string' && delta.content.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true;
  return false;
}

export type OpenAIToAnthropicStream = {
  // Feed raw OpenAI SSE text (may be partial across calls). Returns Anthropic
  // SSE event strings produced so far.
  write(text: string): string[];
  // Flush remaining events (closing block, held message_delta, message_stop).
  end(): string[];
};

export function createOpenAIToAnthropicStream(meta: TranslateMeta): OpenAIToAnthropicStream {
  // --- state machine ---------------------------------------------------------
  let sentMessageStart = false;
  let currentBlockType: BlockType | null = null;
  let currentBlockIndex = 0;
  let sentBlockStop = false; // whether the current open block has been closed
  let holdingStopReason: any = null; // held message_delta awaiting a trailing usage chunk
  let queuedUsage = false; // once the final message_delta is emitted, drop stragglers (D10)
  let flushed = false;
  let lineBuffer = '';

  function ensureMessageStart(obj: any, events: any[]): void {
    if (sentMessageStart) return;
    sentMessageStart = true;
    const model = (obj && obj.model) || meta.model || 'unknown-model';
    events.push({
      type: 'message_start',
      message: {
        id: randomMsgId(),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: zeroedUsage(),
      },
    });
  }

  // Classify a content delta into an Anthropic block type + empty start block.
  function blockOf(delta: any): [BlockType, any] {
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0 && delta.tool_calls[0].function) {
      const tc = delta.tool_calls[0];
      const rawId = typeof tc.id === 'string' && tc.id ? tc.id : randomToolId();
      const name = tc.function.name || '';
      return ['tool_use', { type: 'tool_use', id: normalizeToolUseId(rawId), name: restoreToolName(name, meta), input: {} }];
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) return ['text', { type: 'text', text: '' }];
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      return ['thinking', { type: 'thinking', thinking: '', signature: '' }];
    }
    return ['text', { type: 'text', text: '' }];
  }

  // Translate a content delta into an Anthropic content_block_delta payload.
  // Tool arguments are concatenated RAW and NEVER parsed mid-stream (C3/D4).
  function translateDelta(delta: any): any {
    let text = '';
    let reasoning = '';
    let partialJson: string | null = null;
    if (typeof delta.content === 'string') text += delta.content;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      partialJson = '';
      for (const t of delta.tool_calls) {
        if (t && t.function && t.function.arguments != null) partialJson += t.function.arguments;
      }
    } else if (typeof delta.reasoning_content === 'string') {
      reasoning += delta.reasoning_content;
    }
    if (partialJson !== null) return { type: 'input_json_delta', partial_json: partialJson };
    if (reasoning) return { type: 'thinking_delta', thinking: reasoning };
    return { type: 'text_delta', text };
  }

  // Whether a re-emitted trigger delta actually carries content worth emitting
  // after a block transition — else the synthesized content_block_start (empty
  // body) would be followed by a redundant empty delta (D8).
  function triggerDeltaHasContent(d: any): boolean {
    if (d.type === 'text_delta') return !!d.text;
    if (d.type === 'input_json_delta') return !!d.partial_json;
    if (d.type === 'thinking_delta') return !!d.thinking;
    return false;
  }

  function shouldStartNew(blockType: BlockType, startObj: any): boolean {
    if (blockType !== currentBlockType) return true;
    // A tool_use chunk that carries a fresh function name signals a new parallel
    // tool call even though the block type is unchanged.
    if (blockType === 'tool_use' && startObj.name) return true;
    return false;
  }

  function handleContent(obj: any, events: any[]): void {
    const delta = obj.choices[0].delta;
    const [blockType, startObj] = blockOf(delta);
    const d = translateDelta(delta);

    if (currentBlockType === null) {
      // First real block: open it at index 0.
      currentBlockType = blockType;
      currentBlockIndex = 0;
      sentBlockStop = false;
      events.push({ type: 'content_block_start', index: 0, content_block: startObj });
      if (triggerDeltaHasContent(d)) events.push({ type: 'content_block_delta', index: 0, delta: d });
      return;
    }

    if (shouldStartNew(blockType, startObj)) {
      // Close the old block, open the new one, then re-emit this chunk's delta so
      // the new block's first token is not dropped (C2/D8).
      events.push({ type: 'content_block_stop', index: currentBlockIndex });
      currentBlockIndex += 1;
      currentBlockType = blockType;
      sentBlockStop = false;
      events.push({ type: 'content_block_start', index: currentBlockIndex, content_block: startObj });
      if (triggerDeltaHasContent(d)) events.push({ type: 'content_block_delta', index: currentBlockIndex, delta: d });
      return;
    }

    events.push({ type: 'content_block_delta', index: currentBlockIndex, delta: d });
  }

  function handleFinish(obj: any, events: any[]): void {
    // Force a content_block_stop for the open block before the message_delta (D12).
    if (currentBlockType !== null && !sentBlockStop) {
      events.push({ type: 'content_block_stop', index: currentBlockIndex });
      sentBlockStop = true;
    }
    const stopReason = mapFinishReason(obj.choices[0].finish_reason);
    // Hold the message_delta: usage usually arrives in a SEPARATE trailing chunk
    // (choices:[]) and must be merged in (C4). If it never comes, flush emits
    // this held delta with whatever usage the finish chunk carried (or zeros).
    holdingStopReason = {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: translateUsage(obj.usage),
    };
  }

  function mergeUsage(obj: any, events: any[]): void {
    const md = holdingStopReason;
    md.usage = translateUsage(obj.usage);
    events.push(md);
    holdingStopReason = null;
    queuedUsage = true;
  }

  function handleObj(obj: any, events: any[]): void {
    ensureMessageStart(obj, events);
    if (queuedUsage) return; // nothing after the final message_delta (D10)

    const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : undefined;
    const finish = choice ? choice.finish_reason : null;
    const delta = choice ? choice.delta : undefined;
    const hasContent = deltaHasContent(delta);
    const hasUsage = obj && obj.usage != null;

    // Collapsed chunk carrying content AND finish_reason together: split so the
    // content is emitted before the stop (C4).
    if (finish != null && hasContent) {
      handleContent(obj, events);
      handleFinish(obj, events);
      return;
    }
    if (finish != null) {
      handleFinish(obj, events);
      return;
    }
    // Trailing usage-only chunk merged into the held message_delta (C4).
    if (!hasContent && hasUsage && holdingStopReason !== null) {
      mergeUsage(obj, events);
      return;
    }
    if (!hasContent) return; // role announcements / empty deltas
    handleContent(obj, events);
  }

  function flush(events: any[]): void {
    if (flushed) return;
    flushed = true;
    ensureMessageStart(undefined, events);
    if (!queuedUsage) {
      if (holdingStopReason !== null) {
        if (currentBlockType !== null && !sentBlockStop) {
          events.push({ type: 'content_block_stop', index: currentBlockIndex });
          sentBlockStop = true;
        }
        events.push(holdingStopReason);
        holdingStopReason = null;
      } else {
        // Stream ended without a finish_reason: close any open block and synth a
        // terminal message_delta so the client sees a well-formed end.
        if (currentBlockType !== null && !sentBlockStop) {
          events.push({ type: 'content_block_stop', index: currentBlockIndex });
          sentBlockStop = true;
        }
        events.push({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      }
    }
    events.push({ type: 'message_stop' });
  }

  function consumeLine(line: string, events: any[]): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      flush(events);
      return;
    }
    let obj: any;
    try {
      obj = JSON.parse(payload);
    } catch {
      return; // ignore unparseable SSE data lines
    }
    handleObj(obj, events);
  }

  return {
    write(text: string): string[] {
      const events: any[] = [];
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? ''; // keep the trailing partial line
      for (const line of lines) consumeLine(line, events);
      return events.map(frame);
    },
    end(): string[] {
      const events: any[] = [];
      if (lineBuffer) {
        consumeLine(lineBuffer, events);
        lineBuffer = '';
      }
      flush(events);
      return events.map(frame);
    },
  };
}
