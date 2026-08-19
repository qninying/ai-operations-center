import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const ENV_KEYS = ["AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_CONTAINER"];

function clearBlobEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setBlobEnv() {
  process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  process.env.AZURE_STORAGE_CONTAINER = "diagnostics";
}

// A minimal async-iterable standing in for the Node readable stream
// BlobClient.download() returns as `readableStreamBody` — downloadBlob() only ever
// consumes it via `for await`, so that's all the mock needs to satisfy.
function streamOf(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

// Registers a mocked @azure/storage-blob module and returns the download spy.
// download() defaults to rejecting every call — override with
// mockResolvedValueOnce/mockRejectedValueOnce per test. Must be called before the
// dynamic import of cloudBlobSource.js.
function mockAzureBlob(download: ReturnType<typeof vi.fn>) {
  const getBlobClient = vi.fn(() => ({ download }));
  const getContainerClient = vi.fn(() => ({ getBlobClient }));
  const fromConnectionString = vi.fn(() => ({ getContainerClient }));

  vi.doMock("@azure/storage-blob", () => ({
    BlobServiceClient: { fromConnectionString },
  }));

  return { fromConnectionString, getContainerClient, getBlobClient };
}

// Same reliability budget as dmvLiveSource.ts, baked into cloudBlobSource.ts: 10s
// timeout, 3 retries (4 attempts total), exponential backoff (500ms/1000ms/2000ms),
// circuit breaker opens after 5 accumulated failures in a 60s window. Fake timers
// throughout so retry backoff and cooldown cost no real wall-clock time.
describe("queryLiveCloudBlob", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("throws CloudSourceUnavailableError listing every missing env var, without attempting a connection", async () => {
    clearBlobEnv();
    const { queryLiveCloudBlob, CloudSourceUnavailableError } = await import(
      "./cloudBlobSource.js"
    );

    await expect(queryLiveCloudBlob()).rejects.toThrow(CloudSourceUnavailableError);
  });

  it("downloads and parses the diagnostic blob on the happy path", async () => {
    setBlobEnv();
    const records = [
      { timestamp: "2026-08-19T00:00:00Z", service: "SSIS", severity: "warning", message: "slow load" },
    ];
    const download = vi.fn().mockResolvedValue({
      readableStreamBody: streamOf(JSON.stringify(records)),
    });
    const { getContainerClient, getBlobClient } = mockAzureBlob(download);

    const { queryLiveCloudBlob } = await import("./cloudBlobSource.js");
    await expect(queryLiveCloudBlob()).resolves.toEqual(records);

    expect(getContainerClient).toHaveBeenCalledWith("diagnostics");
    expect(getBlobClient).toHaveBeenCalledWith("diagnostics.json");
  });

  it("reads a caller-specified blob name instead of the default", async () => {
    setBlobEnv();
    const download = vi.fn().mockResolvedValue({ readableStreamBody: streamOf("[]") });
    const { getBlobClient } = mockAzureBlob(download);

    const { queryLiveCloudBlob } = await import("./cloudBlobSource.js");
    await queryLiveCloudBlob({ blobName: "custom-export.json" });

    expect(getBlobClient).toHaveBeenCalledWith("custom-export.json");
  });

  it("retries 3 times (4 attempts total) on connection failure, then throws UpstreamCallFailedError", async () => {
    setBlobEnv();
    const download = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    mockAzureBlob(download);

    const { queryLiveCloudBlob } = await import("./cloudBlobSource.js");
    const { UpstreamCallFailedError } = await import("./reliability/withReliability.js");

    const resultPromise = queryLiveCloudBlob();
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(download).toHaveBeenCalledTimes(4);
  });

  // STORY-007's explicit "invalid data format" failure path: the blob exists and
  // downloads fine, but its content isn't valid JSON. downloadBlob() doesn't treat
  // this specially — the SyntaxError propagates through withReliability like any
  // other attempt failure — but the story requires this case to fail honestly rather
  // than silently, so it's asserted directly.
  it("surfaces malformed blob content as UpstreamCallFailedError rather than a bad-shape result", async () => {
    setBlobEnv();
    const download = vi.fn().mockResolvedValue({
      readableStreamBody: streamOf("{not valid json"),
    });
    mockAzureBlob(download);

    const { queryLiveCloudBlob } = await import("./cloudBlobSource.js");
    const { UpstreamCallFailedError } = await import("./reliability/withReliability.js");

    const resultPromise = queryLiveCloudBlob();
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(download).toHaveBeenCalledTimes(4);
  });

  it("opens the circuit breaker once failures cross the threshold, then fails fast without attempting a connection", async () => {
    setBlobEnv();
    const download = vi.fn().mockRejectedValue(new Error("down"));
    mockAzureBlob(download);

    const { queryLiveCloudBlob } = await import("./cloudBlobSource.js");
    const { CircuitOpenError } = await import("./reliability/circuitBreaker.js");

    // Each fully-exhausted call records 4 failures. Threshold is 5, so the 5th
    // failure — the 1st attempt of the 2nd call — trips the breaker.
    const call1 = queryLiveCloudBlob();
    const call1Assertion = expect(call1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call1Assertion;

    const call2 = queryLiveCloudBlob();
    const call2Assertion = expect(call2).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call2Assertion;

    download.mockClear();

    await expect(queryLiveCloudBlob()).rejects.toThrow(CircuitOpenError);
    expect(download).not.toHaveBeenCalled();
  });
});
