// Ground truth for the simulated pages in eval/pages/.
// Deliberately kept OUT of the pages themselves so agents can't cheat by
// reading page source. If you edit a page, keep this in sync by hand.

export const ANSWERS = {
  // pages/basic/*.html — smoke-test pages.
  basic: {
    title: 'Zephyr Quartz 8412',
    revealCode: 'FLUX-93',
    greeting: 'Hello, Marmalade',
  },

  // pages/gridword/index.html — ?day=N indexes the (encoded) answer list.
  gridword: { day0Word: 'CRISP' },

  // pages/shop/*/index.html — cheapest IN-STOCK 27" 4K per store.
  priceCompare: {
    overall: { store: 'NexBuy', product: 'ClaritySee CS27-4K', price: '274.50' },
    perStore: { voltro: 289.99, nexbuy: 274.5, gadgetron: 302.99 },
  },

  // pages/forms/index.html — reference code shown on the review step.
  form: { refCode: 'MD-4921' },

  // pages/gov/rv7.html; schedule-widget.html (iframe); handbook.html section 22.
  gov: {
    deadline: 'June 12',
    instructionsPath: 'rv7-instructions',
    harborviewThursday: '10:00 am – 6:30 pm',
    handbookRetention: '7 years',
  },

  // pages/shadow/index.html — success message is server-issued (server.mjs).
  shadow: { code: 'ORCHID-22', message: 'Metronome stage two is clear' },

  // pages/flaky/index.html — revenue served after 2 failed attempts (server.mjs).
  flaky: { revenue: '$1,284,550' },

  // pages/news/ ground truth lives in pages/news/items.json (the page must
  // render it, so it is page content rather than an answer key).
};
