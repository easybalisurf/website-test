/* brand.js — the ONE wordmark placeholder + brand constants for the whole system.
   Use <eb-logo></eb-logo> anywhere. Optional attrs: size (CSS font-size), animated="true".
   The logo lives ONLY here — never hand-write the wordmark spans on a page again.
   To rebrand a new location: change EB_BRAND + the EASY/SURF letter maps below. */
(function () {
  const FONTS = 'https://fonts.googleapis.com/css2?family=Antonio:wght@400;500;600;700&family=Righteous&display=swap';
  function ensure() {
    if (!document.querySelector('link[data-eb-fonts]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = FONTS; l.setAttribute('data-eb-fonts', '');
      document.head.appendChild(l);
    }
    if (!document.getElementById('eb-logo-kf')) {
      const s = document.createElement('style');
      s.id = 'eb-logo-kf';
      s.textContent = '@keyframes ebLogoWave{0%{transform:translateY(0)}2%{transform:translateY(-0.17em)}4.5%{transform:translateY(0.05em)}7%{transform:translateY(0)}100%{transform:translateY(0)}}';
      document.head.appendChild(s);
    }
  }
  // Mint→aqua gradient across EASYBALI, then SURF in a playful hand font, staggered (white).
  const EASY = [['E', '#61C9E6'], ['A', '#67D1E1'], ['S', '#6DD8DB'], ['Y', '#73E0D6'], ['B', '#7AE8D1'], ['A', '#80F0CC'], ['L', '#86F7C6'], ['I', '#8CFFC1']];
  const SURF = [['S', -0.05, 2.5], ['U', -0.16, 2.5], ['R', -0.27, 0], ['F', -0.14, -2.5]];

  class EbLogo extends HTMLElement {
    connectedCallback() {
      ensure();
      const size = this.getAttribute('size') || 'clamp(22px,5vw,30px)';
      const animated = this.getAttribute('animated') === 'true';
      const stacked = this.getAttribute('stack') === 'true';
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      const kf = `<style>@keyframes ebLogoWave{0%{transform:translateY(0)}2%{transform:translateY(-0.17em)}4.5%{transform:translateY(0.05em)}7%{transform:translateY(0)}100%{transform:translateY(0)}}:host{display:inline-block;vertical-align:middle;line-height:1}</style>`;

      if (stacked) {
        // Vertical lockup for square / round / favicon contexts. EASY and BALI are left-aligned
        // (E over B), share ONE continuous mint→aqua gradient across both rows (not per-row), and
        // surf keeps the same wavy per-letter offsets as the horizontal mark.
        const gradCss = `background:linear-gradient(120deg,${EASY[0][1]},${EASY[EASY.length - 1][1]});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent`;
        const surf = SURF.map(c => `<span style="display:inline-block;transform:translateY(${c[1]}em) rotate(${c[2]}deg)">${c[0]}</span>`).join('');
        root.innerHTML = kf +
          `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;font-family:'Antonio',sans-serif;font-weight:700;font-size:${size};letter-spacing:2px;line-height:.9;${gradCss}">` +
            `<span>EASY</span>` +
            `<span>BALI</span>` +
            `<span style="font-family:'Righteous',sans-serif;-webkit-text-fill-color:#fff;color:#fff;background:none;font-size:.5em;letter-spacing:2px;margin-top:.34em;align-self:flex-end;display:inline-flex">${surf}</span>` +
          `</span>`;
        return;
      }

      const easy = EASY.map((c, i) => `<span style="display:inline-block;color:${c[1]};transform-origin:center bottom${animated ? `;animation:ebLogoWave 15s ${(i * 0.12).toFixed(2)}s ease-in-out infinite` : ''}">${c[0]}</span>`).join('');
      const dot = '<span style="display:inline-block;width:0.16em;height:0.16em;border-radius:50%;background:#fff;margin:0 0.05em;align-self:baseline"></span>';
      const surf = SURF.map(c => `<span style="color:#fff;font-family:'Righteous',sans-serif;font-size:.9em;display:inline-block;transform:translateY(${c[1]}em) rotate(${c[2]}deg)">${c[0]}</span>`).join('');
      root.innerHTML = kf +
        `<span style="font-family:'Antonio',sans-serif;font-weight:700;font-size:${size};letter-spacing:2px;display:inline-flex;align-items:baseline;line-height:1">${easy}${dot}${surf}</span>`;
    }
  }
  if (!customElements.get('eb-logo')) customElements.define('eb-logo', EbLogo);

  window.EB_BRAND = { accent: '#61FFD0', accent2: '#3FD9E6', ink: '#08100d' };
})();
