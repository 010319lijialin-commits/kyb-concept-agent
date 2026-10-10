// 把 BRIEF.md 排成 A4 PDF：dist/brief.pdf。需要 Playwright（本机全局安装即可）。
//   node pdf.js [BRIEF.md] [dist/brief.pdf]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(ROOT, process.argv[2] || 'BRIEF.md');
const out = path.resolve(ROOT, process.argv[3] || 'dist/brief.pdf');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');

// 够用的 Markdown：标题、段落、有序/无序列表、表格、加粗
export function md(text) {
  const lines = text.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^#{1,3} /.test(l)) {
      const n = l.match(/^#+/)[0].length;
      html.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`);
      i++;
    } else if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      html.push(`<table><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`);
    } else if (/^(\d+\.|-) /.test(l)) {
      const ordered = /^\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) items.push(lines[i++].replace(/^(\d+\.|-) /, ''));
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (l.trim()) {
      html.push(`<p>${inline(l)}</p>`);
      i++;
    } else i++;
  }
  return html.join('\n');
}

const css = `
@page { size: A4; margin: 9mm 11mm 9mm 11mm; }
body { font-family: "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 8.4pt; line-height: 1.45; color: #13203a; }
h1 { font-family: "Noto Serif CJK SC", "Noto Serif SC", serif; font-size: 15pt; margin: 0 0 3pt; }
h2 { font-size: 10pt; margin: 6pt 0 2pt; border-bottom: 1px solid #d9dfe9; padding-bottom: 2pt; color: #1f5fd1; }
p { margin: 2pt 0; }
ul, ol { margin: 2pt 0; padding-left: 15pt; }
li { margin: 1pt 0; }
table { border-collapse: collapse; width: 100%; font-size: 7.8pt; margin: 3pt 0; }
th, td { border-bottom: 1px solid #d9dfe9; padding: 2pt 4pt; text-align: left; vertical-align: top; }
th { color: #4a5873; font-weight: 500; white-space: nowrap; }
td:first-child { white-space: nowrap; }
code { font-family: monospace; font-size: 8.5pt; }`;

if (process.argv[1]?.endsWith('pdf.js')) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}</style></head><body>${md(fs.readFileSync(src, 'utf8'))}</body></html>`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out.replace(/\.pdf$/, '.html');
  fs.writeFileSync(tmp, html);
  let chromium;
  try {
    const req = createRequire(import.meta.url);
    ({ chromium } = req('playwright'));
  } catch {
    const g = execSync('npm root -g').toString().trim();
    ({ chromium } = await import(pathToFileURL(path.join(g, 'playwright', 'index.mjs')).href));
  }
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(pathToFileURL(tmp).href);
  await p.pdf({ path: out, format: 'A4', printBackground: true });
  await b.close();
  console.log(`${path.relative(ROOT, out)} ← ${path.relative(ROOT, src)}`);
}
