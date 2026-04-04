import { randomUUID } from "node:crypto";

import { runPaths } from "../config/paths.js";
import type { PipelineInput, RunEvent, RunRecord, RunStage, WorkflowMode } from "../pipeline/types.js";
import { ensureDir, pathExists, readJson, writeJson } from "./fs-utils.js";
import { AssetStore } from "./assets.js";

export class StateStore {
  public constructor(private readonly assets = new AssetStore()) {}

  public async createRun(input: PipelineInput, workflowMode: WorkflowMode): Promise<RunRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const run: RunRecord = {
      id,
      schema_version: 1,
      createdAt: now,
      updatedAt: now,
      stage: "created",
      workflowMode,
      input,
      resolvedInput: input,
      imageAssets: [],
      latestResponseIds: {},
      notes: [],
      events: [
        {
          at: now,
          stage: "created",
          message: "Run created.",
        },
      ],
    };

    await this.assets.resetRunArtifacts(id);
    await this.assets.ensureRunDirs(id);
    await this.save(run);
    return run;
  }

  public async load(runId: string): Promise<RunRecord> {
    const { runFile } = runPaths(runId);
    if (!(await pathExists(runFile))) {
      throw new Error(`Run not found: ${runId}`);
    }

    const run = await readJson<RunRecord>(runFile);
    if (run.schema_version && run.schema_version > 1) {
      throw new Error(`Run ${runId} has schema version ${run.schema_version} which is newer than supported version 1. Please upgrade the server.`);
    }
    if (!run.schema_version) {
      run.schema_version = 1;
    }
    return run;
  }

  public async save(run: RunRecord): Promise<void> {
    const { runDir, runFile } = runPaths(run.id);
    await ensureDir(runDir);
    run.updatedAt = new Date().toISOString();
    await writeJson(runFile, run);
  }

  public async update(runId: string, mutate: (run: RunRecord) => void | Promise<void>): Promise<RunRecord> {
    const run = await this.load(runId);
    await mutate(run);
    await this.save(run);
    return run;
  }

  public async setStage(runId: string, stage: RunStage, message: string): Promise<RunRecord> {
    return this.update(runId, (run) => {
      run.stage = stage;
      run.events.push(this.event(stage, message));
    });
  }

  public event(stage: RunStage, message: string): RunEvent {
    return {
      at: new Date().toISOString(),
      stage,
      message,
    };
  }
}
