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
  const WHITE = 'var(--eb-text-strong, #fff)';
  const ACCENT = '#7DE0C4';

  class EbLogo extends HTMLElement {
    connectedCallback() {
      ensure();
      const size = this.getAttribute('size') || 'clamp(22px,5vw,30px)';
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      const base = `font-family:'Plus Jakarta Sans',sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:-.2px`;
      root.innerHTML =
        `<style>:host{display:inline-block;vertical-align:middle;line-height:1}</style>` +
        `<span style="${base};font-size:${size};display:inline-flex;flex-direction:column;align-items:center;line-height:.92;background:linear-gradient(180deg,var(--eb-accent-3,#9AF0DC),var(--eb-accent,#7DE0C4) 68%,${WHITE} 68%,${WHITE});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent">` +
          `<span>EASY</span>` +
          `<span>BALI</span>` +
          `<span style="font-size:1em;display:inline-flex;align-items:flex-end;gap:.16em">` +
            `<span style="width:.2em;height:.2em;min-width:4px;min-height:4px;border-radius:50%;background:${WHITE};flex:none;-webkit-text-fill-color:${WHITE};margin-bottom:.06em"></span>SURF` +
          `</span>` +
        `</span>`;
    }
  }
  if (!customElements.get('eb-logo')) customElements.define('eb-logo', EbLogo);

  window.EB_BRAND = { accent: ACCENT, accent2: '#6EC6F0', ink: '#04231A' };
})();
