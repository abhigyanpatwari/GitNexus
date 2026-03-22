import { getSyntaxLanguageFromFilename } from 'gitnexus-shared';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import Prism from 'prismjs';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import zig from 'react-syntax-highlighter/dist/esm/languages/prism/zig';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import xml from 'react-syntax-highlighter/dist/esm/languages/prism/xml-doc';
import makefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-xml-doc';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-zig';

const register = (() => {
  let done = false;
  return () => {
    if (done) return;
    done = true;

    SyntaxHighlighter.registerLanguage('javascript', javascript);
    SyntaxHighlighter.registerLanguage('jsx', jsx);
    SyntaxHighlighter.registerLanguage('typescript', typescript);
    SyntaxHighlighter.registerLanguage('tsx', tsx);
    SyntaxHighlighter.registerLanguage('python', python);
    SyntaxHighlighter.registerLanguage('ruby', ruby);
    SyntaxHighlighter.registerLanguage('java', java);
    SyntaxHighlighter.registerLanguage('go', go);
    SyntaxHighlighter.registerLanguage('rust', rust);
    SyntaxHighlighter.registerLanguage('c', c);
    SyntaxHighlighter.registerLanguage('cpp', cpp);
    SyntaxHighlighter.registerLanguage('csharp', csharp);
    SyntaxHighlighter.registerLanguage('php', php);
    SyntaxHighlighter.registerLanguage('kotlin', kotlin);
    SyntaxHighlighter.registerLanguage('swift', swift);
    SyntaxHighlighter.registerLanguage('zig', zig);
    SyntaxHighlighter.registerLanguage('json', json);
    SyntaxHighlighter.registerLanguage('yaml', yaml);
    SyntaxHighlighter.registerLanguage('markdown', markdown);
    SyntaxHighlighter.registerLanguage('markup', markup);
    SyntaxHighlighter.registerLanguage('css', css);
    SyntaxHighlighter.registerLanguage('bash', bash);
    SyntaxHighlighter.registerLanguage('sql', sql);
    SyntaxHighlighter.registerLanguage('xml', xml);
    SyntaxHighlighter.registerLanguage('makefile', makefile);
    SyntaxHighlighter.registerLanguage('docker', docker);
  };
})();

register();

export { SyntaxHighlighter };

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const codeTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': {
    ...vscDarkPlus['pre[class*="language-"]'],
    background: '#0a0a10',
    margin: 0,
    fontSize: '13px',
    lineHeight: '1.6',
  },
  'code[class*="language-"]': {
    ...vscDarkPlus['code[class*="language-"]'],
    background: 'transparent',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
  },
};

export const getSyntaxLanguage = (filePath: string | undefined): string =>
  filePath ? getSyntaxLanguageFromFilename(filePath) : 'text';

export const highlightCodeHtml = (code: string, language: string): string => {
  const grammar = (Prism.languages as Record<string, Prism.Grammar | undefined>)[language];
  if (!grammar) return escapeHtml(code);
  return Prism.highlight(code, grammar, language);
};
