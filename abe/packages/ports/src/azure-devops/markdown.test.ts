import { describe, expect, test } from 'bun:test';
import { decodeMarkdown, encodeMarkdown, htmlToMarkdown } from './markdown';

describe('htmlToMarkdown: Azure Boards html as markdown', () => {
  test.each([
    ['', ''],
    ['<div>plain text</div>', 'plain text'],
    ['<p>one</p><p>two</p>', 'one\n\ntwo'],
    ['<div>a<br>b</div>', 'a\n\nb'],
    ['<b>bold</b> and <strong>strong</strong>', '**bold** and **strong**'],
    ['<i>it</i> and <em>em</em>', '*it* and *em*'],
    ['<h1>Title</h1><h3>Why</h3>', '# Title\n\n### Why'],
    ['<ul><li>one</li><li>two</li></ul>', '- one\n- two'],
    ['<ol><li>first</li><li>second</li></ol>', '1. first\n2. second'],
    ['<ul><li>top<ul><li>nested</li></ul></li></ul>', '- top\n    - nested'],
    ['<a href="https://example.test/spec">Spec</a>', '[Spec](https://example.test/spec)'],
    ['<code>npm test</code>', '`npm test`'],
    ['<pre><code>let a = 1;\nlet b = 2;</code></pre>', '```\nlet a = 1;\nlet b = 2;\n```'],
    ['<del>gone</del>, <s>gone</s>', '~~gone~~, ~~gone~~'],
    ['<span style="text-decoration:line-through">old</span>', '~~old~~'],
    ['<a href="#" data-vss-mention="version:2.0,u-sam">@Sam Sample</a> look', '@Sam Sample look'],
    ['run `npm test` in my_folder', 'run `npm test` in my_folder'],
    ['<div>a&nbsp;b &amp; c &lt;d&gt;</div>', 'a b & c <d>'],
    ['<div>   </div>', ''],
    ['<p>one</p><p></p><p></p><p>two</p>', 'one\n\ntwo'],
    [
      '<table><tr><td>Name</td><td>Value</td></tr><tr><td>a|b</td><td>2<br>lines</td></tr></table>',
      '| Name | Value |\n| --- | --- |\n| a\\|b | 2 lines |',
    ],
  ])('%j', (html, markdown) => {
    expect(htmlToMarkdown(html)).toBe(markdown);
  });
});

describe('markdown as Azure Boards keeps it', () => {
  test('< and > go as entities and come back as typed', () => {
    const text = 'x < y && <b> > z';

    expect(encodeMarkdown(text)).toBe('x &lt; y && &lt;b&gt; &gt; z');
    expect(decodeMarkdown(encodeMarkdown(text))).toBe(text);
  });

  test('its other entities read as characters', () => {
    expect(decodeMarkdown('&quot;a&quot; &#39;b&#39; &amp;c ')).toBe(`"a" 'b' &c`);
  });
});
