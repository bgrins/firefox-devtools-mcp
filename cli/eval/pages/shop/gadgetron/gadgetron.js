// Gadgetron spec index: every SKU is one row of the comparison table. Prices
// live in the row's data-price attribute as well as the cell text.

const NATIVE = {
  '1080p': '1920x1080',
  '1440p': '2560x1440',
  '4K': '3840x2160',
};
const CLASS_LABEL = { '1080p': 'FHD', '1440p': 'QHD', '4K': 'UHD-4K' };

const OK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="7" fill="#1d7a3c"/>' +
  '<path d="M4.5 8.4 l2.2 2.2 l4.8 -5.2" fill="none" stroke="#fff" stroke-width="1.8"/></svg>';
const NO_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="7" fill="#b3202c"/>' +
  '<path d="M5 5 l6 6 M11 5 l-6 6" fill="none" stroke="#fff" stroke-width="1.8"/></svg>';

const body = document.getElementById('rows');

for (const row of GADGETRON_ROWS) {
  const tr = document.createElement('tr');
  tr.dataset.sku = row.model;
  tr.dataset.stock = row.stock;
  tr.innerHTML =
    `<td><input type="checkbox" aria-label="Select row for comparison"></td>` +
    `<td class="model">${row.model}</td>` +
    `<td class="num">${row.diag}</td>` +
    `<td class="mono">${NATIVE[row.res]}</td>` +
    `<td>${CLASS_LABEL[row.res]}</td>` +
    `<td>IPS</td>` +
    `<td class="num">${row.res === '4K' ? '60' : '144'}</td>` +
    `<td class="num">${row.rating.toFixed(1)}</td>` +
    `<td class="num">${row.reviews.toLocaleString()}</td>` +
    `<td class="stock">${row.stock === 'y' ? OK_ICON : NO_ICON}` +
    `<span class="offscreen">${row.stock === 'y' ? 'In stock' : 'Sold out online'}</span></td>` +
    `<td class="price" data-price="${row.price.toFixed(2)}">${row.price.toFixed(2)}</td>` +
    `<td class="order">` +
    `<span class="stepper"><button type="button" aria-label="Decrease quantity">&minus;</button>` +
    `<input type="text" inputmode="numeric" value="1" aria-label="Quantity">` +
    `<button type="button" aria-label="Increase quantity">+</button></span>` +
    `<button type="button" class="buy"${row.stock === 'y' ? '' : ' disabled'}>` +
    `${row.stock === 'y' ? 'Buy it now' : 'Waitlist'}</button></td>`;
  body.appendChild(tr);
}

document.getElementById('matched').textContent =
  GADGETRON_ROWS.length + ' SKUs matched';
document.getElementById('rowsnote').textContent =
  'Rows 1-' + GADGETRON_ROWS.length + ' of ' + GADGETRON_ROWS.length +
  '. Prices are per unit in USD, excluding tax and recycling levy.';

for (const facet of document.querySelectorAll('[data-facet]')) {
  const [field, value] = facet.dataset.facet.split(':');
  const hits = GADGETRON_ROWS.filter((r) => String(r[field]) === value).length;
  facet.querySelector('.hits').textContent = '(' + hits + ')';
}

const orderCount = document.getElementById('order-count');
let queued = 0;
body.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const stepper = target.closest('.stepper');
  if (stepper) {
    const field = stepper.querySelector('input');
    const next = Number(field.value) + (target.textContent === '+' ? 1 : -1);
    field.value = String(Math.max(1, Math.min(9, next)));
    return;
  }
  if (target.classList.contains('buy')) {
    const qty = Number(target.closest('tr').querySelector('.stepper input').value);
    queued += qty;
    orderCount.textContent = queued + ' queued';
    target.textContent = 'Queued';
  }
});
