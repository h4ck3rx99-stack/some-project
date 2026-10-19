# Return policy is declared

`hasMerchantReturnPolicy` on the offer, or on your Organization, lets agents tell shoppers how returns work.

## How to fix

Add a `MerchantReturnPolicy` (applicable country, return window, method, fees) once on your Organization markup, or on each Offer.

## WooCommerce

Use your SEO plugin's organization/return policy settings; otherwise add Organization JSON-LD with `hasMerchantReturnPolicy` site-wide.

## How to verify

Validate the homepage or a product page and look for `MerchantReturnPolicy`.

## Spec reference

Google Search Central “Merchant return policy” structured data.
