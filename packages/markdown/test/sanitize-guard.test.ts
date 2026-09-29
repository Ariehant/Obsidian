// @vitest-environment happy-dom
// happy-dom breaks DOMPurify (it returns scripts untouched). The renderer must detect that
// and refuse to render, rather than insert unsanitised HTML.
import { expect, it } from 'vitest';
import { sanitizeHTMLToDom } from '../src/render';

it('fails closed when the sanitizer does not work', () => {
  expect(() => sanitizeHTMLToDom('<p>x</p>')).toThrow(/sanitizer is not working/);
});
