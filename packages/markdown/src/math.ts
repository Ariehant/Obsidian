/**
 * TeX rendering with MathJax (SVG output), matching the plugin API's `renderMath`,
 * `loadMathJax` and `finishRenderMath`.
 *
 * MathJax is loaded on first use; it is large, and most notes have no math.
 */
type MathDocument = {
  convert(tex: string, options: { display: boolean }): HTMLElement;
  outputJax: { styleSheet(doc: unknown): HTMLStyleElement };
};

let mathDoc: MathDocument | null = null;
let loading: Promise<void> | null = null;
let stylesInstalled = new WeakSet<Document>();

export function loadMathJax(): Promise<void> {
  loading ??= (async () => {
    const [{ mathjax }, { TeX }, { SVG }, { browserAdaptor }, { RegisterHTMLHandler }, { AllPackages }] =
      await Promise.all([
        import('mathjax-full/js/mathjax.js'),
        import('mathjax-full/js/input/tex.js'),
        import('mathjax-full/js/output/svg.js'),
        import('mathjax-full/js/adaptors/browserAdaptor.js'),
        import('mathjax-full/js/handlers/html.js'),
        import('mathjax-full/js/input/tex/AllPackages.js'),
      ]);
    RegisterHTMLHandler(browserAdaptor());
    mathDoc = mathjax.document(document, {
      InputJax: new TeX({ packages: AllPackages }),
      OutputJax: new SVG({ fontCache: 'local' }),
    }) as unknown as MathDocument;
  })();
  return loading;
}

/** Renders TeX to an element. `loadMathJax()` must have resolved. */
export function renderMath(source: string, display: boolean): HTMLElement {
  if (!mathDoc) throw new Error('MathJax is not loaded; await loadMathJax() first.');
  try {
    return mathDoc.convert(source, { display });
  } catch (err) {
    const el = document.createElement('span');
    el.className = 'math-error';
    el.textContent = err instanceof Error ? err.message : String(err);
    return el;
  }
}

/** Installs MathJax's stylesheet in the document (once per document). */
export function finishRenderMath(doc: Document = document): void {
  if (!mathDoc || stylesInstalled.has(doc)) return;
  const sheet = mathDoc.outputJax.styleSheet(mathDoc);
  const style = doc.createElement('style');
  style.id = 'MJX-SVG-styles';
  style.textContent = sheet.textContent;
  doc.head.appendChild(style);
  stylesInstalled.add(doc);
}

/** @internal Test hook. */
export function resetMathStyles(): void {
  stylesInstalled = new WeakSet();
}
