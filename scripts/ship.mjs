// Copies the built plugin into an Obsidian vault. Vault resolution order:
//   1. OBSIDIAN_VAULT env var (absolute path to the vault root)
//   2. .vault-path file in the repo root (gitignored, one line)
//   3. ../../ relative fallback (when the repo lives inside a vault, e.g. .tools/)
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveVault() {
  if (process.env.OBSIDIAN_VAULT) return resolve(process.env.OBSIDIAN_VAULT);
  const cfg = join(repo, '.vault-path');
  if (existsSync(cfg)) return resolve(readFileSync(cfg, 'utf8').trim());
  const relative = resolve(repo, '../..');
  if (existsSync(join(relative, '.obsidian'))) return relative;
  console.error(
    'Cannot find a vault. Set OBSIDIAN_VAULT, or write the vault path into a .vault-path file in the repo root.'
  );
  process.exit(1);
}

const vault = resolveVault();
const dest = join(vault, '.obsidian', 'plugins', 'task-board');
mkdirSync(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  cpSync(join(repo, f), join(dest, f));
}
console.log(`Installed to ${dest}`);
