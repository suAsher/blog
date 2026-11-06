import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';

for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, go, yaml, xml, css, sql })) hljs.registerLanguage(name, language);
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'shell'], { languageName: 'bash' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

/** Optional enhancement: the article is already readable before this module loads. */
export function highlightArticle(body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>('pre code').forEach(code => {
    const language = /(?:^|\s)language-([^\s]+)/.exec(code.className)?.[1] || 'text';
    if ((code.textContent?.length || 0) <= 100_000 && hljs.getLanguage(language)) {
      hljs.highlightElement(code);
    }
  });
}
