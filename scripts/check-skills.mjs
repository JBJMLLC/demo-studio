import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = resolve(root, "skills");
const expectedSkills = [
  "demo-brief",
  "demo-storyboard",
  "demo-narration",
  "demo-story-review",
  "browser-demo-recording",
  "demo-audit",
  "demo-production-pipeline"
];
const issues = [];

function fail(file, rule) {
  issues.push(`${relative(root, file)} [${rule}]`);
}

function yamlValue(source, key) {
  const match = source.match(new RegExp(`^  ${key}:\\s*"([^"\\n]*)"\\s*$`, "m"));
  return match?.[1] ?? null;
}

function containedPath(base, target) {
  const absolute = resolve(base, target);
  return absolute === root || absolute.startsWith(`${root}${sep}`) ? absolute : null;
}

if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
  process.stderr.write("Skills directory is missing.\n");
  process.exit(1);
}

const actualSkills = readdirSync(skillsRoot).filter((entry) => {
  const path = resolve(skillsRoot, entry);
  return statSync(path).isDirectory();
}).sort();
const expected = [...expectedSkills].sort();
if (existsSync(resolve(root, '.mcp.json'))) issues.push('.mcp.json [skills-plugin-must-not-autostart-unbuilt-runtime]');
const plugin = JSON.parse(readFileSync(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
if (plugin.mcpServers) issues.push('.claude-plugin/plugin.json [runtime-registration-must-be-explicit]');
if (JSON.stringify(actualSkills) !== JSON.stringify(expected)) {
  issues.push("skills [skill-set-must-match-public-contract]");
}

const seenNames = new Set();
const toolkit = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const marketplace = JSON.parse(readFileSync(resolve(root, '.claude-plugin/marketplace.json'), 'utf8'));
if (plugin.version !== toolkit.version) issues.push('.claude-plugin/plugin.json [version-must-match-toolkit-package]');
if (marketplace.metadata?.version !== toolkit.version) issues.push('.claude-plugin/marketplace.json [metadata-version-must-match-toolkit-package]');
if (marketplace.name !== plugin.name || !Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1
  || marketplace.plugins.some((entry) => entry.name !== plugin.name || entry.version !== toolkit.version)) {
  issues.push('.claude-plugin/marketplace.json [plugin-versions-must-match-toolkit-package]');
}

for (const skillName of expectedSkills) {
  const skillDir = resolve(skillsRoot, skillName);
  const entrypoint = resolve(skillDir, "SKILL.md");
  const interfaceFile = resolve(skillDir, "agents/openai.yaml");
  if (!existsSync(entrypoint)) {
    fail(entrypoint, "missing-entrypoint");
    continue;
  }
  if (!existsSync(interfaceFile)) {
    fail(interfaceFile, "missing-openai-interface");
    continue;
  }

  const markdown = readFileSync(entrypoint, "utf8");
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    fail(entrypoint, "invalid-frontmatter");
    continue;
  }
  const name = frontmatter[1].match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1] ?? null;
  const description = frontmatter[1].match(/^description:\s*(.+?)\s*$/m)?.[1] ?? "";
  if (name !== skillName) fail(entrypoint, "name-must-match-directory");
  if (!description || description === "\"\"" || description === "''") fail(entrypoint, "missing-description");
  if (name && seenNames.has(name)) fail(entrypoint, "duplicate-name");
  if (name) seenNames.add(name);

  const ui = readFileSync(interfaceFile, "utf8");
  const displayName = yamlValue(ui, "display_name");
  const shortDescription = yamlValue(ui, "short_description");
  const defaultPrompt = yamlValue(ui, "default_prompt");
  if (!displayName) fail(interfaceFile, "display-name-must-be-quoted");
  if (!shortDescription || shortDescription.length < 25 || shortDescription.length > 64) {
    fail(interfaceFile, "short-description-must-be-quoted-and-25-to-64-characters");
  }
  if (!defaultPrompt || !defaultPrompt.includes(`$${skillName}`)) fail(interfaceFile, "default-prompt-must-name-skill");
  if (/allow_implicit_invocation:\s*false/.test(ui)) fail(interfaceFile, "implicit-invocation-must-remain-enabled");
  if (/TODO|FIXME|<skill-name>|<description>/i.test(markdown)) fail(entrypoint, "unfinished-scaffold-text");

  for (const link of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const rawTarget = link[1].trim();
    if (/^(?:[a-z]+:|\/\/|#)/i.test(rawTarget)) continue;
    const localTarget = decodeURIComponent(rawTarget.split("#", 1)[0]);
    const resolvedTarget = containedPath(dirname(entrypoint), localTarget);
    if (!resolvedTarget || !existsSync(resolvedTarget)) fail(entrypoint, "broken-or-escaping-local-link");
  }
}

if (issues.length) {
  process.stderr.write(`Skill check failed (${issues.length} issue(s)):\n${issues.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Validated ${expectedSkills.length} composable skills, UI metadata, and local links.\n`);
