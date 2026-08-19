import { describe, it, expect, vi } from "vitest";
import {
  generateCloudRecommendation,
  CloudServiceUnavailableError,
  InvalidCloudDataFormatError,
} from "./cloudRecommendationService.js";
import { CloudSourceUnavailableError } from "./cloudBlobSource.js";
import type { RootCauseResult } from "./rootCauseAgent.js";

const validRecord = {
  timestamp: "2026-08-19T00:00:00Z",
  service: "SSIS",
  severity: "warning",
  message: "Package load exceeded expected duration",
};

function fakeRootCause(): RootCauseResult {
  return {
    rootCause: "SSIS package load degraded by upstream cloud storage latency",
    confidence: 80,
    evidenceIdsUsed: ["cloud:SSIS:2026-08-19T00:00:00Z:0"],
    insufficientEvidence: false,
  };
}

describe("generateCloudRecommendation", () => {
  it("REQ-008/013: connected to cloud services -> a real AI recommendation using real cloud service data", async () => {
    const queryFn = vi.fn().mockResolvedValue([validRecord]);
    const analyzeFn = vi.fn().mockResolvedValue(fakeRootCause());

    const result = await generateCloudRecommendation("incident-1", "SSIS load is slow", {
      queryFn,
      analyzeFn,
    });

    expect(result.rootCause).toContain("SSIS package load");
    expect(queryFn).toHaveBeenCalledWith();

    const incidentPassedToAgent = analyzeFn.mock.calls[0][0];
    expect(incidentPassedToAgent.evidence[0].data).toEqual(validRecord);
    expect(incidentPassedToAgent.evidence[0].source).toBe("cloud-blob-diagnostics");
  });

  it("failure path — connection failure: unreachable cloud service never falls back to fixture data, notifies instead", async () => {
    const queryFn = vi
      .fn()
      .mockRejectedValue(new CloudSourceUnavailableError(["AZURE_STORAGE_CONNECTION_STRING"]));
    const analyzeFn = vi.fn();

    await expect(
      generateCloudRecommendation("incident-2", "desc", { queryFn, analyzeFn })
    ).rejects.toThrow(CloudServiceUnavailableError);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  it("failure path — data retrieval timeout: also surfaces as CloudServiceUnavailableError, not a silent hang or fake result", async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error("upstream call timed out"));

    await expect(
      generateCloudRecommendation("incident-3", "desc", { queryFn, analyzeFn: vi.fn() })
    ).rejects.toThrow(CloudServiceUnavailableError);
  });

  it("failure path — invalid data format: a malformed record is rejected, not silently passed through as evidence", async () => {
    const malformedRecord = { ...validRecord, severity: 3 };
    const queryFn = vi.fn().mockResolvedValue([malformedRecord]);
    const analyzeFn = vi.fn();

    await expect(
      generateCloudRecommendation("incident-4", "desc", { queryFn, analyzeFn })
    ).rejects.toThrow(InvalidCloudDataFormatError);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  it("Trust — every access attempt is logged, including the invalid-data-format failure path", async () => {
    const logger = await import("./observability/logger.js");
    const logSpy = vi.spyOn(logger, "logEvent");

    const malformedRecord = { ...validRecord, message: null };
    await generateCloudRecommendation("incident-5", "desc", {
      queryFn: vi.fn().mockResolvedValue([malformedRecord]),
      analyzeFn: vi.fn(),
    }).catch(() => {});

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cloud_recommendation_data_access",
        context: expect.objectContaining({
          outcome: "failure",
          errorClass: "InvalidCloudDataFormatError",
        }),
      })
    );
  });

  it("Trust — a successful access attempt is also logged", async () => {
    const logger = await import("./observability/logger.js");
    const logSpy = vi.spyOn(logger, "logEvent");

    await generateCloudRecommendation("incident-6", "desc", {
      queryFn: vi.fn().mockResolvedValue([validRecord]),
      analyzeFn: vi.fn().mockResolvedValue(fakeRootCause()),
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cloud_recommendation_data_access",
        context: expect.objectContaining({ outcome: "success", recordCount: 1 }),
      })
    );
  });
});
