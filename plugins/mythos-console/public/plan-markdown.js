import MarkdownIt from './vendor/markdown-it.esm.min.mjs';

// Keep model/user HTML inert and use markdown-it's default URL validation.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
markdown.disable('image');
export function renderPlanMarkdown(text) { return markdown.render(String(text ?? '')); }
