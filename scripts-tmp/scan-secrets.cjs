const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'workers-dist', 'coverage', '.pnpm', 'scripts-tmp']);
const PATTERNS = [
  [/sk-[A-Za-z0-9_]{20,}/g, 'sk-key'],
  [/sb_publish_[A-Za-z0-9]+/g, 'supabase-publishable'],
  [/sb_secret_[A-Za-z0-9]+/g, 'supabase-secret'],
  [/eyJ[A-Za-z0-9_\-\.]{30,}/g, 'jwt'],
  [/supabase\.co/g, 'supabase-url'],
  [/(?:apiKey|api_key|API_KEY)\s*[:=]\s*['"][^'"\s\$\{]{15,}['"]/g, 'apiKey-literal'],
  [/password\s*[:=]\s*['"][^'"\$\{][^'"]{4,}['"]/gi, 'password-literal'],
];
const hits = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|json|md|env|html|css|yml|yaml|toml)$/.test(e.name) || e.name === '.env' || e.name.startsWith('.env')) {
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const lines = txt.split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const [re, label] of PATTERNS) {
          re.lastIndex = 0;
          const m = re.exec(line);
          if (m) hits.push(label + ' | ' + p + ':' + (i + 1) + ' | ' + line.trim().slice(0, 160));
        }
      });
    }
  }
}
walk(root);
console.log(hits.join('\n') || 'NO HITS');
console.log('total:', hits.length);
