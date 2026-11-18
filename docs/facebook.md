# Automatic Facebook posts

When a producer is approved for the first time, or an approved producer adds an offer, the app posts to the Roots & Pantry Facebook page with a link straight to the producer (or to that offer on their page). Code: `app/src/facebook.js`.

- **Held for an hour** first. Admin → Facebook shows what's waiting, with the exact text, and lets you **Cancel** or **Post now**.
- The text is written when it's posted, so edits made during the hour are used. Anything paused, ended or no longer live by then is skipped.
- **Never posted:** exclusive deals (families can't claim them until the family app opens), anything marked as alcohol, codes, phone numbers, emails, full postcodes.
- Offers that start in the future are posted on their start date.
- Posts go out at half past each hour (the hourly cron), up to 5 a run. The 08:30 UTC run does the backup instead, so posts due then go at 09:30.
- If a post fails, hello@ gets an email and the row shows "Failed" with "Try posting again".
- The test app (`FB_AUTOPOST` = `off`) never posts. It records "Not posted" with the text it would have used.

## Settings

| Name | Where | Value |
|---|---|---|
| `FB_AUTOPOST` | `wrangler.jsonc` | `on` live, `off` test |
| `FB_PAGE_ID` | `wrangler.jsonc` | the page's ID (`61596356653557`; check in step 6) |
| `FB_PAGE_TOKEN` | Cloudflare secret, **live Worker `rp-app` only** | the page access token from step 6 |

Until `FB_PAGE_TOKEN` is set, the live app records "Not posted" too. Those can be sent afterwards with "Try posting again".

## One-off setup (Jason)

Use the Facebook account that manages the Roots & Pantry page. Never paste a token into a chat or an email.

1. Go to **developers.facebook.com** and log in. If asked, register as a developer (it's free).
2. **My Apps → Create app.** Name: `Roots & Pantry posts`. Contact email: hello@rootsandpantry.co.uk. Use case: **Manage everything on your Page**. Skip connecting a business portfolio.
3. In the app, open the use case → **Customise** → make sure **pages_manage_posts**, **pages_read_engagement** and **pages_show_list** are added.
4. **Tools → Graph API Explorer.** Choose your new app. Under **User or Page**, choose **Get User Access Token**, tick the three permissions above, click **Generate Access Token**, and allow it for the **Roots & Pantry** page only.
5. **Tools → Access Token Debugger.** Paste that token, click **Debug**, then **Extend Access Token** at the bottom. Copy the new long-lived token.
6. Back in **Graph API Explorer**, paste the long-lived token into the token box and run `me/accounts`. Find Roots & Pantry in the answer:
   - its `access_token` is the **page token**. Copy it.
   - its `id` is the page ID. If it isn't `61596356653557`, tell Claude the ID (it isn't secret).
   - Optional check: paste the page token into the Access Token Debugger. "Expires" should say **Never**.
7. **Cloudflare → Workers & Pages → rp-app → Settings → Variables and Secrets → Add.** Type: **Secret**. Name: `FB_PAGE_TOKEN`. Value: the page token. **Deploy.**
8. Test it: in Admin → Facebook on the live app, click **Try posting again** on a row (or wait for the next new offer). Then check the post from a phone or browser **not** logged in as you. If only you can see it, the Meta app needs to be switched to **Live**: App settings → Basic → Privacy policy URL `https://rootsandpantry.co.uk/privacy-and-terms/`, category "Business and pages", then switch **App mode** to **Live**. Posting to your own page doesn't need App Review.

## If it stops working

The page token stops working if you change your Facebook password, lose admin of the page, or remove the app. hello@ will get "Facebook post failed … token". Repeat steps 4 to 7 and update `FB_PAGE_TOKEN`, then use **Try posting again**.

If the token ever leaks: Facebook → the R&P page → Settings → Business integrations → remove the app, then repeat the setup.

## Graph API version

`FB_GRAPH` in `facebook.js` is `v26.0` (latest in Nov 2026). Meta supports each version for about two years; bump it before it expires.
