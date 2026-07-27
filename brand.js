/* brand.js — the ONE wordmark placeholder + brand constants for the whole system.
   Use <eb-logo></eb-logo> anywhere. Optional attrs: size (CSS font-size).
   The logo lives ONLY here — never hand-write the wordmark spans on a page again.
   Concept: Plus Jakarta Sans caps (same face as every headline on the site), brand
   mint→aqua gradient on EASYBALI, white .SURF suffix.
   To rebrand a new location: change EB_BRAND + the colors/word below. */
(function () {
  const FONTS = 'https://fonts.googleapis.com/css2?family=Plus Jakarta Sans:wght@600;700&display=swap';
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
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      const base = `font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;text-transform:uppercase;background:linear-gradient(120deg,#61C9E6,#8CFFC1);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent`;
      const suffix = `<span style="font-weight:600;font-size:.72em;text-transform:none;color:${WHITE};-webkit-text-fill-color:${WHITE}">.surf</span>`;
      root.innerHTML =
        `<style>:host{display:inline-block;vertical-align:middle;line-height:1}</style>` +
        `<span style="${base};font-size:${size};letter-spacing:-.3px;display:inline-flex;align-items:baseline">EASYBALI${suffix}</span>`;
    }
  }
  if (!customElements.get('eb-logo')) customElements.define('eb-logo', EbLogo);

  window.EB_BRAND = { accent: ACCENT, accent2: '#3FD9E6', ink: '#08100d' };
})();
