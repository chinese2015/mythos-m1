import test from 'node:test';
import assert from 'node:assert/strict';

test('implementation plan renders Markdown headings, lists, links, tables and fenced code', async () => {
  const { renderPlanMarkdown } = await import('../plugins/mythos-console/public/plan-markdown.js');
  const html = renderPlanMarkdown('## 缺陷分析\n\n1. **Fix configuration**\n\n[AppConfig](src/AppConfig.java#L10)\n\n```java\nString value = "<safe>";\n```\n\n| Step | Result |\n| --- | --- |\n| Test | Pass |');
  assert.match(html, /<h2>缺陷分析<\/h2>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<strong>Fix configuration<\/strong>/);
  assert.match(html, /href="src\/AppConfig.java#L10"/);
  assert.match(html, /<pre><code class="language-java">String value = &quot;&lt;safe&gt;&quot;;/);
  assert.match(html, /<table>/);
});
test('implementation plan treats raw HTML as text and rejects executable link protocols', async () => {
  const { renderPlanMarkdown } = await import('../plugins/mythos-console/public/plan-markdown.js');
  const html = renderPlanMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[run](javascript:alert%281%29)\n\n[x](data:text/html,evil)');
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data):/i);
  assert.match(html, /&lt;script&gt;/);
});
