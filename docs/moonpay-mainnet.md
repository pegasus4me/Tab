# MoonPay mainnet integration

## What is already wired

- `POST /funding/moonpay/session` creates a short-lived MoonPay Platform session.
- The MoonPay secret remains on the backend. iOS receives only the session token.
- `POST /webhooks/moonpay` validates `Moonpay-Signature-V2` against the raw request body.
- Fiat funding is hard-disabled unless `TAB_NETWORK=monad-mainnet` and `MOONPAY_API_KEY` is configured.

## Mainnet activation checklist

1. Obtain MoonPay production approval and live Platform credentials.
2. Confirm that MoonPay can deliver USDC directly to a Monad wallet for Tab's supported countries. Do not assume this before MoonPay confirms it.
3. Deploy and audit the mainnet Tab factory, then set `TAB_FACTORY_ADDRESS` and `CIRCLE_LIVE_API_KEY`.
4. Add `MOONPAY_API_KEY` and `MOONPAY_WEBHOOK_API_KEY` only to the deployed backend secret store.
5. Configure MoonPay's live webhook URL as `https://<api-domain>/webhooks/moonpay`.
6. Add iOS `WKWebView` MoonPay Connect/Widget frames. It requests a session token from the backend for every app visit and keeps it only in memory.
7. Persist verified MoonPay transaction states in a real database and reconcile completed deliveries against the user's on-chain USDC balance before showing money as available.

## User experience

Tab signup stays Google + `@username`. On the first **Add money**, Tab opens the MoonPay flow. MoonPay—not Tab—collects payment data and presents KYC/SCA when required. The user then explicitly contributes available USDC to a group Tab.

## Important boundary

The MoonPay on-ramp funds a user's embedded wallet; it does not fund a group vault automatically. This deliberate two-step model makes the contribution a user-authorized on-chain action. Merchant fiat payout remains a separate future off-ramp/acquirer integration.
