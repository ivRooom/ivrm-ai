import { describe, expect, it } from "vitest";
import { ApiError, describeError, readSse } from "./api.js";

function streamOf(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readSse", () => {
  it("parses events split across chunks", async () => {
    const events = [];
    for await (const e of readSse(
      streamOf(
        'event: delta\ndata: {"text":"he',
        'llo"}\n\nevent: done\r\ndata: {}\r\n\r\n',
        ": comment\n\n"
      )
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { event: "delta", data: '{"text":"hello"}' },
      { event: "done", data: "{}" },
    ]);
  });
});

describe("describeError", () => {
  it("names the daily limit", () => {
    expect(
      describeError(new ApiError(429, "limit_exceeded", "user_daily"))
    ).toContain("今日の利用上限");
  });

  it("uses Retry-After for the rate limit", () => {
    expect(
      describeError(new ApiError(429, "limit_exceeded", "rate", 60))
    ).toContain("60 秒");
  });

  it("explains 413 and 503", () => {
    expect(describeError(new ApiError(413, "request_too_large"))).toContain(
      "長すぎる"
    );
    expect(describeError(new ApiError(503, "unavailable"))).toContain("停止");
  });

  it("does not leak details of unknown failures", () => {
    expect(describeError(new Error("ECONNRESET at 10.0.0.1"))).not.toContain(
      "10.0.0.1"
    );
  });
});
