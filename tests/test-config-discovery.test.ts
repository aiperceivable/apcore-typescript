import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Config, discoverConfigFile } from '../src/config.js';

const VALID_YAML = `
version: "0.8.0"
extensions:
  root: ./extensions
  auto_discover: false
schema:
  root: ./schemas
acl:
  root: ./acl
  default_effect: deny
project:
  name: discovery-test
`.trim();

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-discovery-'));
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('discoverConfigFile', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    vi.stubEnv('APCORE_CONFIG_FILE', '');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanDir(tmpDir);
    vi.unstubAllEnvs();
  });

  it('returns APCORE_CONFIG_FILE env var path when set', () => {
    const configPath = path.join(tmpDir, 'custom.yaml');
    fs.writeFileSync(configPath, VALID_YAML);
    vi.stubEnv('APCORE_CONFIG_FILE', configPath);
    const result = discoverConfigFile();
    expect(result).toBe(configPath);
  });

  it('returns null when no config file is found', () => {
    vi.stubEnv('APCORE_CONFIG_FILE', '');
    // tmpDir has no config files; HOME is set to a non-existent dir
    vi.stubEnv('HOME', path.join(tmpDir, 'nonexistent_home'));
    const result = discoverConfigFile();
    expect(result).toBeNull();
  });

  it('returns project.yaml when present in cwd', () => {
    vi.stubEnv('APCORE_CONFIG_FILE', '');
    fs.writeFileSync(path.join(tmpDir, 'project.yaml'), VALID_YAML);
    const result = discoverConfigFile();
    expect(result).toBe('project.yaml');
  });

  it('returns project.yml when present in cwd and project.yaml absent', () => {
    vi.stubEnv('APCORE_CONFIG_FILE', '');
    fs.writeFileSync(path.join(tmpDir, 'project.yml'), VALID_YAML);
    const result = discoverConfigFile();
    expect(result).toBe('project.yml');
  });

  it('returns apcore.yaml when present in cwd', () => {
    vi.stubEnv('APCORE_CONFIG_FILE', '');
    fs.writeFileSync(path.join(tmpDir, 'apcore.yaml'), VALID_YAML);
    const result = discoverConfigFile();
    expect(result).toBe('apcore.yaml');
  });

  it('returns apcore.yml when it is the only cwd candidate', () => {
    vi.stubEnv('APCORE_CONFIG_FILE', '');
    fs.writeFileSync(path.join(tmpDir, 'apcore.yml'), VALID_YAML);
    const result = discoverConfigFile();
    expect(result).toBe('apcore.yml');
  });

  it('env var takes priority over cwd file', () => {
    const envFile = path.join(tmpDir, 'env.yaml');
    fs.writeFileSync(envFile, VALID_YAML);
    fs.writeFileSync(path.join(tmpDir, 'project.yaml'), VALID_YAML);
    vi.stubEnv('APCORE_CONFIG_FILE', envFile);
    const result = discoverConfigFile();
    expect(result).toBe(envFile);
  });
});

describe('Config.load discovery integration', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    vi.stubEnv('APCORE_CONFIG_FILE', '');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanDir(tmpDir);
    vi.unstubAllEnvs();
  });

  it('returns fromDefaults() when no file found', () => {
    vi.stubEnv('HOME', path.join(tmpDir, 'nonexistent_home'));
    const config = Config.load();
    expect(config).toBeInstanceOf(Config);
  });

  it('loads discovered file and reads project name', () => {
    vi.stubEnv('APCORE_CONFIG_FILE', '');
    const configPath = path.join(tmpDir, 'project.yaml');
    fs.writeFileSync(configPath, VALID_YAML);
    const config = Config.load();
    expect(config.get('project.name')).toBe('discovery-test');
  });

  it('loads file from APCORE_CONFIG_FILE env var', () => {
    const configPath = path.join(tmpDir, 'custom.yaml');
    fs.writeFileSync(configPath, VALID_YAML);
    vi.stubEnv('APCORE_CONFIG_FILE', configPath);
    const config = Config.load();
    expect(config.get('project.name')).toBe('discovery-test');
  });

  it('explicit path still works', () => {
    const configPath = path.join(tmpDir, 'explicit.yaml');
    fs.writeFileSync(configPath, VALID_YAML);
    const config = Config.load(configPath);
    expect(config.get('project.name')).toBe('discovery-test');
  });
});
