# Licence, trial and Pro

## Free

Everything that is not marked "(Pro)" is free, for personal and commercial use, with no key, no account and no network connection: outline, hover, go to definition, find references, the path at the cursor, problems, Create Sample XML, the samples, the walkthrough and Report A Problem. Free features will not be moved behind the key later.

## Trial

The first Pro command you run starts a free 14-day trial of every Pro feature on this computer. The trial is recorded only in the editor's storage on this computer (start time, last use, last reminder); nothing is sent anywhere and no key or account is needed. **XSD Atlas: Show Licence Status** shows the days left; a reminder appears at most once a day. When the trial ends, the free features keep working and the next Pro command offers **Buy Pro** and **Enter Licence Key**.

## Pro licences

| Licence | Price (one-time) | For | Keys and computers |
| --- | --- | --- | --- |
| Pro Personal | USD 29 | one person who pays for it; use at work is allowed | one key, up to 3 computers of that person |
| Pro Business | USD 59 per user | companies and other organisations | one key per user (a purchase for N users gives N keys), each for up to 3 computers |

The checkout page shows the final price and any taxes for your country before you pay. **XSD Atlas: Buy Pro** asks which licence you want; for Business it asks "How many users? (1-100)" and opens the checkout for that number of keys. Payments, invoices and refunds are handled by Dodo Payments, the merchant of record; tick "Purchasing as a business" at the checkout to add a company name and tax ID to the invoice.

## Activating a key

1. The key arrives by e-mail from the payment provider right after the purchase.
2. Run **XSD Atlas: Enter Licence Key** and paste it.
3. The key is checked once with the licence service and stored in the editor's secret storage (the operating system's credential store where available).

Entering the key that is already active on this computer again does not use another activation: the service is asked whether it is valid, and that is all. Entering a different key replaces the stored one; the activation of the old key is given back as soon as the new key is accepted, so the old key does not stay in use on this computer.

What can go wrong, and what the message says:

| Message | Meaning and next step |
| --- | --- |
| not recognised | The key is unknown. Copy it again from the e-mail. |
| already active on the maximum number of computers | All 3 activations are used. Run **Remove Licence From This Machine** on one of them. |
| not active | The key exists but is disabled, expired or refunded. |
| belongs to another product | The key is for a different product. The activation made for the check is given back; if the service cannot confirm that, the message says so and you can contact support. |
| could not be reached | No connection to `live.dodopayments.com` (check proxy and firewall). |
| could not be saved in the secret storage | No credential store is available (on Linux: start GNOME Keyring or KWallet). The activation made for the check is given back; if the service cannot confirm that, the message says so. |

## Offline use

A valid key is checked with the licence service at most once every 24 hours, when a Pro feature is used. If the service cannot be reached, the last successful check keeps Pro working for 14 days; **Show Licence Status** says until when. Without a key the extension makes no network request at all.

## Moving a key

Run **XSD Atlas: Remove Licence From This Machine** on the old computer (this frees one activation), then **Enter Licence Key** on the new one. A Business key can be passed on to a colleague the same way. If the old computer is gone, open an issue and ask for help with your licence (never post the key itself).

## Lost key

Search the mailbox you used at checkout, including spam, for "Dodo Payments" or "XSD Atlas". Your purchases are also listed in the payment provider's customer portal.
