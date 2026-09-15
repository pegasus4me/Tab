import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Client, type Quote } from "@moonpay/platform-sdk-web";
import { apiRequest, useTreasury } from "./treasury";
import { customerError, money } from "./financial-display";

type Step = "amount" | "connect" | "method" | "review" | "payment" | "status";
type Method = { type: string; id?: string; label: string; requiresWidget?: boolean };
type Intent = { id: string; status: string; receivedAmount?: string; vaultId?: number };
const methodLabels: Record<string, string> = { card: "Card", apple_pay: "Apple Pay", google_pay: "Google Pay", sepa: "Bank transfer", sepa_open_banking: "Online bank transfer", ach: "Bank transfer", fps: "Bank transfer", fps_open_banking: "Online bank transfer", revolut_pay: "Revolut Pay", paypal: "PayPal" };
const disclosureText: Record<string, string> = {
  "us-transaction-finality": "This payment cannot be reversed after it has been completed.",
  "eea-crypto-asset-risk": "The value received through this payment may change and is not protected by deposit insurance.",
  "eea-unregulated-stablecoin-risk": "This payment involves a digital value product that may not have the protections of regulated electronic money.",
  "gateway-token": "This payment uses a third-party digital asset service and carries financial risk.",
};

export function MoonPayFunding({ target, onDone }: { target: string; onDone: () => void }) {
  const treasury = useTreasury();
  const vault = treasury.snapshot?.treasury?.vaults.find(item => item.name === target);
  const [step, setStep] = useState<Step>("amount"); const [amount, setAmount] = useState(""); const [currency, setCurrency] = useState<"USD" | "EUR" | "GBP">("USD");
  const [client, setClient] = useState<Client | null>(null); const [intent, setIntent] = useState<Intent | null>(null); const [methods, setMethods] = useState<Method[]>([]); const [method, setMethod] = useState<Method | null>(null); const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [transactionId, setTransactionId] = useState("");
  const [bankInfo, setBankInfo] = useState<any>(null);
  const frameContainer = useRef<HTMLDivElement>(null); const challengeContainer = useRef<HTMLDivElement>(null); const frames = useRef<{ dispose(): void }[]>([]);
  const feeTotal = useMemo(() => quote ? Object.values(quote.fees as Record<string, { amount?: string } | undefined>).reduce((sum, fee) => sum + Number(fee?.amount ?? 0), 0) : 0, [quote]);
  useEffect(() => () => { frames.current.forEach(frame => frame.dispose()); }, []);
  useEffect(() => {
    if (!intent || !["payment_pending", "allocation_pending"].includes(intent.status)) return;
    const timer = window.setInterval(() => void apiRequest(treasury.apiUrl, `/funding/intents/${intent.id}`).then(data => {
      setIntent(data.intent); if (["completed", "failed", "allocation_pending"].includes(data.intent.status)) setStep("status");
    }).catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [intent?.id, intent?.status, treasury.apiUrl]);
  function clearFrames() { frames.current.forEach(frame => frame.dispose()); frames.current = []; if (frameContainer.current) frameContainer.current.innerHTML = ""; if (challengeContainer.current) challengeContainer.current.innerHTML = ""; }
  async function begin() {
    if (!treasury.snapshot?.family.id || !treasury.snapshot.treasury) return;
    setBusy(true); setError("");
    try {
      const [sessionData, intentData, infrastructure] = await Promise.all([
        apiRequest(treasury.apiUrl, `/families/${treasury.snapshot.family.id}/funding/session`, {}),
        apiRequest(treasury.apiUrl, `/families/${treasury.snapshot.family.id}/funding/intents`, { amount, currency, ...(vault ? { vaultId: vault.id } : {}) }),
        fetch(`${treasury.apiUrl}/infrastructure`).then(response => response.json()),
      ]);
      const moonPay = createClient({ sessionToken: sessionData.sessionToken, theme: { accentColor: "#2B2E97" } as never });
      const assets = await moonPay.getAssets({ code: "USDC" });
      if (!assets.ok) throw new Error("Funding availability could not be checked.");
      const asset = assets.value.data.find(item => item.contractAddress?.toLowerCase() === String(infrastructure.usdcAddress).toLowerCase());
      if (!asset) throw new Error("Add Funds is not available for this treasury yet.");
      sessionStorage.setItem(`ours-funding-asset:${intentData.intent.id}`, asset.source === "defi" ? asset.caip19 : asset.code);
      setIntent(intentData.intent); setClient(moonPay); setStep("connect");
      await connectCustomer(moonPay);
    } catch (reason) { setError(customerError(reason)); }
    finally { setBusy(false); }
  }
  async function connectCustomer(moonPay: Client) {
    const connection = await moonPay.getConnection(); if (!connection.ok) throw new Error("Secure payment setup could not start.");
    if (connection.value.status === "active") { await loadMethods(moonPay); return; }
    if (connection.value.status !== "connectionRequired") throw new Error(connection.value.status === "pending" ? "Your payment profile is still being reviewed." : "Add Funds is unavailable for this account.");
    if (!frameContainer.current) { window.setTimeout(() => void connectCustomer(moonPay), 0); return; }
    clearFrames(); const result = await moonPay.connect({ container: frameContainer.current, presentation: "bare", onEvent: event => {
      if (event.kind === "complete") void loadMethods(moonPay); else if (event.kind === "error") setError("Secure payment setup failed.");
    }}); if (!result.ok) throw new Error("Secure payment setup failed."); frames.current.push(result.value);
  }
  async function loadMethods(moonPay: Client) {
    clearFrames(); const result = await moonPay.getPaymentMethods(); if (!result.ok) { setError("Payment methods could not be loaded."); return; }
    const configs = result.value.data.paymentMethodConfigs ?? []; const stored = result.value.data.paymentMethods ?? [];
    const available: Method[] = configs.filter(item => item.availability.active && item.capabilities.supportedCurrencies.includes(currency)).flatMap(item => {
      if (item.type === "card") { const cards = stored.filter(card => card.type === "card") as any[]; return cards.length ? cards.map(card => ({ type: "card", id: card.id, label: `${card.brand ?? "Card"} •••• ${card.last4 ?? ""}` })) : [{ type: "card", label: "Add a card" }]; }
      return methodLabels[item.type] ? [{ type: item.type, label: methodLabels[item.type], requiresWidget: item.capabilities.requiresWidget }] : [];
    });
    setMethods(available); setStep("method");
  }
  async function selectMethod(selected: Method) {
    if (!client || !intent) return; setBusy(true); setError(""); setMethod(selected);
    try {
      if (selected.type === "card" && !selected.id) {
        setStep("payment"); window.setTimeout(async () => {
          if (!frameContainer.current) return; const result = await client.setupAddCard({ container: frameContainer.current, presentation: "bare", onEvent: event => {
            if (event.kind === "complete") void selectMethod({ type: "card", id: event.payload.card.id, label: `${event.payload.card.brand} •••• ${event.payload.card.last4}` });
            if (event.kind === "error") setError(event.payload.message ?? "The card could not be added.");
          }}); if (result.ok) frames.current.push(result.value); else setError(result.error.message);
        }, 0); return;
      }
      const asset = sessionStorage.getItem(`ours-funding-asset:${intent.id}`); if (!asset) throw new Error("Funding setup expired. Start again.");
      const quoteResult = await client.getQuote({ source: { asset: { code: currency }, amount }, destination: { asset: asset.startsWith("eip155:") ? { caip19: asset } : { code: asset } }, wallet: { address: treasury.snapshot!.treasury!.address }, paymentMethod: { type: selected.type as never, ...(selected.id ? { id: selected.id } : {}) }, feeBehavior: "inclusive" } as never);
      if (!quoteResult.ok || !quoteResult.value.data.executable) throw new Error("A final quote is not available for this payment method.");
      const nextQuote = quoteResult.value.data;
      const feeAmount = Object.values(nextQuote.fees as Record<string, { amount?: string } | undefined>).reduce((sum, fee) => sum + Number(fee?.amount ?? 0), 0);
      const persisted = await apiRequest(treasury.apiUrl, `/funding/intents/${intent.id}/quote`, { sourceAmount: nextQuote.source.amount, destinationAmount: nextQuote.destination.amount, feeAmount: String(feeAmount), exchangeRate: String(nextQuote.exchangeRate), ...(nextQuote.expiresAt ? { expiresAt: nextQuote.expiresAt } : {}), paymentMethod: selected.type });
      setIntent(persisted.intent); setQuote(nextQuote); setStep("review");
    } catch (reason) { setError(customerError(reason)); }
    finally { setBusy(false); }
  }
  async function attachTransaction(transaction: any) {
    if (!intent || !transaction?.id || !method) return; setTransactionId(transaction.id);
    const data = await apiRequest(treasury.apiUrl, `/funding/intents/${intent.id}/transaction`, { transactionId: transaction.id, paymentMethod: method.type }); setIntent(data.intent);
    if (["sepa", "sepa_open_banking", "ach", "fps", "fps_open_banking"].includes(method.type) && client) {
      const details = await client.getTransaction(transaction.id); if (details.ok) setBankInfo(details.value.data.bankTransferDepositInfo ?? null);
    }
    setStep("status");
  }
  async function mountChallenge(url: string) {
    if (!client || !challengeContainer.current) return; const result = await client.setupChallenge({ url, container: challengeContainer.current, presentation: "bare", onEvent: event => { if (event.kind === "error") setError(event.payload.message); } }); if (result.ok) frames.current.push(result.value);
  }
  async function pay() {
    if (!client || !quote || !method || !intent) return;
    if (quote.expiresAt && Date.now() >= new Date(quote.expiresAt).getTime()) { setError("That quote expired. We refreshed it for you."); await selectMethod(method); return; }
    setStep("payment"); setError(""); clearFrames();
    window.setTimeout(async () => {
      if (!frameContainer.current) return;
      const onEvent = (event: any) => { if (event.kind === "complete" || event.kind === "transactionCreated") void attachTransaction(event.payload.transaction); else if (event.kind === "challenge") void mountChallenge(event.payload.url); else if (event.kind === "cancel" || event.kind === "cancelled") { setStep("review"); setError("Payment cancelled. No funds were added."); } else if (event.kind === "error") { setStep("status"); setIntent(current => current ? { ...current, status: "failed" } : current); setError(event.payload.message ?? "Payment could not be completed."); } };
      const options = { quote: quote.signature, container: frameContainer.current, externalTransactionId: intent.id, presentation: "bare" as const, onEvent };
      const result = method.type === "apple_pay" ? await client.setupApplePay(options) : method.type === "google_pay" ? await client.setupGooglePay(options) : method.type === "card" ? await client.setupBuy(options) : await client.setupWidget(options);
      if (!result.ok) setError(result.error.message); else frames.current.push(result.value);
    }, 0);
  }
  if (step === "amount") return <form className="funding-flow" onSubmit={event => { event.preventDefault(); void begin(); }}><p className="eyebrow">Add funds</p><h2>Add money to {target.toLowerCase()}</h2><label className="cfo-name">Amount<div className="funding-amount"><select value={currency} onChange={event => setCurrency(event.target.value as typeof currency)}><option>USD</option><option>EUR</option><option>GBP</option></select><input autoFocus inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} pattern="[0-9]+(\.[0-9]{1,2})?" placeholder="100" required /></div></label><button className="cfo-action" disabled={busy}>{busy ? "Preparing…" : "Continue"}</button>{error && <p className="auth-error" role="alert">{error}</p>}</form>;
  return <div className="funding-flow"><p className="eyebrow">Add funds · {target}</p>{step === "connect" && <><h2>Secure payment setup</h2><p>Confirm your details to see available payment methods.</p></>}{step === "method" && <><h2>How would you like to pay?</h2><div className="funding-methods">{methods.map((item, index) => <button key={`${item.type}-${item.id ?? index}`} onClick={() => void selectMethod(item)}><strong>{item.label}</strong><span>Continue securely</span></button>)}</div>{methods.length === 0 && <p>No payment method is available for this amount and currency.</p>}</>}{step === "review" && quote && <><h2>Review your payment</h2><dl className="funding-quote"><div><dt>You pay</dt><dd>{money(Number(quote.source.amount))} {currency}</dd></div><div><dt>Fees included</dt><dd>{money(feeTotal)}</dd></div><div><dt>Added to Ours</dt><dd>{money(Number(quote.destination.amount))}</dd></div><div><dt>Estimated rate</dt><dd>{Number(quote.exchangeRate).toFixed(4)}</dd></div><div><dt>Estimated arrival</dt><dd>{method?.type.includes("bank") || ["ach", "sepa", "fps"].includes(method?.type ?? "") ? "Usually 1–3 business days" : "Usually within minutes"}</dd></div></dl>{quote.paymentDisclosures.map(item => <p className="funding-disclosure" key={`${item.id}-${item.version}`}>{disclosureText[item.id] ?? "This payment involves financial risk. Review the provider terms before continuing."}</p>)}<button className="cfo-action" onClick={() => void pay()}>Confirm and pay</button><button className="auth-link" onClick={() => setStep("method")}>Choose another method</button></>}{step === "payment" && <><h2>Complete your payment</h2><p>Follow the secure step below. Keep this screen open.</p></>}{step === "status" && <><h2>{intent?.status === "completed" ? "Funds added" : intent?.status === "failed" ? "Payment unsuccessful" : intent?.status === "allocation_pending" ? "Funds received" : "Payment pending"}</h2><p>{intent?.status === "completed" ? `Your ${target.toLowerCase()} is up to date.` : intent?.status === "failed" ? "No funds were added. You can safely try again." : intent?.status === "allocation_pending" ? `${money(Number(intent.receivedAmount))} is ready for your approval.` : "We’ll update this screen when your payment arrives."}</p>{intent?.status === "allocation_pending" && <button className="cfo-action" disabled={treasury.busy} onClick={() => void treasury.allocateFunding(intent.id).then(onDone).catch(reason => setError(customerError(reason)))}>{treasury.busy ? "Approving…" : `Approve allocation to ${target}`}</button>}{intent?.status === "completed" && <button className="cfo-action" onClick={onDone}>Done</button>}{intent?.status === "failed" && <button className="cfo-action" onClick={() => { setIntent(null); setQuote(null); setMethod(null); setError(""); setStep("amount"); }}>Try again</button>}{bankInfo && intent?.status === "payment_pending" && <dl className="funding-quote"><div><dt>Recipient</dt><dd>{bankInfo.recipientName}</dd></div>{bankInfo.iban && <div><dt>IBAN</dt><dd>{bankInfo.iban}</dd></div>}{bankInfo.bic && <div><dt>BIC</dt><dd>{bankInfo.bic}</dd></div>}<div><dt>Payment reference</dt><dd>{bankInfo.reference}</dd></div></dl>}{transactionId && intent?.status === "payment_pending" && <button className="auth-link" onClick={() => void apiRequest(treasury.apiUrl, `/funding/intents/${intent.id}`).then(data => setIntent(data.intent))}>Refresh status</button>}</>}
    <div className="moonpay-frame" ref={frameContainer} /><div className="moonpay-challenge" ref={challengeContainer} />{error && <p className="auth-error" role="alert">{error}</p>}</div>;
}
