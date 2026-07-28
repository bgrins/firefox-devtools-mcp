// Voltro marketplace listing: a card grid built from VOLTRO.products, where
// each product is [name, sizeInches, resolution, price, rating, reviews, inStock].

document.title = 'Voltro — Computer Monitors';

const BRANDS = [...new Set(VOLTRO.products.map((p) => p[0].split(' ')[0]))].slice(0, 6);

document.body.insertAdjacentHTML(
  'afterbegin',
  `
  <header>
    <b>Voltro</b>
    <input placeholder="Search Voltro" aria-label="Search">
    <span>Hello, sign in</span>
    <span>Orders</span>
    <span>Cart (0)</span>
  </header>
  <nav>
    <span>All</span><span>Today's Deals</span><span>Electronics</span>
    <span>Computers</span><span>Monitors</span><span>Gift Cards</span><span>Customer Service</span>
  </nav>
  <div class="promo">${VOLTRO.promo}</div>
  <main>
    <aside>
      <h4>Department</h4>
      Monitors<br>Laptops<br>Desktops<br>Accessories
      <h4>Screen Size</h4>
      <label><input type="checkbox"> 24 inch</label>
      <label><input type="checkbox"> 27 inch</label>
      <label><input type="checkbox"> 32 inch</label>
      <h4>Resolution</h4>
      <label><input type="checkbox"> 1080p (FHD)</label>
      <label><input type="checkbox"> 1440p (QHD)</label>
      <label><input type="checkbox"> 4K (UHD)</label>
      <h4>Brand</h4>
      ${BRANDS.map((b) => `<label><input type="checkbox"> ${b}</label>`).join('')}
      <h4>Availability</h4>
      <label><input type="checkbox"> Include out of stock</label>
    </aside>
    <section style="flex:1">
      <div id="toolbar">
        <h1>Computer Monitors</h1>
        <span>1–${VOLTRO.products.length} of ${VOLTRO.products.length} results</span>
        <label>Sort by:
          <select aria-label="Sort by">
            <option>Featured</option>
            <option>Price: Low to High</option>
            <option>Price: High to Low</option>
            <option>Avg. Customer Review</option>
          </select>
        </label>
      </div>
      <ul id="grid" role="list" aria-label="Search results"></ul>
      <div id="pagination">Page: <b>1</b> <a href="#">2</a> <a href="#">3</a> <a href="#">Next →</a></div>
    </section>
  </main>
  <footer>
    &copy; 2026 Voltro Marketplace, Inc. Prices and availability are subject to change.
    · Conditions of Use · Privacy Notice · Interest-Based Ads · Sell on Voltro ·
    Careers
  </footer>
  <div id="cookie-banner" role="dialog" aria-label="Cookie consent">
    <span>We use cookies to enhance your Voltro experience and for measurement.
      See our Cookie Notice. <a href="#" style="color:#9dc4ff">Manage preferences</a></span>
    <button onclick="document.getElementById('cookie-banner').remove()">Accept all cookies</button>
    <button onclick="document.getElementById('cookie-banner').remove()">Decline non-essential</button>
  </div>
`
);

const RES_LABEL = {
  '1080p': 'FHD 1920x1080',
  '1440p': 'QHD 2560x1440',
  '4K': '4K UHD 3840x2160',
};

const grid = document.getElementById('grid');
VOLTRO.products.forEach(([name, size, res, price, rating, reviews, inStock], i) => {
  const card = document.createElement('li');
  card.className = 'card';
  const hue = (name.length * 37 + name.charCodeAt(0) * 11) % 360;
  const wasPrice = (price * 1.22 + 15).toFixed(2);
  card.innerHTML = `
    ${i === 2 || i === 9 ? '<span class="sponsored">Sponsored</span>' : ''}
    <svg viewBox="0 0 160 90" class="thumb" role="img" aria-label="${name} product photo">
      <rect width="160" height="90" fill="hsl(${hue},18%,90%)"/>
      <rect x="22" y="8" width="116" height="62" rx="3" fill="#1b1f27"/>
      <rect x="72" y="72" width="16" height="8" fill="#444"/>
      <rect x="56" y="80" width="48" height="4" fill="#666"/>
    </svg>
    <div class="name"><a href="#">${name}</a></div>
    <div class="attrs">${size}" ${RES_LABEL[res]} · IPS · ${res === '4K' ? '60Hz' : '144Hz'} · HDMI/DP</div>
    <div class="rating" aria-label="${rating} out of 5 stars, ${reviews.toLocaleString()} ratings">
      ${'★'.repeat(Math.round(rating))}${'☆'.repeat(5 - Math.round(rating))}
      <span style="color:#555">${rating} (${reviews.toLocaleString()})</span></div>
    <div class="price">$${price.toFixed(2)}
      ${i % 4 !== 3 ? `<s>$${wasPrice}</s> <span class="save">Save ${Math.round((1 - price / wasPrice) * 100)}%</span>` : ''}
    </div>
    <div class="permo">or $${(price / 12).toFixed(2)}/mo for 12 mo</div>
    <div class="fulfill">${i % 3 ? 'FREE shipping — get it Fri, Jul 31' : 'Pickup today at Downtown'}</div>
    <div class="${inStock ? 'stock-in' : 'stock-out'}">${
      inStock
        ? 'In stock — ships within 24 hours.'
        : 'Temporarily out of stock. No restock date available.'
    }</div>
    <button>Add to Cart</button>
  `;
  grid.appendChild(card);
});

// Below the mobile breakpoint the department bar is replaced by a menu button;
// the panel is built on demand, so the desktop markup is left alone.
const MOBILE = window.matchMedia('(max-width: 600px)');
const MOBILE_LINKS = [
  ['All Departments', 'index.html'],
  ['Deals of the Day', 'deals.html'],
  ['Desk Setup', 'desk-setup.html'],
  ['Your Basket', 'basket.html'],
  ['Customer Service', '#'],
];

function applyMobileNav() {
  const header = document.querySelector('header');
  const button = document.getElementById('menubtn');
  if (!MOBILE.matches) {
    if (button) button.remove();
    const panel = document.getElementById('mobilemenu');
    if (panel) panel.remove();
    return;
  }
  if (button) return;
  const toggle = document.createElement('button');
  toggle.id = 'menubtn';
  toggle.type = 'button';
  toggle.textContent = 'Menu';
  toggle.setAttribute('aria-expanded', 'false');
  header.prepend(toggle);
  const panel = document.createElement('nav');
  panel.id = 'mobilemenu';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Departments');
  panel.innerHTML = MOBILE_LINKS.map(
    ([label, href]) => `<a href="${href}">${label}</a>`
  ).join('');
  header.insertAdjacentElement('afterend', panel);
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
}

applyMobileNav();
MOBILE.addEventListener('change', applyMobileNav);
window.addEventListener('resize', applyMobileNav);
