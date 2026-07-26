/* brand.js — the ONE wordmark placeholder + brand constants for the whole system.
   Use <eb-logo></eb-logo> anywhere. Optional attrs: size (CSS font-size), animated="true"
   (kept for API compat; unused here — this mark has no motion), horizontal="true" (single-line,
   for wide nav/footer bars) — default is the two-line lockup used for square/round contexts
   (favicon, avatar) but reads fine in a normal nav bar too.
   The logo lives ONLY here — never hand-write the wordmark spans on a page again.
   Concept: Poppins wordmark "easybali" + accent ".surf" suffix (design-system alt #2), single
   line by default; pass square="true" for the two-line favicon/avatar lockup.
   To rebrand a new location: change EB_BRAND + the colors/word below. */
(function () {
  const FONTS = 'https://fonts.googleapis.com/css2?family=Poppins:wght@600;700;800&display=swap';
  function ensure() {
    if (!document.querySelector('link[data-eb-fonts]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = FONTS; l.setAttribute('data-eb-fonts', '');
      document.head.appendChild(l);
    }
  }
  const WHITE = '#fff';
  const ACCENT = '#61FFD0';

  class EbLogo extends HTMLElement {
    connectedCallback() {
      ensure();
      const size = this.getAttribute('size') || 'clamp(22px,5vw,30px)';
      const square = this.getAttribute('square') === 'true';
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      const base = `font-family:'Poppins',sans-serif;font-weight:700;background:linear-gradient(120deg,#61C9E6,#8CFFC1);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent`;
      const suffix = `<span style="font-weight:600;font-size:.7em;color:${WHITE};-webkit-text-fill-color:${WHITE}">.surf</span>`;

      if (square) {
        // Two-line lockup for square/round contexts only (favicon, avatar).
        root.innerHTML =
          `<style>:host{display:inline-block;vertical-align:middle;line-height:.95}</style>` +
          `<span style="${base};font-size:${size};letter-spacing:-.2px;display:inline-flex;flex-direction:column;align-items:flex-start">` +
            `<span>easy</span>` +
            `<span>bali<span style="font-weight:600;color:${WHITE};-webkit-text-fill-color:${WHITE}">.surf</span></span>` +
          `</span>`;
        return;
      }

      // Single-line wordmark — the canonical mark everywhere else (nav, footer, body copy).
      root.innerHTML =
        `<style>:host{display:inline-block;vertical-align:middle;line-height:1}</style>` +
        `<span style="${base};font-size:${size};letter-spacing:-.2px;display:inline-flex;align-items:baseline">easybali${suffix}</span>`;
    }
  }
  if (!customElements.get('eb-logo')) customElements.define('eb-logo', EbLogo);

  window.EB_BRAND = { accent: ACCENT, accent2: '#3FD9E6', ink: '#08100d' };
})();
