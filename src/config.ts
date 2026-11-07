import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** `bar`: the context bar before Pi's segment. `underline`: Pi's segment underlined, no extra columns. */
export type FooterStyle = "bar" | "underline";

export interface PrecompactConfig {
  readonly footer: FooterStyle;
  /** The fade-in of the bar or the underline after the first measured response. */
  readonly motion: boolean;
}

export const DEFAULT_CONFIG: PrecompactConfig = { footer: "bar", motion: true };
export const CONFIG_FILE = "precompact.json";
export const FOOTER_ENV = "PI_PRECOMPACT_FOOTER";
export const MOTION_ENV = "PI_PRECOMPACT_MOTION";

export interface LoadedConfig {
  readonly config: PrecompactConfig;
  /** The files that were read, in order; missing files are skipped silently. */
  readonly paths: readonly string[];
  readonly warnings: readonly string[];
}

export interface LoadConfigOptions {
  readonly cwd: string;
  /** Project files are honoured only for trusted projects. */
  readonly projectTrusted: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly agentDir?: string;
}

/** The global file, then the project file of a trusted project. */
export function configPaths(options: LoadConfigOptions): string[] {
  const global = join(options.agentDir ?? getAgentDir(), "extensions", CONFIG_FILE);
  return options.projectTrusted ? [global, join(options.cwd, CONFIG_DIR_NAME, CONFIG_FILE)] : [global];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFooterStyle(value: unknown): value is FooterStyle {
  return value === "bar" || value === "underline";
}

type Draft = { footer: FooterStyle; motion: boolean };

function applyFile(config: Draft, values: Record<string, unknown>, source: string, warnings: string[]) {
  for (const key of Object.keys(values)) {
    if (key !== "footer" && key !== "motion") warnings.push(`${source}: unknown key "${key}"`);
  }
  if (values.footer !== undefined) {
    if (isFooterStyle(values.footer)) config.footer = values.footer;
    else warnings.push(`${source}: "footer" must be "bar" or "underline"`);
  }
  if (values.motion !== undefined) {
    if (typeof values.motion === "boolean") config.motion = values.motion;
    else warnings.push(`${source}: "motion" must be true or false`);
  }
}

function applyEnvironment(config: Draft, env: NodeJS.ProcessEnv, warnings: string[]) {
  const footer = env[FOOTER_ENV]?.trim().toLowerCase();
  if (footer) {
    if (isFooterStyle(footer)) config.footer = footer;
    else warnings.push(`${FOOTER_ENV} must be bar or underline`);
  }
  const motion = env[MOTION_ENV]?.trim().toLowerCase();
  if (motion) {
    if (motion === "off" || motion === "on") config.motion = motion === "on";
    else warnings.push(`${MOTION_ENV} must be on or off`);
  }
}

async function readJson(path: string): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    return { error: error instanceof Error ? error.message : "unreadable" };
  }
}

/**
 * Defaults, then the global and the trusted project file, then the environment. An invalid value
 * keeps the previous one and adds a warning; a broken file is skipped as a whole.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const config: Draft = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  const paths: string[] = [];
  for (const path of configPaths(options)) {
    const { value, error } = await readJson(path);
    if (error !== undefined) warnings.push(`Could not read ${path}: ${error}`);
    if (value === undefined) continue;
    paths.push(path);
    if (isRecord(value)) applyFile(config, value, path, warnings);
    else warnings.push(`${path} must contain a JSON object`);
  }
  applyEnvironment(config, options.env ?? process.env, warnings);
  return { config, paths, warnings };
}
