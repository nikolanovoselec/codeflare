# Streaming Chat with AIChatAgent

Fetch https://developers.cloudflare.com/agents/api-reference/chat-agents/ for complete documentation.

`AIChatAgent` from `@cloudflare/ai-chat` provides streaming chat with automatic message persistence and resumable streams.

## Basic Chat Agent

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const result = streamText({
      model: openai("gpt-4o"),
      system: "You are a helpful assistant.",
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish
    });
    return result.toUIMessageStreamResponse();
  }
}
```

**Important:** Always pass `abortSignal` and `onFinish` — they enable proper cleanup and message persistence.

## With Tools

```typescript
import { tool } from "ai";
import { z } from "zod";

const tools = {
  getWeather: tool({
    description: "Get weather for a location",
    parameters: z.object({ location: z.string() }),
    execute: async ({ location }) => `Weather in ${location}: 72°F, sunny`
  })
};

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const result = streamText({
      model: openai("gpt-4o"),
      messages: await convertToModelMessages(this.messages),
      tools,
      abortSignal: options?.abortSignal,
      onFinish
    });
    return result.toUIMessageStreamResponse();
  }
}
```

## With Workers AI (no API keys)

```typescript
import { createWorkersAI } from "workers-ai-provider";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/meta/llama-4-scout-17b-16e-instruct"),
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish
    });
    return result.toUIMessageStreamResponse();
  }
}
```

## Custom UI Message Stream

For more control, use `createUIMessageStream`:

```typescript
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: await convertToModelMessages(this.messages),
          onFinish
        });
        writer.merge(result.toUIMessageStream());
      }
    });
    return createUIMessageStreamResponse({ stream });
  }
}
```

## Resumable Streaming

Streams automatically resume if client disconnects and reconnects:

1. Chunks buffered to SQLite during streaming
2. On reconnect, buffered chunks sent immediately
3. Live streaming continues from where it left off

**Enabled by default.** To disable:

```tsx
const { messages } = useAgentChat({ agent, resume: false });
```

## React Client

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function ChatUI() {
  const agent = useAgent({
    agent: "Chat",
    name: "my-chat-session"
  });

  const { 
    messages, 
    input, 
    handleInputChange, 
    handleSubmit, 
    status 
  } = useAgentChat({ agent });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.content}
        </div>
      ))}
      
      <form onSubmit={handleSubmit}>
        <input 
          value={input} 
          onChange={handleInputChange}
          disabled={status === "streaming"}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

## Streaming RPC Methods

For non-chat streaming, use `@callable({ streaming: true })`:

```typescript
import { Agent, callable, StreamingResponse } from "agents";

export class MyAgent extends Agent<Env> {
  @callable({ streaming: true })
  async streamData(stream: StreamingResponse, query: string) {
    for (let i = 0; i < 10; i++) {
      stream.send(`Result ${i}: ${query}`);
      await sleep(100);
    }
    stream.close();
  }
}
```

Client receives streamed messages via WebSocket RPC.

## Key Properties

| Property | Purpose |
|----------|---------|
| `this.messages` | All persisted messages |
| `maxPersistedMessages` | Limit stored messages (prune oldest) |
| `messageConcurrency` | `"queue"` (default), `"latest"`, `"merge"`, `"drop"` |
| `chatRecovery` | Version-matched `true`/configuration object, not `"persist"`/`"continue"` strings; see recovery policy below |
| `waitForMcpConnections` | Wait for MCP servers before first turn |

## Recovery Policy

In the Agents 0.22+ chat release line, durable message recovery is unconditional; `chatRecovery: false` no longer disables its bookkeeping. Use the matching `onChatRecovery()` policy hook returning `{ continue: false }` when automatic inference must not resume. Set recovery budgets before startup recovery, not in `onStart`. Check the installed AIChat/Think peer versions before copying configuration.

Client `useAgentChat({ resume: false })` disables UI stream resumption, not server-side automatic inference. Neither a reconnect nor retained messages grant authorization to restart paused application work. See the [version-matched upstream chat guide](https://github.com/cloudflare/agents/blob/agents%400.28.1/docs/agents/chat-agents.md).

## Status Values

`useAgentChat` status:

| Status | Meaning |
|--------|---------|
| `ready` | Idle, ready for input |
| `streaming` | Response streaming |
| `submitted` | Request sent, waiting |
| `error` | Error occurred |

Also: `isStreaming`, `isServerStreaming` for distinguishing user vs server-initiated streams.
