'use strict';
// The payment provider's test environment: its host, its checkout address and the ids of the two
// test products. Only an extension development host and the unit tests use it (see
// src/licence/config.js and src/extension.js). This file is left out of the packaged extension
// (.vscodeignore), so an installed copy has no way to reach the test environment.

module.exports = {
  apiBase: 'https://test.dodopayments.com',
  checkoutBase: 'https://test.checkout.dodopayments.com/buy/',
  products: { personal: 'pdt_0NrlxeSBTdTtqoEETYSA9', business: 'pdt_0Nrlxki6gEaKTaeak6bMN' }
};
