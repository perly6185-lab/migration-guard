import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaRepositoriesForRust } from "./repositoryRustAssessment.js";

test("repository assessment covers contracts, implementations and persistence mappers only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-repository-rust-"));
  try {
    const files: Record<string, string[]> = {
      "repository/ITaskRepository.java": ["package demo.repository;", "public interface ITaskRepository {", " Object findById(Long id);", " default Object fallback(Long id) { return findById(id); }", "}"],
      "repository/TaskRepositoryImpl.java": ["package demo.repository;", "public class TaskRepositoryImpl implements ITaskRepository {", " public Object findById(Long id) { return mapper.selectById(id); }", " public void delete(Long id) { mapper.deleteById(id); }", "}"],
      "mapper/TaskMapper.java": ["package demo.mapper;", "@Mapper", "public interface TaskMapper extends BaseMapper<Task> {", " Object selectDynamic(String sql);", "}"],
      "assembler/TaskMapper.java": ["package demo.assembler;", "@Mapper", "public interface TaskMapper {", " Object convert(Object source);", "}"]
    };
    for (const [name, lines] of Object.entries(files)) { const file = path.join(dir, "demo", name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, lines.join("\n")); }
    const report = await assessJavaRepositoriesForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    assert.equal(report.repositoryMethodCount, 4);
    assert.equal(report.methods.some((x) => x.repository.includes("assembler")), false);
    assert.equal(report.methods.find((x) => x.method === "selectDynamic")?.implementation, "generated-boundary");
    assert.equal(report.methods.find((x) => x.method === "selectDynamic")?.status, "blocked");
    assert.equal(report.methods.find((x) => x.method === "fallback")?.implementation, "default");
    assert.equal(report.methods.find((x) => x.method === "delete")?.operation, "delete");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
