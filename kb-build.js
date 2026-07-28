// kb-build.js —— 遍历主站静态 HTML，抽取标题/描述/标题层级/正文，
// 生成 supabase/functions/_shared/kb.json，供 ai-search / ai-chat 检索与 RAG。
// 用法: node kb-build.js [htmlDir]   默认 htmlDir = "."
// 依赖: npm i node-html-parser
// 说明: 不改数据库/其它函数；纯本地生成静态知识库。

const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');

const dir = process.argv[2] || '.';
/* MALL · geo — 分级正文抽取:核心页 1500 字、FAQ 页全量(4000)、其余 600 字,超限加截断标记 */
const CORE_PAGES = new Set([
  'about-v62.html',
  'solutions-index-v62.html',
  'solutions-light-kitchen-v62.html',
  'for-industrial-v62.html',
  'for-foodservice-v62.html',
  'for-retail-v62.html',
  'products-sauces-v62.html',
  'products-staples-v62.html',
  'products-snacks-v62.html',
  'products-mains-v62.html',
]);
function maxTextFor(f) {
  if (f === 'faq-v62.html') return 4000; // FAQ 是 AI 客服主要问答源,全量收录
  if (f === 'index.html') return 2500; // 首页高配额:含公司简介 + 联系我们 GEO 区块(中英双语)
  if (CORE_PAGES.has(f) || f.startsWith('capabilities-')) return 1500;
  return 600;
}
const MAX_HEADINGS = 8;

// 全站重复的顶部导航 + 产品大菜单样板（结尾固定为「查看全部酱料See all sauces →」），
// 从正文开头整体剔除，既提升检索相关性又减小体积。无此前缀的页面（如法务页）不受影响。
function stripBoilerplate(s) {
  let out = s.replace(/^[\s\S]*?查看全部酱料See all sauces\s*→?\s*/, '');
  /* MALL · geo — 仅当邮箱出现在开头 300 字内(顶部导航条特征)才整体剔除,避免误伤正文中的联系邮箱(如 FAQ) */
  const m = out.match(/@foodvio\.com\S*/);
  if (m && m.index < 300) out = out.slice(m.index + m[0].length);
  return out;
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith('.html'))
  .sort();

const kb = [];
for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  const root = parse(html, { comment: false });
  // 去掉脚本/样式/svg + 全站重复的导航/页眉/页脚（既减体积又提升检索相关性）
  root
    .querySelectorAll('script, style, noscript, svg, template, nav, header, footer')
    .forEach((n) => n.remove());

  const title = clean(
    root.querySelector('title')?.text || root.querySelector('h1')?.text || f
  );
  const description = clean(
    root.querySelector('meta[name="description"]')?.getAttribute('content') || ''
  );
  const headings = root
    .querySelectorAll('h1, h2, h3')
    .map((h) => clean(h.text))
    .filter(Boolean)
    .slice(0, MAX_HEADINGS);

  const main = root.querySelector('main') || root.querySelector('body');
  let full = clean(stripBoilerplate(main ? main.structuredText : root.text));
  /* MALL · geo — index.html:公司简介与联系我们区块优先进入抽取窗口,其余正文随后 */
  if (f === 'index.html') {
    const geo = ['#company-intro', '#contact-info']
      .map((sel) => root.querySelector(sel))
      .filter(Boolean)
      .map((n) => clean(n.structuredText))
      .join(' ');
    if (geo) full = clean(geo + ' ' + full);
  }
  const cap = maxTextFor(f);
  const text = full.length > cap ? full.slice(0, cap) + '…' : full;

  kb.push({ url: f, title, description, headings, text });
}

const outDir = path.join('supabase', 'functions', '_shared');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'kb.json');
fs.writeFileSync(outPath, JSON.stringify(kb), 'utf8');

console.log(`KB built: ${kb.length} pages -> ${outPath} (${fs.statSync(outPath).size} bytes)`);
