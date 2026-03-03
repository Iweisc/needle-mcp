import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverApiSurface, extractExports } from "../src/discover.js";
import { createTempDir } from "../src/util/tmp.js";

describe("extractExports", () => {
  it("extracts named function exports", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const file = join(dir, "test.ts");
      await writeFile(
        file,
        `export function createClient() {}\nexport async function fetchData() {}\n`,
      );
      const symbols = await extractExports(file);
      expect(symbols).toContain("createClient");
      expect(symbols).toContain("fetchData");
    } finally {
      await cleanup();
    }
  });

  it("extracts class, const, interface, and type exports", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const file = join(dir, "test.d.ts");
      await writeFile(
        file,
        [
          "export class MyProvider {}",
          "export const DEFAULT_CONFIG = {};",
          "export interface AppConfig {}",
          "export type UserId = string;",
          "export enum Status { Active, Inactive }",
        ].join("\n"),
      );
      const symbols = await extractExports(file);
      expect(symbols).toContain("MyProvider");
      expect(symbols).toContain("DEFAULT_CONFIG");
      expect(symbols).toContain("AppConfig");
      expect(symbols).toContain("UserId");
      expect(symbols).toContain("Status");
    } finally {
      await cleanup();
    }
  });

  it("extracts barrel re-exports", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const file = join(dir, "index.ts");
      await writeFile(
        file,
        `export { createServer, ServerConfig, useQuery as queryHook } from './server';\n`,
      );
      const symbols = await extractExports(file);
      expect(symbols).toContain("createServer");
      expect(symbols).toContain("ServerConfig");
      expect(symbols).toContain("queryHook");
    } finally {
      await cleanup();
    }
  });

  it("strips 'type' prefix from export { type Foo } syntax", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const file = join(dir, "index.ts");
      await writeFile(
        file,
        `export { type AuthState, type Config, createInstance } from './core';\n`,
      );
      const symbols = await extractExports(file);
      expect(symbols).toContain("AuthState");
      expect(symbols).toContain("Config");
      expect(symbols).toContain("createInstance");
      // Should NOT contain "type" as a symbol
      expect(symbols).not.toContain("type");
    } finally {
      await cleanup();
    }
  });

  it("extracts declare statements from .d.ts", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const file = join(dir, "types.d.ts");
      await writeFile(
        file,
        [
          "declare function init(config: Config): void;",
          "declare class SanityApp {}",
          "declare interface DelogxConfig {}",
        ].join("\n"),
      );
      const symbols = await extractExports(file);
      expect(symbols).toContain("init");
      expect(symbols).toContain("SanityApp");
      expect(symbols).toContain("DelogxConfig");
    } finally {
      await cleanup();
    }
  });
});

describe("discoverApiSurface", () => {
  it("reads package.json and finds entrypoints", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@test/pkg",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
        }),
      );
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(
        join(dir, "dist/index.d.ts"),
        "export function hello(): void;\nexport interface Config {}\n",
      );
      await writeFile(join(dir, "dist/index.js"), "// js");

      const surface = await discoverApiSurface(dir);
      expect(surface.packageName).toBe("@test/pkg");
      expect(surface.symbols).toContain("hello");
      expect(surface.symbols).toContain("Config");
      expect(surface.entrypoints.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("falls back to src/index.ts when no package.json", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "src/index.ts"),
        "export function myFunc() {}\nexport class MyClass {}\n",
      );

      const surface = await discoverApiSurface(dir);
      expect(surface.symbols).toContain("myFunc");
      expect(surface.symbols).toContain("MyClass");
    } finally {
      await cleanup();
    }
  });

  it("handles missing package.json gracefully", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const surface = await discoverApiSurface(dir);
      expect(surface.symbols).toEqual([]);
      expect(surface.entrypoints).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
