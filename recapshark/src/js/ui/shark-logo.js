// Read the bundled asset URL straight off the SVG element itself.
// Vite rewrites the <image href> at build time, so this works in both dev
// and prod. Hardcoding 'art/logo/...' here would 404 on prod since Vite
// only rewrites paths in HTML/CSS, not JS string literals.
const _navImg = document.getElementById('navSharkSvgImg');
const _src = _navImg && _navImg.getAttribute('href');
if (_src) {
  const probe = new Image();
  probe.onload = () => {
    const r = probe.naturalWidth / probe.naturalHeight;
    document.getElementById('sharkSvg').setAttribute('width', 22 * r);
    document.getElementById('sharkSvgImg').setAttribute('width', 22 * r);
    document.getElementById('navSharkSvg').setAttribute('width', 22 * r);
    document.getElementById('navSharkSvgImg').setAttribute('width', 22 * r);
  };
  probe.src = _src;
}
