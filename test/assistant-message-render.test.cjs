const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const front = path.resolve(__dirname, '../../estacionamiento-front-demo');
const req = createRequire(path.join(front, 'package.json'));
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const ts = req('typescript');
const source = fs.readFileSync(path.join(front, 'src/components/assistant/assistant-widget.tsx'), 'utf8');
const component = source.slice(source.indexOf('function AnimatedText('), source.indexOf('function ScopedAssistant('));
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(`import { Fragment } from 'react';\nexport ${component}`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText, { exports: exportsObject, require: req });

test('streaming y respuestas finales interpretan negritas sin mostrar asteriscos', () => {
  const html = renderToStaticMarkup(React.createElement(exportsObject.AnimatedText, { text: 'Entrá en **Comprobantes**.\n\nAhí podés elegir QR.', animate: false }));
  assert.match(html, /<strong>Comprobantes<\/strong>/);
  assert.doesNotMatch(html, /\*\*|ai-word/);
  assert.match(html, /\n\n/);
});

test('el texto del modelo se escapa: no interpreta HTML', () => {
  const html = renderToStaticMarkup(React.createElement(exportsObject.AnimatedText, { text: '<script>alert(1)</script>', animate: false }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
