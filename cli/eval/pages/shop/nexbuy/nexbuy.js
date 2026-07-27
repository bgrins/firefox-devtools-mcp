// NexBuy big-box catalogue: one horizontal result row per SKU, revealed in
// batches of PAGE_SIZE by the "Load more results" control.

const PAGE_SIZE = 15;
const RESOLUTION = {
  '1080p': 'Full HD 1920 x 1080',
  '1440p': 'Quad HD 2560 x 1440',
  '4K': '4K Ultra HD 3840 x 2160',
};

const results = document.getElementById('results');
const moreButton = document.getElementById('more-results');
const moreNote = document.getElementById('more-note');
const tally = document.getElementById('tally');
let shown = 0;

function priceMarkup(price) {
  const [whole, frac] = price.toFixed(2).split('.');
  return (
    `<span class="cur">$</span><span class="whole">${whole}</span>` +
    `<span class="frac">${frac}</span>`
  );
}

function rowMarkup(item) {
  const ready = item.availability === 'ships';
  const hue = (item.title.length * 29 + item.title.charCodeAt(0) * 7) % 360;
  return (
    `<div class="shot">
      <svg viewBox="0 0 132 74" role="img" aria-label="Product image, ${item.title}">
        <rect width="132" height="74" fill="hsl(${hue},22%,93%)"/>
        <rect x="14" y="6" width="104" height="54" rx="2" fill="#20242c"/>
        <rect x="58" y="60" width="16" height="6" fill="#8a8f99"/>
        <rect x="44" y="66" width="44" height="4" fill="#b3b8c2"/>
      </svg>
    </div>
    <div class="info">
      <h2 class="title"><a href="#">${item.title}</a></h2>
      <p class="attrs">SKU ${item.sku} &middot; ${item.screen}" diagonal &middot; ${
        RESOLUTION[item.res]
      } &middot; IPS &middot; ${item.res === '4K' ? '60 Hz' : '165 Hz'}</p>
      <p class="stars"><span class="score">${item.rating} out of 5</span> (${item.reviews.toLocaleString()} customer reviews)</p>
      <p class="fulfil${ready ? '' : ' none'}">${
        ready
          ? 'Ships free to your address &middot; Store pickup: check nearby stores'
          : 'Not eligible for shipping or pickup'
      }</p>
    </div>
    <div class="buybox">
      <div class="pricetag">${priceMarkup(item.price)}</div>
      <span class="sr">Price $${item.price.toFixed(2)} each</span>
      <p class="avail ${ready ? 'ready' : 'gone'}">${ready ? 'Available to ship' : 'Sold out'}</p>
      ${
        ready
          ? '<a class="basket" href="#">Add to basket</a>'
          : '<a class="basket off" href="#">Notify me when available</a>'
      }
      <a class="compare-link" href="#">Add to compare</a>
    </div>`
  );
}

function renderBatch() {
  const slice = NEXBUY_FEED.slice(shown, shown + PAGE_SIZE);
  for (const item of slice) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.sku = item.sku;
    li.innerHTML = rowMarkup(item);
    results.appendChild(li);
  }
  shown += slice.length;
  const left = NEXBUY_FEED.length - shown;
  tally.textContent =
    `Showing ${shown} of ${NEXBUY_FEED.length} items in Monitors. ` +
    `Prices and availability are for the Riverside store.`;
  if (left > 0) {
    moreButton.textContent = 'Load more results';
    moreNote.textContent = `${left} more item${left === 1 ? '' : 's'} not yet loaded.`;
  } else {
    moreButton.remove();
    moreNote.textContent = 'End of results for Monitors.';
  }
}

moreButton.addEventListener('click', renderBatch);
renderBatch();
